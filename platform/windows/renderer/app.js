'use strict';

const $ = (id) => document.getElementById(id);
const state = { connected: false, settings: null, tree: new Map(), expanded: new Set(), loading: new Set() };
let timer;

function message(error) { return String(error?.message || error || '操作失败').replace(/^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/, ''); }
function toast(text, error = false) { $('toast').textContent = text; $('toast').className = `toast show${error ? ' error' : ''}`; clearTimeout(timer); timer = setTimeout(() => { $('toast').className = 'toast'; }, 3000); }
function size(bytes) { if (!bytes) return '—'; const units = ['B', 'KB', 'MB', 'GB']; const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3); return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`; }
function joinPath(...parts) { return parts.filter(Boolean).join('/'); }

function icon(kind) {
  const paths = { folder: 'M3 5.5h6l2 2h10v11H3z', file: 'M6 2.5h8l4 4v15H6z M14 2.5v5h4', download: 'M12 3v12m-4-4 4 4 4-4M5 20h14', trash: 'M4 7h16M9 7V4h6v3m-8 0 1 14h8l1-14', chevron: 'M9 5l6 7-6 7' };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('ui-icon', `icon-${kind}`);
  for (const segment of paths[kind].split(' M')) { const child = document.createElementNS('http://www.w3.org/2000/svg', 'path'); child.setAttribute('d', segment.startsWith('M') ? segment : `M${segment}`); svg.append(child); }
  return svg;
}

function connected(value, name) { state.connected = value; $('dot').classList.toggle('online', value); $('repoLabel').textContent = name || state.settings?.repository || '尚未连接'; $('refresh').disabled = !value; }
function view(name) { $('filesView').classList.toggle('hidden', name !== 'files'); $('settingsView').classList.toggle('hidden', name !== 'settings'); $('filesNav').classList.toggle('active', name === 'files'); $('settingsNav').classList.toggle('active', name === 'settings'); }

async function loadDirectory(remotePath) {
  state.loading.add(remotePath); renderTree();
  try { const items = await window.repoDrive.list(remotePath); state.tree.set(remotePath, items.map((item) => ({ ...item, uiPath: joinPath(remotePath, item.name) }))); }
  finally { state.loading.delete(remotePath); }
}

async function toggleDirectory(item) {
  if (state.expanded.has(item.uiPath)) state.expanded.delete(item.uiPath);
  else { state.expanded.add(item.uiPath); if (!state.tree.has(item.uiPath)) await loadDirectory(item.uiPath); }
  renderTree();
}

function actionButton(kind, label, handler, danger = false) {
  const button = document.createElement('button'); button.className = `tree-action${danger ? ' danger' : ''}`; button.title = label; button.setAttribute('aria-label', label); button.append(icon(kind), document.createTextNode(label)); button.onclick = handler; return button;
}

function appendNodes(parentPath, depth, fragment) {
  for (const item of state.tree.get(parentPath) || []) {
    const row = document.createElement('div'); row.className = 'item'; row.style.setProperty('--depth', depth);
    const main = document.createElement('div'); main.className = 'tree-main';
    const toggle = document.createElement('button'); toggle.className = `tree-toggle${state.expanded.has(item.uiPath) ? ' expanded' : ''}`; toggle.setAttribute('aria-label', item.type === 'dir' ? '展开或折叠' : '文件');
    if (item.type === 'dir') { toggle.append(icon('chevron')); toggle.onclick = () => toggleDirectory(item); } else toggle.disabled = true;
    const itemIcon = icon(item.type === 'dir' ? 'folder' : 'file'); itemIcon.classList.add('tree-kind');
    const label = document.createElement(item.type === 'dir' ? 'button' : 'span'); label.className = 'tree-label'; label.textContent = item.name; if (item.type === 'dir') label.onclick = () => toggleDirectory(item);
    main.append(toggle, itemIcon, label);
    const itemSize = document.createElement('span'); itemSize.textContent = item.type === 'dir' ? '文件夹' : size(item.size);
    const actions = document.createElement('span'); actions.className = 'actions'; actions.append(actionButton('download', '下载', () => download(item)), actionButton('trash', '删除', () => remove(item), true));
    row.append(main, itemSize, actions); fragment.append(row);
    if (item.type === 'dir' && state.expanded.has(item.uiPath)) {
      if (state.loading.has(item.uiPath)) { const loading = document.createElement('div'); loading.className = 'tree-loading'; loading.style.setProperty('--depth', depth + 1); loading.textContent = '正在读取…'; fragment.append(loading); }
      else appendNodes(item.uiPath, depth + 1, fragment);
    }
  }
}

function renderTree() {
  const fragment = document.createDocumentFragment(); appendNodes('', 0, fragment); $('list').replaceChildren(fragment);
  const rootItems = state.tree.get('') || []; $('empty').classList.toggle('hidden', state.connected || rootItems.length > 0);
  if (state.connected && !rootItems.length && !state.loading.has('')) { const empty = document.createElement('div'); empty.className = 'empty tree-empty'; empty.textContent = '这个文件盘是空的'; $('list').append(empty); }
}

async function refreshTree() {
  const expanded = [...state.expanded].sort((a, b) => a.split('/').length - b.split('/').length); state.tree.clear();
  try { await loadDirectory(''); for (const remotePath of expanded) { try { await loadDirectory(remotePath); } catch { state.expanded.delete(remotePath); } } connected(true); renderTree(); }
  catch (error) { connected(false); state.tree.clear(); renderTree(); toast(message(error), true); }
}

async function download(item) { try { $('progress').classList.remove('hidden'); const result = await window.repoDrive.download({ ...item, path: item.uiPath }); if (!result.canceled) toast('下载完成，已在文件管理器中显示'); } catch (error) { toast(message(error), true); } finally { $('progress').classList.add('hidden'); } }
async function remove(item) { try { const result = await window.repoDrive.delete({ ...item, path: item.uiPath }); if (!result.canceled) { for (const expandedPath of [...state.expanded]) if (expandedPath === item.uiPath || expandedPath.startsWith(`${item.uiPath}/`)) state.expanded.delete(expandedPath); toast(`删除完成，共删除 ${result.deleted} 个文件`); await refreshTree(); } } catch (error) { toast(message(error), true); } finally { $('progress').classList.add('hidden'); } }

async function init() {
  const saved = await window.repoDrive.getSettings(); state.settings = saved; for (const id of ['repository', 'branch', 'rootPath', 'proxy']) $(id).value = saved[id] || '';
  $('clearRow').classList.toggle('hidden', !saved.hasToken); connected(false);
  if (saved.repository) { try { const repo = await window.repoDrive.connect(); connected(true, repo.fullName); await refreshTree(); } catch (error) { toast(message(error), true); view('settings'); } }
}

$('filesNav').onclick = () => view('files'); $('settingsNav').onclick = () => view('settings'); $('setup').onclick = () => view('settings'); $('refresh').onclick = refreshTree;
window.repoDrive.onProgress((value) => { $('progress').classList.remove('hidden'); $('progressLabel').textContent = value.kind === 'delete' ? '正在删除' : '正在下载'; $('progressPath').textContent = value.current || ''; });
$('form').onsubmit = async (event) => { event.preventDefault(); $('status').textContent = '正在测试…'; try { const result = await window.repoDrive.saveSettings({ repository: $('repository').value, branch: $('branch').value, rootPath: $('rootPath').value, proxy: $('proxy').value, token: $('token').value, clearToken: $('clearToken').checked }); state.settings = result.settings; state.expanded.clear(); connected(true, result.repo.fullName); $('status').textContent = '连接成功'; view('files'); await refreshTree(); } catch (error) { $('status').textContent = '连接失败'; toast(message(error), true); } };

init().catch((error) => toast(message(error), true));
