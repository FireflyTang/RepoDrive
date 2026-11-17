'use strict';

const { net, session } = require('electron');
const { normalizeRepoPath } = require('./validation');
const { uploadRequest, uploadCanceledError, httpErrorMessage } = require('./upload-request');

function checkCanceled(signal) {
  if (signal?.aborted) throw uploadCanceledError();
}

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
    checkCanceled(options.signal);
    const config = this.getConfig();
    const headers = {
      Accept: options.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'RepoDrive/0.7',
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(options.headers || {})
    };
    if (options.method === 'POST' && path.endsWith('/git/blobs')) {
      try {
        return await uploadRequest(net, `https://api.github.com${path}`, {
          body: JSON.stringify(options.body),
          headers: { 'Content-Type': 'application/json', ...headers },
          session: session?.defaultSession,
          signal: options.signal,
          onUploadProgress: options.onUploadProgress
        });
      } catch (error) {
        if (error.code === 'UPLOAD_CANCELED') throw error;
        throw Object.assign(new GitHubError(error.message, error.status), { code: error.code });
      }
    }
    let response;
    try {
      const timeoutSignal = options.timeoutMs === 0 ? undefined : AbortSignal.timeout(options.timeoutMs ?? 30000);
      const signal = options.signal && timeoutSignal ? AbortSignal.any([options.signal, timeoutSignal]) : options.signal || timeoutSignal;
      response = await net.fetch(`https://api.github.com${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store',
        signal
      });
    } catch (error) {
      if (options.signal?.aborted || (options.timeoutMs === 0 && error?.name === 'AbortError')) throw uploadCanceledError();
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new GitHubError(timedOut ? `GitHub 请求超过 ${(options.timeoutMs ?? 30000) / 1000} 秒，请检查系统网络或代理设置` : '无法连接 GitHub，请检查系统网络或代理设置');
    }
    if (!response.ok) {
      let detail = '';
      try { detail = response.text ? await response.text() : await response.json(); } catch { /* Retain the HTTP status if the body is unavailable. */ }
      checkCanceled(options.signal);
      throw new GitHubError(httpErrorMessage(response.status, detail), response.status);
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

  async listRecent(remotePath = '') { return require('./file-history').listByRecentCommit(this, remotePath); }
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

  async branchHead(options = {}) {
    const c = this.getConfig();
    const branchRef = c.branch.split('/').map(encodeURIComponent).join('/');
    const ref = await this.request(`${this.repoPrefix(c)}/git/ref/heads/${branchRef}`, options);
    checkCanceled(options.signal);
    const commit = await this.request(`${this.repoPrefix(c)}/git/commits/${encodeURIComponent(ref.object.sha)}`, options);
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
  }

  async commitChanges(changes, message, onProgress, options = {}) {
    const requestOptions = { signal: options.signal, timeoutMs: 0 };
    checkCanceled(options.signal);
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
    if (normalized.some((change) => !change.delete &&
      (Buffer.isBuffer(change.bytes) ? change.bytes.length : Buffer.from(change.bytes).length) >= 20 * 1024 * 1024)) {
      return require('./git-upload').commitViaGit(c, normalized, message, onProgress, { signal: options.signal });
    }
    let completed = 0;
    let transferredBytes = 0;
    // These are HTTP body bytes (Base64 + JSON), not original file sizes.
    const blobOverhead = Buffer.byteLength(JSON.stringify({ content: '', encoding: 'base64' }));
    const blobSizes = new Map(normalized.filter((change) => !change.delete).map((change) => [
      change.path, 4 * Math.ceil((Buffer.isBuffer(change.bytes) ? change.bytes.length : Buffer.from(change.bytes).length) / 3) + blobOverhead
    ]));
    let totalBytes = [...blobSizes.values()].reduce((sum, size) => sum + size, 0);
    const progress = (phase, current = '') => onProgress?.({
      phase, current, completed, total: normalized.length, transferredBytes, totalBytes
    });
    progress('preparing');
    const head = await this.branchHead(requestOptions);
    const tree = [];
    for (const change of normalized) {
      checkCanceled(options.signal);
      progress('uploading', change.path);
      if (change.delete) tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
      else {
        const previousBytes = transferredBytes;
        const blob = await this.request(`${this.repoPrefix(c)}/git/blobs`, {
          method: 'POST',
          body: { content: Buffer.from(change.bytes).toString('base64'), encoding: 'base64' },
          ...requestOptions,
          onUploadProgress: ({ sent, total }) => {
            if (!Number.isFinite(sent) || !Number.isFinite(total) || sent < 0 || total <= 0 || sent > total) return;
            totalBytes += total - blobSizes.get(change.path);
            blobSizes.set(change.path, total);
            transferredBytes = Math.max(transferredBytes, previousBytes + sent);
            progress('uploading', change.path);
          }
        });
        tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      completed += 1;
      progress('uploading', change.path);
    }
    progress('committing');
    checkCanceled(options.signal);
    const nextTree = await this.request(`${this.repoPrefix(c)}/git/trees`, {
      ...requestOptions,
      method: 'POST', body: { base_tree: head.treeSha, tree }
    });
    checkCanceled(options.signal);
    const commit = await this.request(`${this.repoPrefix(c)}/git/commits`, {
      ...requestOptions,
      method: 'POST', body: { message, tree: nextTree.sha, parents: [head.commitSha] }
    });
    progress('committing');
    const branchRef = c.branch.split('/').map(encodeURIComponent).join('/');
    checkCanceled(options.signal);
    await this.request(`${this.repoPrefix(c)}/git/refs/heads/${branchRef}`, {
      ...requestOptions,
      method: 'PATCH', body: { sha: commit.sha, force: false }
    });
    progress('committing');
    return { commitSha: commit.sha, changed: normalized.length };
  }


}

module.exports = { GitHubService, GitHubError };
