'use strict';

const { normalizeRepoPath } = require('./validation');

// No content creation: only remove existing tree entries, or reuse the current
// tree in a parentless commit. Kept separate from macOS upload implementation.
class RepositoryMaintenance {
  constructor(service, config) {
    this.service = service;
    this.config = { ...config };
    this.prefix = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
    this.branch = config.branch.split('/').map(encodeURIComponent).join('/');
  }
  request(path, options) { return this.service.request(`${this.prefix}${path}`, options); }
  async head() {
    const ref = await this.request(`/git/ref/heads/${this.branch}`);
    const commit = await this.request(`/git/commits/${ref.object.sha}`);
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
  }
  async unchanged(head) {
    const ref = await this.request(`/git/ref/heads/${this.branch}`);
    if (ref.object.sha !== head.commitSha) throw new Error('分支在确认期间发生变化，操作已停止。请刷新后重试。');
  }
  async finish(head, treeSha, reset) {
    await this.unchanged(head);
    const commit = await this.request('/git/commits', { method: 'POST', body: {
      message: reset ? 'Reset branch history via RepoDrive' : 'Clear file drive via RepoDrive',
      tree: treeSha, parents: reset ? [] : [head.commitSha]
    } });
    await this.unchanged(head);
    await this.request(`/git/refs/heads/${this.branch}`, { method: 'PATCH', body: { sha: commit.sha, force: reset } });
    return { previousCommitSha: head.commitSha, commitSha: commit.sha };
  }
  async clearHistory(head) { return this.finish(head, head.treeSha, true); }
  async clearFiles(head) {
    const scope = normalizeRepoPath(this.config.rootPath);
    let treeSha = head.treeSha;
    for (const segment of scope.split('/').filter(Boolean)) {
      const tree = await this.request(`/git/trees/${treeSha}`);
      if (tree.truncated) throw new Error('目录列表不完整，已停止清空操作。');
      const entry = tree.tree.find((item) => item.path === segment);
      if (!entry) return { unchanged: true };
      if (entry.type !== 'tree') throw new Error('配置的根目录不是文件夹。');
      treeSha = entry.sha;
    }
    const tree = await this.request(`/git/trees/${treeSha}`);
    if (tree.truncated) throw new Error('目录列表不完整，已停止清空操作。');
    if (!tree.tree.length) return { unchanged: true };
    const deletions = tree.tree.map(({ path, mode, type }) => ({ path: [scope, path].filter(Boolean).join('/'), mode, type, sha: null }));
    await this.unchanged(head);
    const empty = await this.request('/git/trees', { method: 'POST', body: { base_tree: head.treeSha, tree: deletions } });
    return this.finish(head, empty.sha, false);
  }
}

function registerMaintenance({ ipcMain, dialog, getWindow, getConfig, createService }) {
  let busy = false;
  for (const [channel, reset] of [['repo:clearFiles', false], ['repo:clearHistory', true]]) {
    ipcMain.handle(channel, async (_event, repositoryConfirmation) => {
      if (busy) throw new Error('已有清理操作正在执行，请稍候。');
      const config = { ...getConfig() };
      const repository = `${config.owner}/${config.repo}`;
      if (!config.owner || !config.repo || repositoryConfirmation !== repository) throw new Error('请输入已保存的完整代码仓名称以确认。');
      if (!config.token) throw new Error('操作需要 GitHub 仓库写权限，请先登录或配置 Token。');
      busy = true;
      try {
        const maintenance = new RepositoryMaintenance(createService(config), config);
        const head = await maintenance.head();
        const scope = config.rootPath ? `目录 ${config.rootPath} 下的全部内容（保留目录外文件）` : '当前分支的全部文件和目录';
        const confirmation = await dialog.showMessageBox(getWindow(), {
          type: 'warning', buttons: ['取消', reset ? '清除历史' : '清空全部文件'], defaultId: 0, cancelId: 0,
          title: '最后确认', message: `${repository} · 分支 ${config.branch}`,
          detail: reset
            ? '保留当前文件，force push 将整个分支重写为一个根提交（不受根目录设置限制）。请暂停其他人的推送；受保护分支可能拒绝。其他分支、标签、PR 仍可能引用旧对象，GitHub 不保证立即回收空间。历史清除后，原上传时间也无法恢复。'
            : `将删除${scope}，产生一次普通提交。旧历史仍占用空间；如需清理历史，可再执行“清除历史”。`
        });
        if (confirmation.response !== 1) return { canceled: true };
        const current = getConfig();
        if (['owner', 'repo', 'branch', 'rootPath'].some((key) => current[key] !== config[key])) throw new Error('连接设置已变化，请重新确认。');
        return { canceled: false, ...(reset ? await maintenance.clearHistory(head) : await maintenance.clearFiles(head)) };
      } finally { busy = false; }
    });
  }
}
module.exports = { RepositoryMaintenance, registerMaintenance };
