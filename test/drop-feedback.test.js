'use strict';

// Opt-in real Electron renderer test. All generated files stay in the supplied chat work.
// REPODRIVE_RENDERER_TEST_WORK=/absolute/chat/work node --test test/drop-feedback.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const work = process.env.REPODRIVE_RENDERER_TEST_WORK;

test('real File input + DragEvent feedback, byte progress, serialization and stopping', { skip: !work }, async (t) => {
  const { _electron } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
  const root = path.resolve(__dirname, '..');
  await fs.mkdir(work, { recursive: true });
  const preload = path.join(work, 'drop-preload.cjs');
  const entry = path.join(work, 'drop-entry.cjs');
  const fixture = path.join(work, 'drop-file.txt');
  await fs.writeFile(fixture, 'offline drop fixture');
  await fs.writeFile(preload, `const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('repoDrive',{
 info:()=>Promise.resolve({canUpload:true,platform:'linux'}),
 getSettings:()=>Promise.resolve({repository:'offline/files',branch:'main'}),
 connect:()=>Promise.resolve({fullName:'offline/files'}),
 list:()=>ipcRenderer.invoke('list'),
 uploadDropped:p=>ipcRenderer.invoke('upload','drop',p),
 uploadFiles:p=>ipcRenderer.invoke('upload','files',p),
 uploadDirectory:p=>ipcRenderer.invoke('upload','directory',p),
 uploadClipboard:p=>ipcRenderer.invoke('upload','clipboard',p),
 cancelUpload:()=>ipcRenderer.invoke('cancel'),
 getPathForFile:f=>webUtils.getPathForFile(f),
 saveSettings:()=>ipcRenderer.invoke('save'),
 onTransferProgress:fn=>ipcRenderer.on('progress',(_,v)=>fn(v))
});`);
  await fs.writeFile(entry, `const {app,BrowserWindow,ipcMain,session}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(work, 'profile'))});
global.control={calls:[],holdList:false,cancels:0};
ipcMain.handle('list',()=>{if(global.control.listError) throw Error('offline refresh failure');return global.control.holdList?new Promise(r=>global.control.releaseList=()=>r([])):[];});
ipcMain.handle('upload',(_,kind,payload)=>{global.control.calls.push({kind,payload});return new Promise((resolve,reject)=>{global.control.resolve=resolve;global.control.reject=reject;});});
ipcMain.handle('cancel',()=>{global.control.cancels++;return {canceled:true};});
ipcMain.handle('save',()=>{throw Error('Settings must not be saved while uploading');});
app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true}));global.win=new BrowserWindow({width:1280,height:900,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true}});win.loadFile(${JSON.stringify(path.join(root, 'src/renderer/index.html'))});});`);
  const app = await _electron.launch({ executablePath: process.env.ELECTRON_PATH || require('electron'), args: [entry] });
  try {
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForFunction(() => document.querySelector('#statusDot').classList.contains('online'));
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'testFile'; document.body.append(input); });
    await page.locator('#testFile').setInputFiles(fixture);
    const drop = (selector = '#dropZone', empty = false) => page.evaluate(({selector,empty}) => {
      const dt = new DataTransfer();
      if (!empty) dt.items.add(document.querySelector('#testFile').files[0]);
      document.querySelector(selector).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, {selector,empty});
    const status = () => page.locator('#uploadStatus').textContent();
    const progress = (v) => app.evaluate((_, v) => global.win.webContents.send('progress', {kind:'upload',...v}), v);
    const settle = (error) => app.evaluate((_, error) => error ? global.control.reject(Error(error)) : global.control.resolve({uploaded:['drop-file.txt']}), error);
    const idle = () => page.waitForFunction(() => !state.uploading);
    const calls = () => app.evaluate(() => global.control.calls);

    await t.test('unconnected, empty and settings-page drops give safe behavior', async () => {
      await page.evaluate(() => setConnected(false)); await drop();
      assert.match(await status(), /尚未连接/);
      await page.evaluate(() => setConnected(true)); await drop('#dropZone', true);
      assert.match(await status(), /未收到可用/);
      await page.locator('#settingsNav').click(); await drop('#settingsView');
      assert.equal((await calls()).length, 0);
      await page.locator('#filesNav').click();
    });
    await t.test('blank-area drop uses a real File once and starts indeterminate immediately', async () => {
      const bounds = await page.locator('#dropZone').boundingBox();
      const target = await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.id, {x:bounds.x+30,y:bounds.y+bounds.height-20});
      assert.equal(target,'dropZone');
      await drop();
      await page.waitForFunction(() => state.uploading);
      assert.deepEqual((await calls())[0], {kind:'drop',payload:[fixture]});
      assert.match(await page.locator('#transferTitle').textContent(), /准备.*扫描/);
      assert.equal(await page.locator('#transferBanner').evaluate(el=>el.classList.contains('indeterminate')), true);
      assert.equal(await page.locator('#saveButton').isDisabled(), true);
      await page.evaluate(() => document.querySelector('#settingsForm').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})));
      await drop();
      await page.evaluate(() => { upload('files'); pasteClipboard(); document.dispatchEvent(new Event('paste', {bubbles:true,cancelable:true})); });
      assert.equal((await calls()).length, 1);
      assert.match(await status(), /等待/);
    });
    await t.test('request-body bytes remain distinct from commit success and unknown progress', async () => {
      await progress({phase:'uploading',transferredBytes:41943040,totalBytes:83886080,current:'large.bin',completed:0,total:1});
      await page.waitForFunction(() => document.querySelector('#transferDetail').textContent.includes('已发送 40.00 MiB / 80.00 MiB'));
      assert.match(await page.locator('#transferDetail').textContent(), /50%.*传输数据含编码开销/);
      assert.equal(await page.locator('#transferTitle').textContent(), '正在发送文件…');
      assert.doesNotMatch(await page.locator('#transferDetail').textContent(), /请求体/);
      await progress({phase:'uploading',transferredBytes:83886080,totalBytes:83886080});
      await page.waitForFunction(() => document.querySelector('#transferDetail').textContent.includes('发送完成，等待GitHub确认'));
      assert.doesNotMatch(await status(), /上传完成/);
      await progress({phase:'committing',transferredBytes:1024,totalBytes:1024});
      await page.waitForFunction(() => document.querySelector('#transferTitle').textContent.includes('创建 GitHub'));
      assert.equal(await page.locator('#progressTrack').getAttribute('aria-valuenow'), null);
      await progress({phase:'uploading',completed:0,total:1});
      await page.waitForFunction(() => document.querySelector('#transferDetail').textContent.includes('尚未确定'));
    });
    await t.test('Git progress is verbatim and never invents HTTP bytes or completion', async () => {
      const line = 'Writing objects: 100% (4/4), 55.00 MiB | 2.00 MiB/s, done.';
      await progress({phase:'uploading',gitProgress:line});
      await page.waitForFunction(line => document.querySelector('#transferDetail').textContent.includes(line),line);
      assert.match(await page.locator('#transferDetail').textContent(), /等待远端确认/);
      assert.equal(await page.locator('#progressTrack').getAttribute('aria-valuenow'),null);
      assert.doesNotMatch(await page.locator('#transferDetail').textContent(),/请求体/);
      await page.screenshot({path:path.join(work,'git-progress.png')});
    });
    await t.test('busy lasts through refresh, then a persistent completion is shown', async () => {
      await app.evaluate(() => {global.control.holdList=true;}); await settle();
      await page.waitForFunction(() => state.refreshingUpload);
      assert.equal(await page.locator('#uploadButton').isDisabled(), true);
      assert.equal(await page.locator('#saveButton').isDisabled(), true);
      await drop(); assert.equal((await calls()).length, 1);
      await app.evaluate(() => {global.control.holdList=false;global.control.releaseList();});
      await idle(); assert.match(await status(), /已上传到根目录/);
    });
    await t.test('errors stay visible after the toast expires', async () => {
      await drop(); await settle('offline failure'); await idle();
      await page.waitForTimeout(3400);
      assert.equal(await page.locator('#uploadStatus').isVisible(), true);
      assert.match(await status(), /上传失败：offline failure/);
      // A synthetic File without a native path must not invoke IPC.
      const before=(await calls()).length;
      await page.evaluate(() => {const dt=new DataTransfer();dt.items.add(new File(['x'],'virtual.txt'));document.querySelector('#dropZone').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));});
      await idle(); assert.equal((await calls()).length,before);
      assert.match(await status(), /无法读取本地文件路径/);
    });
    await t.test('stop waits for promise settlement and warns about possibly committed requests', async () => {
      await page.locator('#uploadButton').click();
      await page.locator('#stopUploadButton').click();
      assert.match(await status(), /正在停止/);
      assert.equal(await page.locator('#uploadButton').isDisabled(),true);
      await progress({phase:'committing'});
      assert.match(await page.locator('#transferTitle').textContent(), /正在停止/);
      await settle('用户取消上传'); await idle();
      assert.match(await status(), /用户已取消.*可能已经提交.*刷新/);
      assert.equal(await app.evaluate(()=>global.control.cancels),1);
      await page.locator('#pasteButton').click();
      await page.locator('#stopUploadButton').click(); await settle(); await idle();
      assert.match(await status(), /上传已完成；停止请求到达时提交已生效/);
      assert.doesNotMatch(await status(), /可能/);
      assert.equal(await page.locator('#saveButton').isDisabled(),false);
    });
    await t.test('confirmed upload stays confirmed if refresh fails after stopping', async () => {
      await page.locator('#uploadButton').click();
      await page.locator('#stopUploadButton').click();
      await app.evaluate(() => {global.control.listError=true;});
      await settle(); await idle();
      assert.match(await status(), /上传已完成；停止请求到达时提交已生效.*目录刷新失败/);
      assert.doesNotMatch(await status(), /可能|尚未确认/);
    });
    await page.screenshot({path:path.join(work,'drop-feedback.png')});
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});
