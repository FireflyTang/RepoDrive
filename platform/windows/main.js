'use strict';

const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const settings = require('./settings-store');
const { GitHubReadService } = require('./github-read-service');
const { normalizeRepoPath, parseRepository, validateBranch, validateProxy } = require('./validation');

let window; let runtime;
function config(){if(!runtime){const saved=settings.publicSettings();const parsed=saved.repository?parseRepository(saved.repository):{owner:'',repo:''};runtime={...saved,...parsed,token:settings.token()};}return runtime;}
const github=new GitHubReadService(config);
async function applyProxy(proxy){await session.defaultSession.setProxy(proxy?{proxyRules:proxy}:{mode:'direct'});await session.defaultSession.closeAllConnections();}
function scoped(remotePath=''){return[normalizeRepoPath(config().rootPath),normalizeRepoPath(remotePath)].filter(Boolean).join('/');}
async function downloadTree(remotePath,destination){const items=await github.list(remotePath);await fs.mkdir(destination,{recursive:true});for(const item of items){const target=path.join(destination,item.name);if(item.type==='dir')await downloadTree(item.path,target);else{window?.webContents.send('download:progress',{current:item.path});await fs.writeFile(target,await github.readFile(item.path));}}}
async function deleteTree(remotePath){const items=await github.list(remotePath);let deleted=0;for(const item of items){if(item.type==='dir')deleted+=await deleteTree(item.path);else{window?.webContents.send('download:progress',{kind:'delete',current:item.path});await github.deleteFile(item.path,item.sha);deleted+=1;}}return deleted;}
function register(){
  ipcMain.handle('settings:get',()=>settings.publicSettings());
  ipcMain.handle('settings:save',async(_event,form)=>{const previous={...config()};const parsed=parseRepository(form.repository);const candidate={repository:`${parsed.owner}/${parsed.repo}`,branch:validateBranch(form.branch),rootPath:normalizeRepoPath(form.rootPath),proxy:validateProxy(form.proxy),token:String(form.token||'').trim()||(form.clearToken?'':settings.token()),clearToken:Boolean(form.clearToken),...parsed};runtime=candidate;try{await applyProxy(candidate.proxy);const repo=await github.validateRepository();const stored=settings.save(candidate);runtime={...stored,...parsed,token:candidate.token};return{settings:stored,repo};}catch(error){runtime=previous;await applyProxy(previous.proxy).catch(()=>{});throw error;}});
  ipcMain.handle('repo:connect',async()=>{const c=config();if(!c.owner||!c.repo)throw new Error('请先配置代码仓。');await applyProxy(c.proxy);return github.validateRepository();});
  ipcMain.handle('repo:list',(_event,remotePath)=>github.list(scoped(remotePath)));
  ipcMain.handle('repo:download',async(_event,item)=>{const remotePath=scoped(item.path);if(item.type==='dir'){const result=await dialog.showOpenDialog(window,{title:'选择下载位置',properties:['openDirectory','createDirectory']});if(result.canceled)return{canceled:true};const target=path.join(result.filePaths[0],item.name);await downloadTree(remotePath,target);shell.showItemInFolder(target);return{path:target};}const result=await dialog.showSaveDialog(window,{title:'保存文件',defaultPath:item.name});if(result.canceled||!result.filePath)return{canceled:true};await fs.writeFile(result.filePath,await github.readFile(remotePath));shell.showItemInFolder(result.filePath);return{path:result.filePath};});
  ipcMain.handle('repo:delete',async(_event,item)=>{const confirmation=await dialog.showMessageBox(window,{type:'warning',buttons:['取消','删除'],defaultId:0,cancelId:0,title:'确认删除',message:`确定要删除“${item.name}”吗？`,detail:item.type==='dir'?'目录中的所有文件都会从 GitHub 仓库删除，并产生多个提交。Windows 版仍然不具备任何上传功能。':'文件会从 GitHub 仓库删除并产生一个提交。Windows 版仍然不具备任何上传功能。'});if(confirmation.response!==1)return{canceled:true,deleted:0};if(!config().token)throw new Error('删除需要 Contents: Read and write 权限的 GitHub Token。');const remotePath=scoped(item.path);const deleted=item.type==='dir'?await deleteTree(remotePath):(await github.deleteFile(remotePath,item.sha),1);return{canceled:false,deleted};});
}
function createWindow(){window=new BrowserWindow({width:1120,height:720,minWidth:860,minHeight:560,backgroundColor:'#f4f6fa',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});window.loadFile(path.join(__dirname,'renderer','index.html'));}
app.whenReady().then(async()=>{register();try{await applyProxy(config().proxy);}catch{}createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on('window-all-closed',()=>app.quit());
