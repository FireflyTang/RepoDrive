'use strict';

const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const settings = require('./settings-store');
const { GitHubService } = require('./github-service');
const { canUpload, assertUploadAllowed, assertCredentialPolicy } = require('./platform-policy');
const { normalizeRepoPath, parseRepository, validateBranch, validateProxy } = require('./validation');

let mainWindow;
let runtimeConfig = null;

function localGitHubToken() {
  if (process.platform !== 'darwin') return '';
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

function resolvedConfig() {
  const stored = settings.getPublic();
  if (!runtimeConfig) {
    const parsed = stored.repository ? parseRepository(stored.repository) : { owner: '', repo: '' };
    runtimeConfig = { ...stored, ...parsed, token: settings.getToken() || localGitHubToken() };
  }
  return runtimeConfig;
}

const github = new GitHubService(resolvedConfig);

async function validateRepositoryAccess() {
  const repo = await github.validateRepository();
  assertCredentialPolicy(repo.permissions);
  return repo;
}

async function applyProxy(proxy) {
  await session.defaultSession.setProxy(proxy ? { proxyRules: proxy } : { mode: 'direct' });
  await session.defaultSession.closeAllConnections();
}

function scopedPath(current = '', name = '') {
  const root = normalizeRepoPath(resolvedConfig().rootPath);
  return [root, normalizeRepoPath(current), normalizeRepoPath(name)].filter(Boolean).join('/');
}

async function downloadTree(repoPath, destination) {
  const items = await github.list(repoPath);
  await fs.mkdir(destination, { recursive: true });
  for (const item of items) {
    const target = path.join(destination, item.name);
    if (item.type === 'dir') await downloadTree(item.path, target);
    else {
      mainWindow?.webContents.send('transfer:progress', { kind: 'download', current: item.path });
      await fs.writeFile(target, await github.downloadFile(item.path));
    }
  }
}

async function collectLocalFiles(root, current = root, result = []) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const localPath = path.join(current, entry.name);
    if (entry.isDirectory()) await collectLocalFiles(root, localPath, result);
    else if (entry.isFile()) result.push({ localPath, relativePath: path.relative(root, localPath).split(path.sep).join('/') });
  }
  return result;
}

async function uploadLocalFiles(files, current, prefix = '') {
  const uploaded = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const stat = await fs.stat(file.localPath);
    if (stat.size > 100 * 1024 * 1024) throw new Error(`${file.relativePath} 超过 GitHub 单文件 100 MB 限制。`);
    const relative = [prefix, file.relativePath].filter(Boolean).join('/');
    mainWindow?.webContents.send('transfer:progress', { kind: 'upload', current: relative, completed: index, total: files.length });
    await github.uploadFile(scopedPath(current, relative), await fs.readFile(file.localPath));
    uploaded.push(relative);
  }
  mainWindow?.webContents.send('transfer:progress', { kind: 'upload', completed: files.length, total: files.length });
  return uploaded;
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({ platform: process.platform, canUpload: canUpload(), version: app.getVersion() }));
  ipcMain.handle('settings:get', () => settings.getPublic());
  ipcMain.handle('settings:save', async (_event, form) => {
    const previous = { ...resolvedConfig() };
    const stored = settings.getPublic();
    const repository = stored.fixedRepository ? stored.repository : form.repository;
    const parsed = parseRepository(repository);
    const clean = {
      repository: `${parsed.owner}/${parsed.repo}`,
      branch: validateBranch(stored.fixedRepository ? stored.branch : form.branch),
      rootPath: normalizeRepoPath(stored.fixedRepository ? stored.rootPath : form.rootPath),
      proxy: validateProxy(form.proxy),
      token: String(form.token || '').trim(),
      clearToken: Boolean(form.clearToken)
    };
    runtimeConfig = { ...clean, ...parsed, token: clean.token || (clean.clearToken ? localGitHubToken() : settings.getToken() || localGitHubToken()) };
    try {
      await applyProxy(clean.proxy);
      const repo = await validateRepositoryAccess();
      const saved = settings.save(clean);
      runtimeConfig = { ...saved, ...parsed, token: runtimeConfig.token };
      return { settings: saved, repo };
    } catch (error) {
      runtimeConfig = previous;
      await applyProxy(previous.proxy).catch(() => {});
      throw error;
    }
  });
  ipcMain.handle('repo:connect', async () => {
    const c = resolvedConfig();
    if (!c.owner || !c.repo) throw new Error('请先配置代码仓。');
    await applyProxy(c.proxy);
    return validateRepositoryAccess();
  });
  ipcMain.handle('repo:list', (_event, current) => github.list(scopedPath(current)));
  ipcMain.handle('repo:download', async (_event, item) => {
    const repoPath = scopedPath('', item.path);
    if (item.type === 'dir') {
      const result = await dialog.showOpenDialog(mainWindow, { title: '选择下载位置', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled) return { canceled: true };
      const target = path.join(result.filePaths[0], item.name);
      await downloadTree(repoPath, target);
      shell.showItemInFolder(target);
      return { path: target };
    }
    const result = await dialog.showSaveDialog(mainWindow, { title: '保存文件', defaultPath: item.name });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, await github.downloadFile(repoPath));
    shell.showItemInFolder(result.filePath);
    return { path: result.filePath };
  });
  ipcMain.handle('repo:uploadFiles', async (_event, current) => {
    assertUploadAllowed();
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择要上传的文件', properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return { canceled: true, uploaded: [] };
    if (!resolvedConfig().token) throw new Error('上传需要 GitHub Token，请先在连接设置中填写。');
    const files = result.filePaths.map((localPath) => ({ localPath, relativePath: path.basename(localPath) }));
    const uploaded = await uploadLocalFiles(files, current);
    return { canceled: false, uploaded };
  });
  ipcMain.handle('repo:uploadDirectory', async (_event, current) => {
    assertUploadAllowed();
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择要上传的目录', properties: ['openDirectory'] });
    if (result.canceled) return { canceled: true, uploaded: [] };
    if (!resolvedConfig().token) throw new Error('上传需要 GitHub Token，请先在连接设置中填写。');
    const root = result.filePaths[0];
    const files = await collectLocalFiles(root);
    if (!files.length) throw new Error('所选目录没有可上传的文件；GitHub 不保存空目录。');
    if (files.length > 1000) throw new Error('单次目录上传最多 1000 个文件，请拆分后重试。');
    const uploaded = await uploadLocalFiles(files, current, path.basename(root));
    return { canceled: false, uploaded, directory: path.basename(root) };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 760, minWidth: 900, minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#f5f7fb',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  registerIpc();
  const c = resolvedConfig();
  try { await applyProxy(c.proxy); } catch { /* surfaced when connecting */ }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
