'use strict';

const SEGMENT_FORBIDDEN = /(^|\/)\.\.($|\/)/;

function normalizeRepoPath(input = '') {
  const normalized = String(input).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (SEGMENT_FORBIDDEN.test(normalized)) throw new Error('路径不能包含 ..');
  return normalized;
}

function parseRepository(value) {
  const text = String(value || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = text.split('/');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error('代码仓格式应为 owner/repo 或 GitHub 仓库网址');
  }
  return { owner: parts[0], repo: parts[1] };
}

function validateBranch(value) {
  const branch = String(value || 'main').trim();
  if (!branch || branch.includes('..') || /[~^:?*[\\\x00-\x20\x7f]/.test(branch) || branch.endsWith('/') || branch.endsWith('.')) {
    throw new Error('分支名称无效');
  }
  return branch;
}

function validateProxy(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text.includes('://') ? text : `http://${text}`); } catch { throw new Error('代理地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || !url.port) {
    throw new Error('代理格式应为 http://主机:端口');
  }
  return url.toString().replace(/\/$/, '');
}

module.exports = { normalizeRepoPath, parseRepository, validateBranch, validateProxy };
