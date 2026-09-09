'use strict';

const $ = (id) => document.getElementById(id);
const state = { currentPath: '', connected: false, canUpload: false, settings: null };
let toastTimer;

function showToast(message, error = false) {
  const el = $('toast'); el.textContent = message; el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function errorMessage(error) { return String(error?.message || error || '操作失败').replace(/^Error invoking remote method '[^']+':\s*(?:[A-Za-z]+Error:\s*)?/, ''); }
function formatSize(bytes) { if (!bytes) return '—'; const units=['B','KB','MB','GB']; const i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),3); return `${(bytes/1024**i).toFixed(i ? 1 : 0)} ${units[i]}`; }
function setConnected(value, name) { state.connected=value; $('statusDot').classList.toggle('online',value); $('repoLabel').textContent=name || state.settings?.repository || '尚未连接'; $('refreshButton').disabled=!value; for(const el of document.querySelectorAll('.upload-action')) el.disabled=!value; }

function showView(name) {
  $('filesView').classList.toggle('hidden', name !== 'files'); $('settingsView').classList.toggle('hidden', name !== 'settings');
  $('filesNav').classList.toggle('active', name === 'files'); $('settingsNav').classList.toggle('active', name === 'settings');
}

function renderBreadcrumbs() {
  const parts = state.currentPath ? state.currentPath.split('/') : [];
  $('breadcrumbs').replaceChildren();
  const root = document.createElement('button'); root.className=`crumb${parts.length ? '' : ' current'}`; root.textContent='根目录'; root.onclick=()=>navigate(''); $('breadcrumbs').append(root);
  parts.forEach((part,index)=>{ const sep=document.createElement('span'); sep.textContent='›'; $('breadcrumbs').append(sep); const button=document.createElement('button'); button.className=`crumb${index===parts.length-1?' current':''}`; button.textContent=part; if(index<parts.length-1) button.onclick=()=>navigate(parts.slice(0,index+1).join('/')); $('breadcrumbs').append(button); });
}

function renderFiles(items) {
  const list=$('fileList'); list.replaceChildren(); $('emptyState').classList.toggle('hidden', items.length > 0 || state.connected);
  if (!items.length && state.connected) { const row=document.createElement('div'); row.className='loading-row'; row.textContent='这个文件夹是空的'; list.append(row); }
  for (const item of items) {
    const row=document.createElement('div'); row.className='file-row';
    const name=document.createElement('div'); name.className='file-name'; const icon=document.createElement('span'); icon.className=`file-icon${item.type==='dir'?' folder':''}`; icon.textContent=item.type==='dir'?'▰':'▤'; const label=document.createElement('span'); label.textContent=item.name; name.append(icon,label); if(item.type==='dir') name.onclick=()=>navigate([...state.currentPath.split('/').filter(Boolean),item.name].join('/'));
    const size=document.createElement('span'); size.className='size'; size.textContent=item.type==='dir'?'文件夹':formatSize(item.size);
    const action=document.createElement('button'); action.className='download-link'; action.textContent='下载'; action.onclick=()=>download(item);
    row.append(name,size,action); list.append(row);
  }
}

async function navigate(next) {
  state.currentPath=next; renderBreadcrumbs(); $('fileList').innerHTML='<div class="loading-row">正在读取…</div>'; $('emptyState').classList.add('hidden');
  try { const items=await window.repoDrive.list(next); renderFiles(items); setConnected(true); } catch(error) { renderFiles([]); setConnected(false); showToast(errorMessage(error),true); }
}

async function download(item) { try { showToast(`正在下载 ${item.name}…`); const result=await window.repoDrive.download({ ...item, path:[state.currentPath,item.name].filter(Boolean).join('/') }); if(!result.canceled) showToast('下载完成，已在文件管理器中显示'); } catch(error){ showToast(errorMessage(error),true); } finally { hideTransfer(); } }

function showTransfer(value) {
  const banner=$('transferBanner'); banner.classList.remove('hidden'); banner.classList.toggle('indeterminate',value.kind==='download');
  $('transferTitle').textContent=value.kind==='upload' ? `正在上传 ${value.completed || 0}/${value.total || 0}` : '正在下载目录';
  $('transferDetail').textContent=value.current || '正在整理文件…';
  $('progressBar').style.width=value.total ? `${Math.round((value.completed || 0)/value.total*100)}%` : '';
}
function hideTransfer(){ $('transferBanner').classList.add('hidden'); }

async function init() {
  const [info, saved]=await Promise.all([window.repoDrive.info(),window.repoDrive.getSettings()]); state.canUpload=info.canUpload; state.settings=saved;
  $('readonlyNotice').classList.toggle('hidden',info.canUpload); $('uploadButton').classList.toggle('hidden',!info.canUpload); $('platformNote').textContent=info.canUpload?`${info.platform === 'linux' ? 'Linux' : 'macOS'} 完整模式 · 可浏览、下载与上传`: 'Windows 只读模式 · 上传在系统层禁用';
  $('uploadFolderButton').classList.toggle('hidden',!info.canUpload); setConnected(false);
  if (!info.canUpload) $('tokenHint').textContent='Windows 只接受 Contents: Read-only 的细粒度 Token；检测到写权限会拒绝连接。';
  for(const id of ['repository','branch','rootPath','proxy']) $(id).value=saved[id]||'';
  $('clearTokenRow').classList.toggle('hidden',!saved.hasToken); if(saved.hasToken) $('token').placeholder='已安全保存；留空则保持不变';
  if(saved.repository) { try { const repo=await window.repoDrive.connect(); setConnected(true,repo.fullName); await navigate(''); } catch(error){ setConnected(false); showToast(errorMessage(error),true); showView('settings'); } }
}

$('filesNav').onclick=()=>showView('files'); $('settingsNav').onclick=()=>showView('settings'); $('setupButton').onclick=()=>showView('settings'); $('refreshButton').onclick=()=>navigate(state.currentPath);
async function upload(kind){ if(!state.canUpload||!state.connected) return; const method=kind==='directory'?'uploadDirectory':'uploadFiles'; try { for(const el of document.querySelectorAll('.upload-action')) el.disabled=true; const result=await window.repoDrive[method](state.currentPath); if(!result.canceled){showToast(kind==='directory'?`目录 ${result.directory} 上传完成，共 ${result.uploaded.length} 个文件`:`已上传 ${result.uploaded.length} 个文件`);await navigate(state.currentPath);} }catch(error){showToast(errorMessage(error),true);}finally{hideTransfer();for(const el of document.querySelectorAll('.upload-action')) el.disabled=!state.connected;} }
$('uploadButton').onclick=()=>upload('files');
$('uploadFolderButton').onclick=()=>upload('directory');
$('settingsForm').onsubmit=async(event)=>{ event.preventDefault(); $('saveButton').disabled=true; $('saveStatus').textContent='正在测试连接…'; try { const payload={repository:$('repository').value,branch:$('branch').value,rootPath:$('rootPath').value,token:$('token').value,proxy:$('proxy').value,clearToken:$('clearToken').checked}; const result=await window.repoDrive.saveSettings(payload); state.settings=result.settings; state.currentPath=''; setConnected(true,result.repo.fullName); $('token').value=''; $('clearToken').checked=false; $('clearTokenRow').classList.toggle('hidden',!result.settings.hasToken); $('token').placeholder='已安全保存；留空则保持不变'; $('saveStatus').textContent='连接成功'; showToast('设置已保存，GitHub 连接正常'); showView('files'); await navigate(''); }catch(error){$('saveStatus').textContent='连接失败';showToast(errorMessage(error),true);}finally{$('saveButton').disabled=false;} };

init().catch((error)=>showToast(errorMessage(error),true));
window.repoDrive.onTransferProgress(showTransfer);
