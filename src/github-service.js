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
      'User-Agent': 'RepoDrive/0.5.1',
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(options.headers || {})
    };
    const response = await net.fetch(`https://api.github.com${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    });
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
}

module.exports = { GitHubService, GitHubError };
