'use strict';

const $ = (id) => document.getElementById(id);
const state = { selectedPath: '', connected: false, canUpload: false, settings: null, tree: new Map(), expanded: new Set(), loading: new Set() };
let toastTimer;
let renameTarget = null;
let dragDepth = 0;

function showToast(message, error = false) {
  const el = $('toast'); el.textContent = message; el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function errorMessage(error) { return String(error?.message || error || '操作失败').replace(/^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/, ''); }
function formatSize(bytes) { if (!bytes) return '—'; const units = ['B', 'KB', 'MB', 'GB']; const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3); return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`; }
function joinPath(...parts) { return parts.filter(Boolean).join('/'); }

function icon(kind) {
  const paths = { folder: 'M3 5.5h6l2 2h10v11H3z', file: 'M6 2.5h8l4 4v15H6z M14 2.5v5h4', download: 'M12 3v12m-4-4 4 4 4-4M5 20h14', trash: 'M4 7h16M9 7V4h6v3m-8 0 1 14h8l1-14', chevron: 'M9 5l6 7-6 7', rename: 'M4 20l4.5-1 10-10-3.5-3.5-10 10z M13.8 6.7l3.5 3.5' };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('ui-icon', `icon-${kind}`);
  for (const segment of paths[kind].split(' M')) { const child = document.createElementNS('http://www.w3.org/2000/svg', 'path'); child.setAttribute('d', segment.startsWith('M') ? segment : `M${segment}`); svg.append(child); }
  return svg;
}

function setConnected(value, name) {
  state.connected = value; $('statusDot').classList.toggle('online', value); $('repoLabel').textContent = name || state.settings?.repository || '尚未连接';
  $('refreshButton').disabled = !value; for (const el of document.querySelectorAll('.upload-action')) el.disabled = !value;
}

function showView(name) {
  $('filesView').classList.toggle('hidden', name !== 'files'); $('settingsView').classList.toggle('hidden', name !== 'settings');
  $('filesNav').classList.toggle('active', name === 'files'); $('settingsNav').classList.toggle('active', name === 'settings');
}

function renderLocation() {
  const parts = state.selectedPath ? state.selectedPath.split('/') : []; $('breadcrumbs').replaceChildren();
  const prefix = document.createElement('span'); prefix.className = 'location-prefix'; prefix.textContent = state.canUpload ? '上传到' : '当前位置'; $('breadcrumbs').append(prefix);
  const root = document.createElement('button'); root.className = 'crumb'; root.textContent = '根目录'; root.onclick = () => selectDirectory(''); $('breadcrumbs').append(root);
  parts.forEach((part, index) => { const sep = document.createElement('span'); sep.textContent = '›'; $('breadcrumbs').append(sep); const button = document.createElement('button'); button.className = 'crumb'; button.textContent = part; button.onclick = () => selectDirectory(parts.slice(0, index + 1).join('/')); $('breadcrumbs').append(button); });
}

async function loadDirectory(remotePath) {
  state.loading.add(remotePath); renderTree();
  try { const items = await window.repoDrive.list(remotePath); state.tree.set(remotePath, items.map((item) => ({ ...item, uiPath: joinPath(remotePath, item.name) }))); }
  finally { state.loading.delete(remotePath); }
}

function selectDirectory(remotePath) { state.selectedPath = remotePath; renderLocation(); renderTree(); }

async function toggleDirectory(item) {
  selectDirectory(item.uiPath);
  if (state.expanded.has(item.uiPath)) state.expanded.delete(item.uiPath);
  else { state.expanded.add(item.uiPath); if (!state.tree.has(item.uiPath)) await loadDirectory(item.uiPath); }
  renderTree();
}

function actionButton(kind, label, handler, danger = false) {
  const button = document.createElement('button'); button.className = `tree-action${danger ? ' danger' : ''}`; button.title = label; button.setAttribute('aria-label', label);
  button.append(icon(kind), document.createTextNode(label)); button.onclick = handler; return button;
}

function appendNodes(parentPath, depth, fragment) {
  for (const item of state.tree.get(parentPath) || []) {
    const row = document.createElement('div'); row.className = `file-row${item.uiPath === state.selectedPath ? ' selected' : ''}`; row.style.setProperty('--depth', depth);
    const main = document.createElement('div'); main.className = 'tree-main';
    const toggle = document.createElement('button'); toggle.className = `tree-toggle${state.expanded.has(item.uiPath) ? ' expanded' : ''}`; toggle.setAttribute('aria-label', item.type === 'dir' ? '展开或折叠' : '文件');
    if (item.type === 'dir') { toggle.append(icon('chevron')); toggle.onclick = () => toggleDirectory(item); } else toggle.disabled = true;
    const itemIcon = icon(item.type === 'dir' ? 'folder' : 'file'); itemIcon.classList.add('tree-kind');
    const label = document.createElement(item.type === 'dir' ? 'button' : 'span'); label.className = 'tree-label'; label.textContent = item.name; if (item.type === 'dir') label.onclick = () => toggleDirectory(item);
    main.append(toggle, itemIcon, label);
    const size = document.createElement('span'); size.className = 'size'; size.textContent = item.type === 'dir' ? '文件夹' : formatSize(item.size);
    const actions = document.createElement('div'); actions.className = 'file-actions';
    if (state.canUpload) actions.append(actionButton('rename', '重命名', () => openRename(item)));
    actions.append(actionButton('download', '下载', () => download(item)), actionButton('trash', '删除', () => remove(item), true));
    row.append(main, size, actions); fragment.append(row);
    if (item.type === 'dir' && state.expanded.has(item.uiPath)) {
      if (state.loading.has(item.uiPath)) { const loading = document.createElement('div'); loading.className = 'tree-loading'; loading.style.setProperty('--depth', depth + 1); loading.textContent = '正在读取…'; fragment.append(loading); }
      else appendNodes(item.uiPath, depth + 1, fragment);
    }
  }
}

function renderTree() {
  const list = $('fileList'); const fragment = document.createDocumentFragment(); appendNodes('', 0, fragment); list.replaceChildren(fragment);
  const rootItems = state.tree.get('') || []; $('emptyState').classList.toggle('hidden', state.connected || rootItems.length > 0);
  if (state.connected && !rootItems.length && !state.loading.has('')) { const empty = document.createElement('div'); empty.className = 'loading-row'; empty.textContent = '这个文件盘是空的'; list.append(empty); }
}

async function refreshTree() {
  const expanded = [...state.expanded].sort((a, b) => a.split('/').length - b.split('/').length); state.tree.clear();
  try { await loadDirectory(''); for (const remotePath of expanded) { try { await loadDirectory(remotePath); } catch { state.expanded.delete(remotePath); } } setConnected(true); renderTree(); }
  catch (error) { setConnected(false); state.tree.clear(); renderTree(); showToast(errorMessage(error), true); }
}

async function download(item) { try { showToast(`正在下载 ${item.name}…`); const result = await window.repoDrive.download({ ...item, path: item.uiPath }); if (!result.canceled) showToast('下载完成，已在文件管理器中显示'); } catch (error) { showToast(errorMessage(error), true); } finally { hideTransfer(); } }
async function remove(item) { try { const result = await window.repoDrive.delete({ ...item, path: item.uiPath }); if (!result.canceled) { if (state.selectedPath === item.uiPath || state.selectedPath.startsWith(`${item.uiPath}/`)) state.selectedPath = item.uiPath.split('/').slice(0, -1).join('/'); for (const expandedPath of [...state.expanded]) if (expandedPath === item.uiPath || expandedPath.startsWith(`${item.uiPath}/`)) state.expanded.delete(expandedPath); renderLocation(); showToast(`删除完成，共删除 ${result.deleted} 个文件`); await refreshTree(); } } catch (error) { showToast(errorMessage(error), true); } finally { hideTransfer(); } }

function openRename(item) {
  renameTarget = item;
  $('renameDescription').textContent = `修改“${item.name}”的名称，位置保持不变。`;
  $('renameInput').value = item.name;
  $('renameDialog').showModal();
  $('renameInput').focus();
  $('renameInput').select();
}

async function submitRename(event) {
  event.preventDefault();
  if (!renameTarget) return;
  const item = renameTarget;
  $('renameSubmit').disabled = true;
  try {
    const result = await window.repoDrive.rename({ ...item, path: item.uiPath }, $('renameInput').value);
    $('renameDialog').close(); renameTarget = null;
    if (result.renamed) {
      if (state.selectedPath === item.uiPath || state.selectedPath.startsWith(`${item.uiPath}/`)) state.selectedPath = result.path + state.selectedPath.slice(item.uiPath.length);
      for (const expandedPath of [...state.expanded]) {
        if (expandedPath === item.uiPath || expandedPath.startsWith(`${item.uiPath}/`)) {
          state.expanded.delete(expandedPath); state.expanded.add(result.path + expandedPath.slice(item.uiPath.length));
        }
      }
      renderLocation(); showToast(`已重命名为 ${result.path.split('/').pop()}`); await refreshTree();
    }
  } catch (error) { showToast(errorMessage(error), true); }
  finally { $('renameSubmit').disabled = false; hideTransfer(); }
}

function showTransfer(value) {
  const banner = $('transferBanner'); banner.classList.remove('hidden'); banner.classList.toggle('indeterminate', value.kind !== 'upload');
  $('transferTitle').textContent = value.kind === 'upload' ? `正在上传 ${value.completed || 0}/${value.total || 0}` : value.kind === 'rename' ? '正在重命名' : value.kind === 'delete' ? '正在删除目录' : '正在下载目录';
  $('transferDetail').textContent = value.current || '正在整理文件…'; $('progressBar').style.width = value.total ? `${Math.round((value.completed || 0) / value.total * 100)}%` : '';
}
function hideTransfer() { $('transferBanner').classList.add('hidden'); }

async function init() {
  const [info, saved] = await Promise.all([window.repoDrive.info(), window.repoDrive.getSettings()]); state.canUpload = info.canUpload; state.settings = saved;
  $('readonlyNotice').classList.toggle('hidden', info.canUpload); $('uploadButton').classList.toggle('hidden', !info.canUpload); $('uploadFolderButton').classList.toggle('hidden', !info.canUpload);
  $('platformNote').textContent = info.canUpload ? `${info.platform === 'linux' ? 'Linux' : 'macOS'} 完整模式 · 可浏览、下载、上传、重命名与删除` : 'Windows 无上传模式 · 可浏览、下载与删除';
  setConnected(false); renderLocation();
  if (!info.canUpload) $('tokenHint').textContent = 'Windows 浏览/下载可使用只读 Token；删除需要 Contents: Read and write 权限，但客户端仍无法上传。';
  for (const id of ['repository', 'branch', 'rootPath', 'proxy']) $(id).value = saved[id] || '';
  $('clearTokenRow').classList.toggle('hidden', !saved.hasToken); if (saved.hasToken) $('token').placeholder = '已安全保存；留空则保持不变';
  if (saved.repository) { try { const repo = await window.repoDrive.connect(); setConnected(true, repo.fullName); await refreshTree(); } catch (error) { setConnected(false); showToast(errorMessage(error), true); showView('settings'); } }
}

$('filesNav').onclick = () => showView('files'); $('settingsNav').onclick = () => showView('settings'); $('setupButton').onclick = () => showView('settings'); $('refreshButton').onclick = refreshTree;
async function upload(kind) { if (!state.canUpload || !state.connected) return; const method = kind === 'directory' ? 'uploadDirectory' : 'uploadFiles'; try { for (const el of document.querySelectorAll('.upload-action')) el.disabled = true; const result = await window.repoDrive[method](state.selectedPath); if (!result.canceled) { showToast(kind === 'directory' ? `目录 ${result.directory} 上传完成，共 ${result.uploaded.length} 个文件` : `已上传 ${result.uploaded.length} 个文件`); await refreshTree(); } } catch (error) { showToast(errorMessage(error), true); } finally { hideTransfer(); for (const el of document.querySelectorAll('.upload-action')) el.disabled = !state.connected; } }
$('uploadButton').onclick = () => upload('files'); $('uploadFolderButton').onclick = () => upload('directory');
$('renameForm').onsubmit = submitRename;
$('renameCancel').onclick = () => { $('renameDialog').close(); renameTarget = null; };
$('renameDialog').addEventListener('cancel', () => { renameTarget = null; });

const dropZone = $('dropZone');
for (const eventName of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); event.stopPropagation(); });
}
dropZone.addEventListener('dragenter', () => { if (state.canUpload && state.connected) { dragDepth += 1; dropZone.classList.add('drag-active'); } });
dropZone.addEventListener('dragover', (event) => { if (state.canUpload && state.connected) event.dataTransfer.dropEffect = 'copy'; });
dropZone.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropZone.classList.remove('drag-active'); });
dropZone.addEventListener('drop', async (event) => {
  dragDepth = 0; dropZone.classList.remove('drag-active');
  if (!state.canUpload || !state.connected || !event.dataTransfer.files.length) return;
  try {
    showToast('正在上传到根目录…');
    const paths = Array.from(event.dataTransfer.files, (file) => window.repoDrive.getPathForFile(file));
    const result = await window.repoDrive.uploadDropped(paths);
    showToast(`已上传到根目录，共 ${result.uploaded.length} 个文件`);
    await refreshTree();
  } catch (error) { showToast(errorMessage(error), true); }
  finally { hideTransfer(); }
});
$('settingsForm').onsubmit = async (event) => { event.preventDefault(); $('saveButton').disabled = true; $('saveStatus').textContent = '正在测试连接…'; try { const payload = { repository: $('repository').value, branch: $('branch').value, rootPath: $('rootPath').value, token: $('token').value, proxy: $('proxy').value, clearToken: $('clearToken').checked }; const result = await window.repoDrive.saveSettings(payload); state.settings = result.settings; state.selectedPath = ''; state.expanded.clear(); setConnected(true, result.repo.fullName); $('token').value = ''; $('clearToken').checked = false; $('clearTokenRow').classList.toggle('hidden', !result.settings.hasToken); $('token').placeholder = '已安全保存；留空则保持不变'; $('saveStatus').textContent = '连接成功'; showToast('设置已保存，GitHub 连接正常'); showView('files'); renderLocation(); await refreshTree(); } catch (error) { $('saveStatus').textContent = '连接失败'; showToast(errorMessage(error), true); } finally { $('saveButton').disabled = false; } };

init().catch((error) => showToast(errorMessage(error), true));
window.repoDrive.onTransferProgress(showTransfer);
