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

async function deleteTree(repoPath) {
  const items = await github.list(repoPath);
  let deleted = 0;
  for (const item of items) {
    if (item.type === 'dir') deleted += await deleteTree(item.path);
    else {
      mainWindow?.webContents.send('transfer:progress', { kind: 'delete', current: item.path });
      await github.deleteFile(item.path, item.sha);
      deleted += 1;
    }
  }
  return deleted;
}

async function collectRemoteFiles(repoPath, result = []) {
  const items = await github.list(repoPath);
  for (const item of items) {
    if (item.type === 'dir') await collectRemoteFiles(item.path, result);
    else result.push(item);
  }
  return result;
}

async function assertRemotePathMissing(repoPath) {
  try {
    await github.list(repoPath);
  } catch (error) {
    if (error.status === 404) return;
    throw error;
  }
  throw new Error('同一目录下已经存在这个名称，请换一个名称。');
}

function validateItemName(value) {
  const name = String(value || '').trim();
  if (!name) throw new Error('名称不能为空。');
  if (name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('名称不能包含斜杠，也不能是 . 或 ..。');
  if (Buffer.byteLength(name, 'utf8') > 255) throw new Error('名称过长，请控制在 255 字节以内。');
  return name;
}

async function renameRemoteItem(item, newName) {
  const cleanName = validateItemName(newName);
  if (cleanName === item.name) return { renamed: false, path: item.path, files: 0 };
  const parent = normalizeRepoPath(item.path).split('/').slice(0, -1).join('/');
  const oldPath = scopedPath('', item.path);
  const newUiPath = [parent, cleanName].filter(Boolean).join('/');
  const newPath = scopedPath('', newUiPath);
  await assertRemotePathMissing(newPath);

  const files = item.type === 'dir' ? await collectRemoteFiles(oldPath) : [{ path: oldPath, sha: item.sha }];
  if (!files.length) throw new Error('GitHub 不保存空目录，无法重命名这个目录。');

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const suffix = item.type === 'dir' ? file.path.slice(oldPath.length).replace(/^\//, '') : '';
    const destination = [newPath, suffix].filter(Boolean).join('/');
    mainWindow?.webContents.send('transfer:progress', { kind: 'rename', current: file.path, completed: index, total: files.length * 2 });
    await github.uploadFile(destination, await github.downloadFile(file.path), `Rename ${oldPath} to ${newPath} via RepoDrive`);
  }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    mainWindow?.webContents.send('transfer:progress', { kind: 'rename', current: file.path, completed: files.length + index, total: files.length * 2 });
    await github.deleteFile(file.path, file.sha, `Rename ${oldPath} to ${newPath} via RepoDrive`);
  }
  mainWindow?.webContents.send('transfer:progress', { kind: 'rename', completed: files.length * 2, total: files.length * 2 });
  return { renamed: true, path: newUiPath, files: files.length };
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

async function uploadDroppedPaths(localPaths) {
  assertUploadAllowed();
  if (!resolvedConfig().token) throw new Error('上传需要 GitHub Token，请先在连接设置中填写。');
  const rawPaths = (localPaths || []).filter((value) => typeof value === 'string' && value.trim());
  if (rawPaths.some((value) => !path.isAbsolute(value))) throw new Error('拖放路径无效。');
  const paths = [...new Set(rawPaths.map((value) => path.resolve(value)))];
  if (!paths.length) throw new Error('没有识别到可上传的文件或目录。');
  const files = [];
  for (const localPath of paths) {
    const stat = await fs.stat(localPath);
    if (stat.isDirectory()) {
      const nested = await collectLocalFiles(localPath);
      files.push(...nested.map((file) => ({ ...file, relativePath: [path.basename(localPath), file.relativePath].join('/') })));
    } else if (stat.isFile()) files.push({ localPath, relativePath: path.basename(localPath) });
  }
  if (!files.length) throw new Error('拖入的目录没有可上传文件；GitHub 不保存空目录。');
  if (files.length > 1000) throw new Error('单次拖放最多上传 1000 个文件，请拆分后重试。');
  return { canceled: false, uploaded: await uploadLocalFiles(files, ''), destination: '/' };
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({ platform: process.platform, canUpload: canUpload(), version: app.getVersion() }));
  ipcMain.handle('settings:get', () => settings.getPublic());
  ipcMain.handle('settings:save', async (_event, form) => {
    const previous = { ...resolvedConfig() };
    const parsed = parseRepository(form.repository);
    const clean = {
      repository: `${parsed.owner}/${parsed.repo}`,
      branch: validateBranch(form.branch),
      rootPath: normalizeRepoPath(form.rootPath),
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
  ipcMain.handle('repo:delete', async (_event, item) => {
    const target = scopedPath('', item.path);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
      title: '确认删除',
      message: `确定要删除“${item.name}”吗？`,
      detail: item.type === 'dir' ? '目录中的所有文件都会从 GitHub 仓库删除，并产生多个提交。此操作无法在客户端内撤销。' : '文件会从 GitHub 仓库删除并产生一个提交。此操作无法在客户端内撤销。'
    });
    if (confirmation.response !== 1) return { canceled: true, deleted: 0 };
    if (!resolvedConfig().token) throw new Error('删除需要有写权限的 GitHub Token，请先在连接设置中填写。');
    const deleted = item.type === 'dir' ? await deleteTree(target) : (await github.deleteFile(target, item.sha), 1);
    return { canceled: false, deleted };
  });
  ipcMain.handle('repo:rename', async (_event, item, newName) => {
    assertUploadAllowed();
    if (!resolvedConfig().token) throw new Error('重命名需要有写权限的 GitHub Token，请先在连接设置中填写。');
    return renameRemoteItem(item, newName);
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
  ipcMain.handle('repo:uploadDropped', (_event, localPaths) => uploadDroppedPaths(localPaths));
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
