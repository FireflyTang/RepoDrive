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
function register(){
  ipcMain.handle('settings:get',()=>settings.publicSettings());
  ipcMain.handle('settings:save',async(_event,form)=>{const previous={...config()};const parsed=parseRepository(form.repository);const candidate={repository:`${parsed.owner}/${parsed.repo}`,branch:validateBranch(form.branch),rootPath:normalizeRepoPath(form.rootPath),proxy:validateProxy(form.proxy),token:String(form.token||'').trim()||(form.clearToken?'':settings.token()),clearToken:Boolean(form.clearToken),...parsed};runtime=candidate;try{await applyProxy(candidate.proxy);const repo=await github.validateRepository();const stored=settings.save(candidate);runtime={...stored,...parsed,token:candidate.token};return{settings:stored,repo};}catch(error){runtime=previous;await applyProxy(previous.proxy).catch(()=>{});throw error;}});
  ipcMain.handle('repo:connect',async()=>{const c=config();if(!c.owner||!c.repo)throw new Error('请先配置代码仓。');await applyProxy(c.proxy);return github.validateRepository();});
  ipcMain.handle('repo:list',(_event,remotePath)=>github.list(scoped(remotePath)));
  ipcMain.handle('repo:download',async(_event,item)=>{const remotePath=scoped(item.path);if(item.type==='dir'){const result=await dialog.showOpenDialog(window,{title:'选择下载位置',properties:['openDirectory','createDirectory']});if(result.canceled)return{canceled:true};const target=path.join(result.filePaths[0],item.name);await downloadTree(remotePath,target);shell.showItemInFolder(target);return{path:target};}const result=await dialog.showSaveDialog(window,{title:'保存文件',defaultPath:item.name});if(result.canceled||!result.filePath)return{canceled:true};await fs.writeFile(result.filePath,await github.readFile(remotePath));shell.showItemInFolder(result.filePath);return{path:result.filePath};});
}
function createWindow(){window=new BrowserWindow({width:1120,height:720,minWidth:860,minHeight:560,backgroundColor:'#f4f6fa',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});window.loadFile(path.join(__dirname,'renderer','index.html'));}
app.whenReady().then(async()=>{register();try{await applyProxy(config().proxy);}catch{}createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on('window-all-closed',()=>app.quit());
