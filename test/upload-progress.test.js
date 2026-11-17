'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

function serviceWith(net = {}) {
  const load = Module._load;
  const session = { defaultSession: { mock: true } };
  try {
    Module._load = function (name, ...args) {
      return name === 'electron' ? { net, session } : load.call(this, name, ...args);
    };
    delete require.cache[require.resolve('../src/github-service')];
    const { GitHubService } = require('../src/github-service');
    return { service: new GitHubService(() => ({ owner: 'mock', repo: 'mock', branch: 'files/main', token: 'mock-token' })), session };
  } finally { Module._load = load; }
}

function commitFixture(handler) {
  const { service } = serviceWith();
  const calls = [];
  service.request = async (path, options = {}) => {
    calls.push({ path, options });
    await handler?.(path, options);
    if (path.includes('/git/ref/')) return { object: { sha: 'old' } };
    if (path.endsWith('/git/commits/old')) return { tree: { sha: 'old-tree' } };
    return { sha: path.endsWith('/blobs') ? 'blob' : path.endsWith('/trees') ? 'new-tree' : 'new-commit' };
  };
  return { service, calls };
}

test('all commit stages report immediately; actual bytes aggregate across blobs and deletion', async () => {
  const events = [];
  const controller = new AbortController();
  let blobs = 0;
  const f = commitFixture((path, options) => {
    if (path.includes('/git/ref/')) assert.equal(events[0].phase, 'preparing');
    if (path.endsWith('/blobs')) {
      assert.equal(events.at(-1).phase, 'uploading');
      assert.equal(events.at(-1).current, blobs === 0 ? 'first' : 'second');
      const total = Buffer.byteLength(JSON.stringify(options.body));
      options.onUploadProgress({ sent: 10, total });
      assert.equal(events.at(-1).completed, blobs);
      options.onUploadProgress({ sent: total, total });
      blobs += 1;
    }
    if (options.method && ['/trees', '/commits', '/heads/files/main'].some((suffix) => path.endsWith(suffix))) {
      assert.equal(events.at(-1).phase, 'committing');
    }
  });
  const result = await f.service.commitChanges([
    { path: 'first', bytes: Buffer.from('abc') }, { path: 'second', bytes: Buffer.from('xy') }, { path: 'gone', delete: true }
  ], 'message', (p) => events.push(p), { signal: controller.signal });
  assert.deepEqual(result, { commitSha: 'new-commit', changed: 3 });
  assert.deepEqual(events[0], { phase: 'preparing', current: '', completed: 0, total: 3, transferredBytes: 0, totalBytes: 76 });
  assert.equal(events.at(-1).transferredBytes, 76);
  assert.equal(events.at(-1).completed, 3);
  assert.ok(events.some((p) => p.current === 'second' && p.transferredBytes === 48));
  for (const { options } of f.calls) {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.timeoutMs, 0);
  }
});

test('legacy request overrides with no byte callback still work, without fabricated sent bytes', async () => {
  const f = commitFixture();
  const progress = [];
  await f.service.commitChanges([{ path: 'file', bytes: Buffer.from('x') }], 'message', (p) => progress.push(p));
  assert.equal(progress.at(-1).completed, 1);
  assert.equal(progress.at(-1).transferredBytes, 0);
  assert.ok(progress.some((p) => p.phase === 'committing'));
});

test('100% sent followed by HTTP failure never creates a tree/commit/ref update', async () => {
  const progress = [];
  const f = commitFixture((path, options) => {
    if (path.endsWith('/blobs')) {
      options.onUploadProgress({ sent: 38, total: 38 });
      throw Object.assign(new Error('HTTP 422: rejected'), { status: 422 });
    }
  });
  await assert.rejects(f.service.commitChanges([{ path: 'file', bytes: Buffer.from('x') }], 'message', (p) => progress.push(p)), /422/);
  assert.equal(progress.at(-1).transferredBytes, progress.at(-1).totalBytes);
  assert.equal(progress.at(-1).completed, 0);
  assert.ok(progress.every((p) => p.phase !== 'committing'));
  assert.equal(f.calls.length, 3);
});

test('cancellation before branch PATCH prevents the ref update even with a request override', async () => {
  const controller = new AbortController();
  const f = commitFixture((path) => { if (path.endsWith('/git/commits')) controller.abort(); });
  await assert.rejects(f.service.commitChanges([{ path: 'gone', delete: true }], 'message', undefined, { signal: controller.signal }), { name: 'AbortError', code: 'UPLOAD_CANCELED' });
  assert.ok(f.calls.every(({ options }) => options.method !== 'PATCH'));
});

test('already canceled commit creates no metadata requests', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = commitFixture();
  await assert.rejects(f.service.commitChanges([{ path: 'gone', delete: true }], 'message', undefined, { signal: controller.signal }), { code: 'UPLOAD_CANCELED' });
  assert.equal(f.calls.length, 0);
});

test('20 MiB boundary and the reported 57685062-byte archive delegate lazily to git transport', async () => {
  for (const size of [20 * 1024 * 1024, 57685062]) {
    const { service } = serviceWith();
    service.request = () => { assert.fail('large file must bypass REST'); };
    const controller = new AbortController();
    const bytes = Buffer.alloc(size);
    const onProgress = () => {};
    const originalLoad = Module._load;
    let delegated = 0;
    try {
      Module._load = function (name, ...args) {
        if (name === './git-upload') return { commitViaGit: async (config, changes, message, callback, options) => {
          delegated += 1;
          assert.equal(config.owner, 'mock');
          assert.equal(changes[0].path, 'folder/archive.zip');
          assert.equal(changes[0].bytes, bytes);
          assert.equal(message, 'upload');
          assert.equal(callback, onProgress);
          assert.equal(options.signal, controller.signal);
          return { commitSha: 'git-sha', changed: 1 };
        } };
        return originalLoad.call(this, name, ...args);
      };
      assert.deepEqual(await service.commitChanges([{ path: '/folder/archive.zip', bytes }], 'upload', onProgress, { signal: controller.signal }), { commitSha: 'git-sha', changed: 1 });
      assert.equal(delegated, 1);
    } finally { Module._load = originalLoad; }
  }
});

test('just below 20 MiB continues through REST without loading git transport', async () => {
  const f = commitFixture();
  const originalLoad = Module._load;
  try {
    Module._load = function (name, ...args) {
      assert.notEqual(name, './git-upload');
      return originalLoad.call(this, name, ...args);
    };
    await f.service.commitChanges([{ path: 'file', bytes: Buffer.alloc(20 * 1024 * 1024 - 1) }], 'upload');
    assert.ok(f.calls.some(({ path }) => path.endsWith('/blobs')));
  } finally { Module._load = originalLoad; }
});

test('ordinary metadata keeps 30s timeout; timeoutMs:0 passes only the caller signal', async (t) => {
  const timeouts = [];
  const realTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms) => { timeouts.push(ms); return realTimeout(ms); });
  const calls = [];
  const { service } = serviceWith({ fetch: async (_url, options) => { calls.push(options); return { ok: true, json: async () => ({}) }; } });
  const controller = new AbortController();
  await service.request('/metadata');
  await service.request('/upload-metadata', { timeoutMs: 0, signal: controller.signal });
  await service.request('/metadata', { signal: controller.signal });
  assert.deepEqual(timeouts, [30000, 30000]);
  assert.equal(calls[1].signal, controller.signal);
  assert.notEqual(calls[2].signal, controller.signal);
  controller.abort();
  assert.equal(calls[2].signal.aborted, true);
});

test('fetch cancellation propagates as AbortError/UPLOAD_CANCELED', async () => {
  const controller = new AbortController();
  const { service } = serviceWith({ fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) });
  const promise = service.request('/metadata', { timeoutMs: 0, signal: controller.signal });
  const rejected = assert.rejects(promise, { name: 'AbortError', code: 'UPLOAD_CANCELED' });
  controller.abort();
  await rejected;
});

test('metadata HTTP errors preserve server message and errors without request credentials/body', async () => {
  const { service } = serviceWith({ fetch: async () => ({ ok: false, status: 422, text: async () => JSON.stringify({ message: 'Validation Failed', errors: [{ resource: 'Commit', code: 'invalid' }] }) }) });
  await assert.rejects(service.request('/git/commits', { method: 'POST', body: { content: 'PRIVATE-CONTENT' } }), (error) => {
    assert.equal(error.status, 422);
    assert.match(error.message, /提交内容不符合 GitHub 要求.*Validation Failed.*errors:.*Commit.*invalid/);
    assert.doesNotMatch(error.message, /mock-token|PRIVATE-CONTENT/);
    return true;
  });
});

test('service routes blobs through net.request with default session; metadata alone uses fetch', async () => {
  const req = new EventEmitter();
  let requestOptions;
  let fetched = 0;
  const headers = {};
  req.setHeader = (name, value) => { headers[name] = value; };
  req.abort = () => req.emit('close');
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = 201;
    req.emit('upload-progress', {}, 38, 38);
    req.emit('response', res);
    res.emit('data', Buffer.from('{"sha":"blob"}'));
    res.emit('end');
    req.emit('close');
  };
  const { service, session } = serviceWith({
    request: (options) => { requestOptions = options; return req; },
    fetch: async () => { fetched += 1; return { ok: true, json: async () => ({}) }; }
  });
  const progress = [];
  assert.deepEqual(await service.request('/repos/mock/mock/git/blobs', { method: 'POST', body: { content: 'eA==', encoding: 'base64' }, onUploadProgress: (p) => progress.push(p) }), { sha: 'blob' });
  assert.equal(fetched, 0);
  assert.equal(requestOptions.session, session.defaultSession);
  assert.equal(headers.Authorization, 'Bearer mock-token');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.deepEqual(progress, [{ sent: 38, total: 38 }]);
  await service.request('/metadata');
  assert.equal(fetched, 1);
});
