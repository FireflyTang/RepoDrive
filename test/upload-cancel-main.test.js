'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

function harness() {
  const handlers = new Map();
  const progress = [];
  let commit;
  const service = { commitChanges: (...args) => commit(...args) };
  const settings = { getPublic: () => ({ repository: 'sample/drive', branch: 'main', rootPath: 'scope', proxy: '' }), getToken: () => 'test-placeholder' };
  const dialog = { showOpenDialog: async () => ({ canceled: true }) };
  const context = {
    Buffer, AbortController, process: { platform: 'linux' }, __dirname: '/mock/src',
    require(name) {
      if (name === 'electron') return {
        app: { whenReady: () => ({ then() {} }), on() {} }, dialog,
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) }
      };
      if (name === 'node:fs/promises') return { stat: async () => ({ size: 5, isDirectory: () => false, isFile: () => true }), readFile: async () => Buffer.from('hello') };
      if (name === './settings-store') return settings;
      if (name === './github-service') return { GitHubService: class { constructor() { return service; } } };
      if (name === './local-gh-auth') return { localGitHubToken: () => '' };
      if (name === './repository-maintenance') return { registerMaintenance() {} };
      if (name.startsWith('./')) return require(path.join(__dirname, '../src', name));
      return require(name);
    }
  };
  vm.runInNewContext(source + '\nmainWindow={webContents:{send:(_channel,value)=>progress.push(value)}};registerIpc();', { ...context, progress });
  return { handlers, progress, service, dialog, setCommit: fn => { commit = fn; } };
}

test('upload cancellation aborts the in-flight operation, blocks concurrent writes, and releases its lock', async () => {
  const h = harness();
  let started;
  const began = new Promise(resolve => { started = resolve; });
  h.setCommit((changes, _message, _progress, { signal }) => {
    assert.equal(changes[0].path, 'scope/alpha.txt');
    started(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const uploading = h.handlers.get('repo:uploadDropped')(null, ['/local/alpha.txt']);
  const signal = await began;
  await assert.rejects(h.handlers.get('repo:uploadDropped')(null, ['/local/beta.txt']), /已有上传/);
  await assert.rejects(h.handlers.get('settings:save')(null, {}), /正在上传/);
  assert.equal(h.progress[0].phase, 'preparing');
  assert.equal(h.handlers.get('repo:cancelUpload')().stopping, true);
  assert.equal(signal.aborted, true);
  await assert.rejects(uploading, error => error.code === 'UPLOAD_CANCELED' && /刷新目录确认/.test(error.message));
  assert.equal(h.handlers.get('repo:cancelUpload')().stopping, false);
  h.setCommit(async () => ({ commitSha: 'committed' }));
  const retry = await h.handlers.get('repo:uploadDropped')(null, ['/local/beta.txt']);
  assert.equal(retry.uploaded[0], 'beta.txt');
  assert.equal(retry.destination, '/');
});

test('canceling the file picker releases upload admission without starting a commit', async () => {
  const h = harness();
  h.setCommit(() => { throw new Error('must not commit'); });
  assert.equal((await h.handlers.get('repo:uploadFiles')(null, '')).canceled, true);
  assert.equal(h.handlers.get('repo:cancelUpload')().stopping, false);
  assert.equal((await h.handlers.get('repo:uploadDirectory')(null, '')).canceled, true);
});
