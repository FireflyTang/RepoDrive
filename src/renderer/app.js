'use strict';

const $ = (id) => document.getElementById(id);
const state = { selectedPath: '', connected: false, canUpload: false, uploading: false, stopping: false, refreshingUpload: false, settings: null, tree: new Map(), expanded: new Set(), loading: new Set(), selectedItems: new Map() };
let toastTimer;
let renameTarget = null;
let dragDepth = 0;

function showToast(message, error = false) {
  const el = $('toast'); el.textContent = message; el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function errorMessage(error) { return String(error?.message || error || '操作失败').replace(/^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/, ''); }
function formatSize(bytes) { if (!bytes) return '—'; const units = ['B', 'KB', 'MB', 'GB']; const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3); return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`; }
function formatTransferSize(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const index = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return (bytes / 1024 ** index).toFixed(index ? 2 : 0) + ' ' + units[index];
}
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
  updateUploadControls();
}

function showView(name) {
  dragDepth = 0; $('filesView').classList.remove('drag-active');
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

function updateBatchToolbar() {
  const count = state.selectedItems.size;
  $('batchToolbar').classList.toggle('hidden', !count);
  $('selectionCount').textContent = `已选择 ${count} 项`;
  $('batchDeleteButton').disabled = !state.connected || !count;
}

function setItemSelected(item, checked) {
  if (checked) state.selectedItems.set(item.uiPath, { name: item.name, path: item.uiPath, type: item.type });
  else state.selectedItems.delete(item.uiPath);
  updateBatchToolbar();
}

function appendNodes(parentPath, depth, fragment) {
  for (const item of state.tree.get(parentPath) || []) {
    const row = document.createElement('div'); row.className = `file-row${item.uiPath === state.selectedPath ? ' selected' : ''}`; row.style.setProperty('--depth', depth);
    const main = document.createElement('div'); main.className = 'tree-main';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'tree-select'; checkbox.setAttribute('aria-label', `选择 ${item.name}`); checkbox.checked = state.selectedItems.has(item.uiPath); checkbox.onchange = () => setItemSelected(item, checkbox.checked);
    const toggle = document.createElement('button'); toggle.className = `tree-toggle${state.expanded.has(item.uiPath) ? ' expanded' : ''}`; toggle.setAttribute('aria-label', item.type === 'dir' ? '展开或折叠' : '文件');
    if (item.type === 'dir') { toggle.append(icon('chevron')); toggle.onclick = () => toggleDirectory(item); } else toggle.disabled = true;
    const itemIcon = icon(item.type === 'dir' ? 'folder' : 'file'); itemIcon.classList.add('tree-kind');
    const label = document.createElement(item.type === 'dir' ? 'button' : 'span'); label.className = 'tree-label'; label.textContent = item.name; if (item.type === 'dir') label.onclick = () => toggleDirectory(item);
    main.append(checkbox, toggle, itemIcon, datedLabel(item, label));
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
  updateBatchToolbar();
}

async function refreshTree(rethrow = false) {
  const expanded = [...state.expanded].sort((a, b) => a.split('/').length - b.split('/').length); state.tree.clear(); state.selectedItems.clear();
  try { await loadDirectory(''); for (const remotePath of expanded) { try { await loadDirectory(remotePath); } catch { state.expanded.delete(remotePath); } } setConnected(true); renderTree(); }
  catch (error) { setConnected(false); state.tree.clear(); renderTree(); showToast(errorMessage(error), true); if (rethrow) throw error; }
}

async function download(item) {
  if (state.uploading) { uploadFeedback('正在上传或刷新目录，请等待当前操作完成。', true); return; }
 try { showToast(`正在下载 ${item.name}…`); const result = await window.repoDrive.download({ ...item, path: item.uiPath }); if (!result.canceled) showToast('下载完成，已在文件管理器中显示'); } catch (error) { showToast(errorMessage(error), true); } finally { hideTransfer(); } }
async function remove(item) {
  if (state.uploading) { uploadFeedback('正在上传或刷新目录，请等待当前操作完成。', true); return; }
 try { const result = await window.repoDrive.delete({ ...item, path: item.uiPath }); if (!result.canceled) { if (state.selectedPath === item.uiPath || state.selectedPath.startsWith(`${item.uiPath}/`)) state.selectedPath = item.uiPath.split('/').slice(0, -1).join('/'); for (const expandedPath of [...state.expanded]) if (expandedPath === item.uiPath || expandedPath.startsWith(`${item.uiPath}/`)) state.expanded.delete(expandedPath); renderLocation(); showToast(`删除完成，共删除 ${result.deleted} 个文件`); await refreshTree(); } } catch (error) { showToast(errorMessage(error), true); } finally { hideTransfer(); } }

async function removeSelected() {
  if (state.uploading) { uploadFeedback('正在上传或刷新目录，请等待当前操作完成。', true); return; }

  if (!state.selectedItems.size) return;
  try {
    const result = await window.repoDrive.deleteBatch([...state.selectedItems.values()]);
    if (!result.canceled) { state.selectedItems.clear(); showToast(`批量删除完成，共删除 ${result.deleted} 个文件（1 个提交）`); await refreshTree(); }
  } catch (error) { showToast(errorMessage(error), true); }
  finally { hideTransfer(); updateBatchToolbar(); }
}

function openRename(item) {
  if (state.uploading) { uploadFeedback('正在上传或刷新目录，请等待当前操作完成。', true); return; }

  renameTarget = item;
  $('renameDescription').textContent = `修改“${item.name}”的名称，位置保持不变。`;
  $('renameInput').value = item.name;
  $('renameDialog').showModal();
  $('renameInput').focus();
  $('renameInput').select();
}

async function submitRename(event) {
  if (state.uploading) { event.preventDefault(); uploadFeedback('正在上传或刷新目录，请等待当前操作完成。', true); return; }

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

function updateUploadControls() {
  for (const el of document.querySelectorAll('.upload-action')) el.disabled = !state.connected || state.uploading;
  $('refreshButton').disabled = !state.connected || state.uploading;
  $('stopUploadButton').classList.toggle('hidden', !state.uploading);
  $('stopUploadButton').disabled = state.stopping || state.refreshingUpload;
  $('stopUploadButton').textContent = state.stopping ? '正在停止…' : '停止上传';
  for (const id of ['saveButton', 'clearFilesButton', 'clearHistoryButton']) $(id).disabled = state.uploading;
}

function uploadFeedback(message, error = false) {
  const el = $('uploadStatus'); el.textContent = message;
  el.className = 'upload-status' + (error ? ' error' : '');
  showToast(message, error);
}

function showTransfer(value) {
  if (state.uploading && value.kind !== 'upload') return;
  if (value.kind === 'upload' && (!state.uploading || state.stopping || state.refreshingUpload)) return;
  const banner = $('transferBanner');
  banner.classList.remove('hidden');
  const upload = value.kind === 'upload';
  const knownBytes = upload && !value.gitProgress && value.phase === 'uploading' && Number.isFinite(value.totalBytes) && value.totalBytes > 0 && Number.isFinite(value.transferredBytes);
  banner.classList.toggle('indeterminate', !knownBytes);
  const track = $('progressTrack');
  track.removeAttribute('aria-valuenow'); track.removeAttribute('aria-valuetext');
  $('progressBar').style.width = '';
  if (upload) {
    const phase = value.phase || 'preparing';
    $('transferTitle').textContent = phase === 'committing' ? '正在创建 GitHub 提交…' : phase === 'uploading' ? (value.gitProgress ? '正在通过 Git 上传…' : '正在发送文件…') : '正在准备 / 扫描文件…';
    const detail = [value.current, value.gitProgress, value.total ? `已处理 ${value.completed || 0}/${value.total} 个文件` : ''];
    if (knownBytes) {
      const sent = Math.max(0, Math.min(value.transferredBytes, value.totalBytes));
      // Sending the full body is not completion: GitHub still has to respond and commit.
      const percent = Math.floor(sent / value.totalBytes * 100);
      detail.push(`已发送 ${formatTransferSize(sent)} / ${formatTransferSize(value.totalBytes)} · ${percent}%`);
      detail.push('传输数据含编码开销');
      if (sent === value.totalBytes) detail.push('发送完成，等待GitHub确认');
      $('progressBar').style.width = `${percent}%`;
      track.setAttribute('aria-valuenow', percent);
    } else if (!value.gitProgress) {
      detail.push(phase === 'committing' ? '等待 GitHub 确认，尚未完成' : '传输大小尚未确定');
    }
    if (value.gitProgress) detail.push(phase === 'committing' ? '等待远端确认，尚未完成' : 'Git 正在传输，等待远端确认');
    $('transferDetail').textContent = detail.filter(Boolean).join(' · ');
  } else {
    $('transferTitle').textContent = value.kind === 'rename' ? '正在重命名' : value.kind === 'delete' ? '正在删除目录' : '正在下载目录';
    $('transferDetail').textContent = value.current || '正在整理文件…';
  }
  track.setAttribute('aria-valuetext', $('transferTitle').textContent + ' ' + $('transferDetail').textContent);
}
function hideTransfer() { if (!state.uploading) $('transferBanner').classList.add('hidden'); }

function canStartUpload() {
  if (state.uploading) { uploadFeedback('正在上传或刷新目录，请等待当前操作完成。', true); return false; }
  if (!state.canUpload) { uploadFeedback('当前平台不支持上传。', true); return false; }
  if (!state.connected) { uploadFeedback('尚未连接代码仓，请先在连接设置中连接。', true); return false; }
  return true;
}

async function runUpload(operation, success) {
  if (!canStartUpload()) return;
  state.uploading = true; state.stopping = false; state.refreshingUpload = false; updateUploadControls();
  uploadFeedback('正在准备 / 扫描文件，请稍候…');
  showTransfer({ kind: 'upload', phase: 'preparing' });
  let uploaded = false;
  try {
    const result = await operation();
    if (result.canceled) { uploadFeedback(state.stopping ? '用户已取消上传；后台可能已经提交，请刷新目录确认。' : '已取消文件选择，未上传。'); return; }
    uploaded = true;
    showTransfer({ kind: 'upload', phase: 'committing', current: '提交已完成，正在刷新目录…' });
    state.refreshingUpload = true; updateUploadControls();
    $('transferTitle').textContent = '正在刷新目录…';
    $('transferDetail').textContent = '上传已完成，正在刷新目录。';
    $('progressTrack').setAttribute('aria-valuetext', '正在刷新目录');
    $('transferBanner').classList.add('indeterminate');
    $('progressTrack').removeAttribute('aria-valuenow');
    await refreshTree(true);
    uploadFeedback(state.stopping ? '上传已完成；停止请求到达时提交已生效。' : success(result));
  } catch (error) {
    const message = errorMessage(error);
    const canceled = state.stopping || /取消|停止|abort|cancel/i.test(message);
    uploadFeedback(uploaded ? (state.stopping ? '上传已完成；停止请求到达时提交已生效。但目录刷新失败：' : '上传已完成，但目录刷新失败：') + message : canceled ? '用户已取消上传；后台可能已经提交，结果尚未确认，请刷新目录核对。' : '上传失败：' + message, true);
  } finally {
    state.uploading = false; state.stopping = false; state.refreshingUpload = false; updateUploadControls(); hideTransfer();
  }
}

$('stopUploadButton').onclick = async () => {
  if (!state.uploading || state.stopping || state.refreshingUpload) return;
  state.stopping = true; updateUploadControls();
  $('transferTitle').textContent = '正在停止…';
  $('progressTrack').setAttribute('aria-valuetext', '正在停止，等待上传请求结束');
  $('transferDetail').textContent = '等待上传请求结束；已发送的提交可能生效，请随后刷新确认。';
  $('transferBanner').classList.add('indeterminate');
  $('progressTrack').removeAttribute('aria-valuenow');
  uploadFeedback('正在停止…已发送的提交可能生效，请等待请求结束并刷新确认。');
  try { await window.repoDrive.cancelUpload(); }
  catch (error) { if (state.uploading && state.stopping) uploadFeedback('停止请求失败：' + errorMessage(error) + '；仍在等待上传结束，请随后刷新确认。', true); }
};

async function init() {
  const [info, saved] = await Promise.all([window.repoDrive.info(), window.repoDrive.getSettings()]); state.canUpload = info.canUpload; state.settings = saved;
  $('readonlyNotice').classList.toggle('hidden', info.canUpload); $('uploadButton').classList.toggle('hidden', !info.canUpload); $('uploadFolderButton').classList.toggle('hidden', !info.canUpload); $('pasteButton').classList.toggle('hidden', !info.canUpload);
  $('platformNote').textContent = info.canUpload ? `${info.platform === 'linux' ? 'Linux' : 'macOS'} 完整模式 · 支持批量提交、粘贴与历史重置` : 'Windows 无上传模式 · 可浏览、下载与删除';
  setConnected(false); renderLocation();
  if (!info.canUpload) $('tokenHint').textContent = 'Windows 浏览/下载可使用只读 Token；删除需要 Contents: Read and write 权限，但客户端仍无法上传。';
  for (const id of ['repository', 'branch', 'rootPath', 'proxy']) $(id).value = saved[id] || '';
  $('clearTokenRow').classList.toggle('hidden', !saved.hasToken); if (saved.hasToken) $('token').placeholder = '已安全保存；留空则保持不变';
  if (saved.repository) { try { const repo = await window.repoDrive.connect(); setConnected(true, repo.fullName); await refreshTree(); } catch (error) { setConnected(false); showToast(errorMessage(error), true); showView('settings'); } }
}

$('filesNav').onclick = () => showView('files'); $('settingsNav').onclick = () => showView('settings'); $('setupButton').onclick = () => showView('settings'); $('refreshButton').onclick = () => refreshTree();
async function upload(kind) {
  const method = kind === 'directory' ? 'uploadDirectory' : 'uploadFiles';
  await runUpload(() => window.repoDrive[method](state.selectedPath), (result) => kind === 'directory' ? `目录 ${result.directory} 上传完成，共 ${result.uploaded.length} 个文件` : `已上传 ${result.uploaded.length} 个文件`);
}
$('uploadButton').onclick = () => upload('files'); $('uploadFolderButton').onclick = () => upload('directory');
$('clearSelectionButton').onclick = () => { state.selectedItems.clear(); renderTree(); };
$('batchDeleteButton').onclick = removeSelected;

async function pasteClipboard() {
  const destination = state.selectedPath;
  await runUpload(() => window.repoDrive.uploadClipboard(destination), (result) => `已将剪贴板${result.kind}上传为 ${result.name}`);
}
$('pasteButton').onclick = pasteClipboard;
document.addEventListener('paste', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target.isContentEditable || $('filesView').classList.contains('hidden')) return;
  event.preventDefault(); pasteClipboard();
});
$('renameForm').onsubmit = submitRename;
$('renameCancel').onclick = () => { $('renameDialog').close(); renameTarget = null; };
$('renameDialog').addEventListener('cancel', () => { renameTarget = null; });
const dropZone = $('filesView');
function resetDrag() { dragDepth = 0; dropZone.classList.remove('drag-active'); }
for (const eventName of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); event.stopPropagation(); });
}
dropZone.addEventListener('dragenter', () => {
  dragDepth += 1; dropZone.classList.add('drag-active');
  $('dropTitle').textContent = state.uploading ? '正在上传，请稍候' : !state.connected ? '请先连接代码仓' : !state.canUpload ? '当前平台不支持上传' : '上传到根目录';
});
dropZone.addEventListener('dragover', (event) => { if (event.dataTransfer) event.dataTransfer.dropEffect = state.canUpload && state.connected && !state.uploading ? 'copy' : 'none'; });
dropZone.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) resetDrag(); });
dropZone.addEventListener('drop', async (event) => {
  resetDrag();
  if ($('filesView').classList.contains('hidden') || !canStartUpload()) return;
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) { uploadFeedback('未收到可用的本地文件，请从文件管理器拖入文件或文件夹。', true); return; }
  await runUpload(() => {
    const paths = files.map((file) => window.repoDrive.getPathForFile(file));
    if (paths.some((path) => typeof path !== 'string' || !path.trim())) throw new Error('无法读取本地文件路径，请使用上传文件或上传目录按钮。');
    return window.repoDrive.uploadDropped(paths);
  }, (result) => `已上传到根目录，共 ${result.uploaded.length} 个文件（1 个提交）`);
});
// Suppress browser file navigation outside the file view without a second upload handler.
for (const name of ['dragover', 'drop']) document.addEventListener(name, (event) => event.preventDefault());
$('settingsForm').onsubmit = async (event) => { event.preventDefault(); if (state.uploading) { uploadFeedback('正在上传或刷新目录，暂时不能修改连接设置。', true); return; } $('saveButton').disabled = true; $('saveStatus').textContent = '正在测试连接…'; try { const payload = { repository: $('repository').value, branch: $('branch').value, rootPath: $('rootPath').value, token: $('token').value, proxy: $('proxy').value, clearToken: $('clearToken').checked }; const result = await window.repoDrive.saveSettings(payload); state.settings = result.settings; state.selectedPath = ''; state.expanded.clear(); state.selectedItems.clear(); setConnected(true, result.repo.fullName); $('token').value = ''; $('clearToken').checked = false; $('clearTokenRow').classList.toggle('hidden', !result.settings.hasToken); $('token').placeholder = '已安全保存；留空则保持不变'; $('saveStatus').textContent = '连接成功'; showToast('设置已保存，GitHub 连接正常'); showView('files'); renderLocation(); await refreshTree(); } catch (error) { $('saveStatus').textContent = '连接失败'; showToast(errorMessage(error), true); } finally { $('saveButton').disabled = false; } };

init().catch((error) => showToast(errorMessage(error), true));
window.repoDrive.onTransferProgress(showTransfer);

function datedLabel(item, label) {
  const caption = document.createElement('div'); caption.className = 'tree-caption';
  const date = document.createElement('small'); date.className = 'file-date';
  date.textContent = item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
  date.title = '最近上传 / 更新（最后提交时间）'; caption.append(label, date); return caption;
}
