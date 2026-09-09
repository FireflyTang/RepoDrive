'use strict';

const { net } = require('electron');
const { normalizeRepoPath } = require('./validation');

class GitHubReadService {
  constructor(getConfig) { this.getConfig = getConfig; }
  async request(apiPath, options = {}) {
    const config = this.getConfig();
    const headers = { Accept: options.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'RepoDrive-ReadOnly/0.2', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) };
    const response = await net.fetch(`https://api.github.com${apiPath}`, { headers });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).message || ''; } catch { detail = response.statusText; }
      const hints = { 401: 'Token 无效或已过期', 403: '没有读取权限或已触发 GitHub 限制', 404: '找不到代码仓、分支或路径' };
      const error = new Error(hints[response.status] || detail || `GitHub 请求失败 (${response.status})`); error.status = response.status; throw error;
    }
    return options.raw ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  prefix() { const c=this.getConfig(); return `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`; }
  async validateRepository() {
    const c=this.getConfig(); const repo=await this.request(this.prefix()); await this.request(`${this.prefix()}/branches/${encodeURIComponent(c.branch)}`);
    if (repo.permissions?.push) throw new Error('Windows 只读版拒绝使用 GitHub 报告为可写的 Token，请改用 Contents: Read-only Token。');
    return { fullName:repo.full_name, private:repo.private, defaultBranch:repo.default_branch, permissions:repo.permissions || {} };
  }
  async list(remotePath='') {
    const c=this.getConfig(); const clean=normalizeRepoPath(remotePath); const suffix=clean?`/${clean.split('/').map(encodeURIComponent).join('/')}`:'';
    const value=await this.request(`${this.prefix()}/contents${suffix}?ref=${encodeURIComponent(c.branch)}`); const rows=Array.isArray(value)?value:[value];
    return rows.map(({name,path,type,size,sha})=>({name,path,type,size,sha})).sort((a,b)=>(a.type===b.type?a.name.localeCompare(b.name):a.type==='dir'?-1:1));
  }
  async readFile(remotePath) { const c=this.getConfig(); const encoded=normalizeRepoPath(remotePath).split('/').map(encodeURIComponent).join('/'); return this.request(`${this.prefix()}/contents/${encoded}?ref=${encodeURIComponent(c.branch)}`,{raw:true}); }
}

module.exports = { GitHubReadService };
