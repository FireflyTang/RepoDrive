'use strict';

const { net } = require('electron');
const { normalizeRepoPath } = require('./validation');

class GitHubError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

class GitHubService {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  async request(path, options = {}) {
    const config = this.getConfig();
    const headers = {
      Accept: options.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'RepoDrive/0.7',
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(options.headers || {})
    };
    let response;
    try {
      response = await net.fetch(`https://api.github.com${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new GitHubError(timedOut ? 'GitHub 请求超过 30 秒，请检查系统网络或代理设置' : '无法连接 GitHub，请检查系统网络或代理设置');
    }
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).message || ''; } catch { detail = await response.text(); }
      const hints = { 401: 'Token 无效或已过期', 403: '没有权限或已触发 GitHub 限制', 404: '找不到代码仓、分支或路径', 409: '代码仓为空或文件冲突', 422: '提交内容不符合 GitHub 要求' };
      throw new GitHubError(hints[response.status] || detail || `GitHub 请求失败 (${response.status})`, response.status);
    }
    if (options.raw) return Buffer.from(await response.arrayBuffer());
    if (response.status === 204) return null;
    return response.json();
  }

  repoPrefix(config = this.getConfig()) {
    return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  }

  async validateRepository() {
    const c = this.getConfig();
    const repo = await this.request(this.repoPrefix(c));
    await this.request(`${this.repoPrefix(c)}/branches/${encodeURIComponent(c.branch)}`);
    return { fullName: repo.full_name, private: repo.private, permissions: repo.permissions || {}, defaultBranch: repo.default_branch };
  }

  async list(path = '') {
    const c = this.getConfig();
    const clean = normalizeRepoPath(path);
    const suffix = clean ? `/${clean.split('/').map(encodeURIComponent).join('/')}` : '';
    const result = await this.request(`${this.repoPrefix(c)}/contents${suffix}?ref=${encodeURIComponent(c.branch)}`);
    const rows = Array.isArray(result) ? result : [result];
    return rows.map(({ name, path: itemPath, type, size, sha, download_url }) => ({ name, path: itemPath, type, size, sha, downloadUrl: download_url }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  async downloadFile(repoPath) {
    const c = this.getConfig();
    const clean = normalizeRepoPath(repoPath);
    const encoded = clean.split('/').map(encodeURIComponent).join('/');
    return this.request(`${this.repoPrefix(c)}/contents/${encoded}?ref=${encodeURIComponent(c.branch)}`, {
      accept: 'application/vnd.github.raw+json', raw: true
    });
  }

  async uploadFile(repoPath, bytes, message) {
    const c = this.getConfig();
    const clean = normalizeRepoPath(repoPath);
    const encoded = clean.split('/').map(encodeURIComponent).join('/');
    let sha;
    try {
      const existing = await this.request(`${this.repoPrefix(c)}/contents/${encoded}?ref=${encodeURIComponent(c.branch)}`);
      if (existing.type === 'file') sha = existing.sha;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    return this.request(`${this.repoPrefix(c)}/contents/${encoded}`, {
      method: 'PUT',
      body: {
        message: message || `Upload ${clean} via RepoDrive`,
        content: Buffer.from(bytes).toString('base64'),
        branch: c.branch,
        ...(sha ? { sha } : {})
      }
    });
  }

  async deleteFile(repoPath, sha, message) {
    const c = this.getConfig();
    const clean = normalizeRepoPath(repoPath);
    const encoded = clean.split('/').map(encodeURIComponent).join('/');
    return this.request(`${this.repoPrefix(c)}/contents/${encoded}`, {
      method: 'DELETE',
      body: {
        message: message || `Delete ${clean} via RepoDrive`,
        sha,
        branch: c.branch
      }
    });
  }

  async branchHead() {
    const c = this.getConfig();
    const branchRef = c.branch.split('/').map(encodeURIComponent).join('/');
    const ref = await this.request(`${this.repoPrefix(c)}/git/ref/heads/${branchRef}`);
    const commit = await this.request(`${this.repoPrefix(c)}/git/commits/${encodeURIComponent(ref.object.sha)}`);
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
  }

  async commitChanges(changes, message, onProgress) {
    const c = this.getConfig();
    if (!Array.isArray(changes) || !changes.length) throw new Error('没有需要提交的文件变更。');
    const seen = new Set();
    const normalized = changes.map((change) => {
      const clean = normalizeRepoPath(change.path);
      if (!clean) throw new Error('不能直接替换代码仓根目录。');
      if (seen.has(clean)) throw new Error(`同一次操作中存在重复路径：${clean}`);
      seen.add(clean);
      return { ...change, path: clean };
    });
    const head = await this.branchHead();
    const tree = [];
    let completed = 0;
    for (const change of normalized) {
      if (change.delete) tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
      else {
        const blob = await this.request(`${this.repoPrefix(c)}/git/blobs`, {
          method: 'POST',
          body: { content: Buffer.from(change.bytes).toString('base64'), encoding: 'base64' }
        });
        tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      completed += 1;
      onProgress?.({ completed, total: normalized.length, current: change.path });
    }
    const nextTree = await this.request(`${this.repoPrefix(c)}/git/trees`, {
      method: 'POST', body: { base_tree: head.treeSha, tree }
    });
    const commit = await this.request(`${this.repoPrefix(c)}/git/commits`, {
      method: 'POST', body: { message, tree: nextTree.sha, parents: [head.commitSha] }
    });
    const branchRef = c.branch.split('/').map(encodeURIComponent).join('/');
    await this.request(`${this.repoPrefix(c)}/git/refs/heads/${branchRef}`, {
      method: 'PATCH', body: { sha: commit.sha, force: false }
    });
    return { commitSha: commit.sha, changed: normalized.length };
  }

  async clearBranchHistory(message = 'Reset history via RepoDrive') {
    const c = this.getConfig();
    const head = await this.branchHead();
    const commit = await this.request(`${this.repoPrefix(c)}/git/commits`, {
      method: 'POST', body: { message, tree: head.treeSha, parents: [] }
    });
    const branchRef = c.branch.split('/').map(encodeURIComponent).join('/');
    await this.request(`${this.repoPrefix(c)}/git/refs/heads/${branchRef}`, {
      method: 'PATCH', body: { sha: commit.sha, force: true }
    });
    return { previousCommitSha: head.commitSha, commitSha: commit.sha };
  }
}

module.exports = { GitHubService, GitHubError };
