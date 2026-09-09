'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const defaults = { repository: '', branch: 'main', rootPath: '', proxy: '', tokenEncrypted: '' };

function filePath() { return path.join(app.getPath('userData'), 'settings.json'); }

function preset() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'repodrive.config.json'), 'utf8'));
    if (!value.repository || value.repository === 'OWNER/REPOSITORY') return null;
    return { repository: value.repository, branch: value.branch || 'main', rootPath: value.rootPath || '', proxy: value.proxy || '' };
  } catch { return null; }
}

function read() {
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch { /* first run */ }
  return { ...defaults, ...(preset() || {}), ...stored };
}

function getPublic() {
  const data = read();
  return { repository: data.repository, branch: data.branch, rootPath: data.rootPath, proxy: data.proxy, hasToken: Boolean(data.tokenEncrypted) };
}

function getToken() {
  const value = read().tokenEncrypted;
  if (!value) return '';
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return ''; }
}

function save(next) {
  const current = read();
  const tokenEncrypted = typeof next.token === 'string' && next.token
    ? safeStorage.encryptString(next.token).toString('base64')
    : (next.clearToken ? '' : current.tokenEncrypted);
  const data = { repository: next.repository, branch: next.branch, rootPath: next.rootPath, proxy: next.proxy, tokenEncrypted };
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), { mode: 0o600 });
  return getPublic();
}

module.exports = { getPublic, getToken, save };
