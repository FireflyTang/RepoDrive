'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { RepositoryMaintenance, registerMaintenance } = require('../src/repository-maintenance');
const { assertWindowsRequest } = require('../platform/windows/windows-request-policy');
const config = { owner: 'owner', repo: 'drive', branch: 'files/main', rootPath: '', token: 'test' };
const head = { commitSha: 'old', treeSha: 'original-tree' };
function fixture(rootPath = '') {
  const calls = [];
  let ref = 'old';
  const c = { ...config, rootPath };
  const service = { async request(path, options = {}) {
    assertWindowsRequest(path, options, c); calls.push({ path, ...options });
    if (path.includes('/git/ref/')) return { object: { sha: ref } };
    if (path.endsWith('/git/trees/original-tree')) return { tree: [ { path: 'folder', mode: '040000', type: 'tree', sha: 'subtree' }, { path: 'keep.txt', mode: '100644', type: 'blob', sha: 'file' } ] };
    if (path.endsWith('/git/trees/subtree')) return { tree: [{ path: 'exec', mode: '100755', type: 'blob', sha: 'file' }] };
    if (options.method === 'POST') return { sha: path.endsWith('/trees') ? 'clean-tree' : 'new-commit' };
    if (options.method === 'PATCH') return {};
    throw new Error(`Unexpected request: ${path}`);
  } };
  return { maintenance: new RepositoryMaintenance(service, c), calls, move: () => { ref = 'someone-else'; } };
}
test('clear all removes existing root entries in one non-force commit, including directories', async () => {
  const f = fixture(); await f.maintenance.clearFiles(head);
  const writes = f.calls.filter((x) => x.method);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[0].body, { base_tree: 'original-tree', tree: [ {path:'folder',mode:'040000',type:'tree',sha:null}, {path:'keep.txt',mode:'100644',type:'blob',sha:null} ] });
  assert.deepEqual(writes[1].body.parents, ['old']);
  assert.deepEqual(writes[2].body, {sha:'new-commit',force:false});
  assert.ok(writes[2].path.endsWith('/heads/files/main'));
});
test('configured root preserves all outside files and existing executable modes', async () => {
  const f = fixture('folder'); await f.maintenance.clearFiles(head);
  assert.deepEqual(f.calls.find(x=>x.path.endsWith('/git/trees')).body.tree, [{path:'folder/exec',mode:'100755',type:'blob',sha:null}]);
});
test('missing configured root is a no-op with no writes', async () => {
  const f = fixture('missing'); assert.deepEqual(await f.maintenance.clearFiles(head), {unchanged:true});
  assert.ok(f.calls.every(x=>!x.method));
});
test('history reset keeps the exact tree and only force-updates the selected branch', async () => {
  const f = fixture('folder'); await f.maintenance.clearHistory(head);
  const writes=f.calls.filter(x=>x.method);
  assert.equal(writes.length,2);
  assert.equal(writes[0].body.tree,'original-tree'); assert.deepEqual(writes[0].body.parents,[]);
  assert.deepEqual(writes[1].body,{sha:'new-commit',force:true});
  assert.ok(writes[1].path.endsWith('/heads/files/main'));
});
test('concurrent changes abort maintenance without writes', async () => {
  for(const method of ['clearFiles','clearHistory']) {
    const f=fixture(); f.move(); await assert.rejects(f.maintenance[method](head),/分支/);
    assert.ok(f.calls.every(x=>!x.method));
  }
});
test('truncated directory responses abort clearing instead of partially deleting', async () => {
  const f=fixture(); const request=f.maintenance.service.request;
  f.maintenance.service.request=async (p,o)=>p.endsWith('/trees/original-tree')?{truncated:true,tree:[]}:request(p,o);
  await assert.rejects(f.maintenance.clearFiles(head),/不完整/);
  assert.ok(f.calls.every(x=>!x.method));
});
test('Windows rejects uploads, content-bearing trees, foreign branches and arbitrary mutations', () => {
  const p='/repos/owner/drive';
  for(const [path,options] of [
    [`${p}/contents/file`,{method:'PUT',body:{content:'data'}}],
    [`${p}/git/blobs`,{method:'POST',body:{content:'data'}}],
    [`${p}/git/trees`,{method:'POST',body:{base_tree:'x',tree:[{path:'file',mode:'100644',type:'blob',sha:null,content:'data'}]}}],
    [`${p}/git/trees`,{method:'POST',body:{base_tree:'x',tree:[{path:'renamed',mode:'100644',type:'blob',sha:'existing'}]}}],
    [`${p}/git/refs/heads/other`,{method:'PATCH',body:{sha:'x',force:true}}],
    [`${p}/git/refs/heads/files/main`,{method:'DELETE'}]
  ]) assert.throws(()=>assertWindowsRequest(path,options,config),/Windows/);
});
test('IPC requires typed repository and confirmation; cancellation cannot mutate', async () => {
  const handlers={};const calls=[];let dialogOptions;
  registerMaintenance({ipcMain:{handle:(name,fn)=>{handlers[name]=fn;}},dialog:{showMessageBox:async (_w,options)=>{dialogOptions=options;return {response:0};}},getWindow:()=>null,getConfig:()=>config,createService:()=>({request:async(p,o)=>{calls.push({p,o});return p.includes('/git/ref/')?{object:{sha:'old'}}:{tree:{sha:'original-tree'}};}})});
  for(const name of ['repo:clearFiles','repo:clearHistory']) {
    await assert.rejects(handlers[name](null,'wrong'),/完整代码仓/);
    assert.deepEqual(await handlers[name](null,'owner/drive'),{canceled:true});
    assert.equal(dialogOptions.cancelId,0);assert.equal(dialogOptions.defaultId,0);
  }
  assert.ok(calls.every(x=>!x.o));
});
test('independent Windows maintenance and date implementations stay aligned', () => {
  for(const file of ['repository-maintenance.js','file-history.js','renderer/maintenance.js']) {
    assert.equal(fs.readFileSync(`src/${file}`,'utf8'),fs.readFileSync(`platform/windows/${file}`,'utf8'));
  }
});

test('branch protection rejection is reported, never reported as success', async () => {
  const f=fixture(); const request=f.maintenance.service.request;
  f.maintenance.service.request=async(p,o)=>{if(o?.method==='PATCH')throw new Error('protected branch');return request(p,o);};
  await assert.rejects(f.maintenance.clearHistory(head),/protected branch/);
});
test('a branch change after commit creation prevents the forced ref update',async()=>{
  const f=fixture();const request=f.maintenance.service.request;
  f.maintenance.service.request=async(p,o)=>{const result=await request(p,o);if(o?.method==='POST')f.move();return result;};
  await assert.rejects(f.maintenance.clearHistory(head),/分支/);
  assert.ok(f.calls.every(x=>x.method!=='PATCH'));
});
test('an already empty root produces no commit',async()=>{
  const f=fixture();const request=f.maintenance.service.request;
  f.maintenance.service.request=async(p,o)=>p.endsWith('/trees/original-tree')?{tree:[]}:request(p,o);
  assert.deepEqual(await f.maintenance.clearFiles(head),{unchanged:true});assert.ok(f.calls.every(x=>!x.method));
});
