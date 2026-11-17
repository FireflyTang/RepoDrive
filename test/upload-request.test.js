'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { uploadRequest } = require('../src/upload-request');

function assertCleanTransport(transport) {
  // Only the shared, state-free late-error guard remains. It must also survive
  // errors after close/settlement, without retaining body, timers or callbacks.
  assert.deepEqual(transport.eventNames(), ['error']);
  assert.equal(transport.listenerCount('error'), 1);
  assert.equal(transport.listeners('error')[0].name, 'ignoreLateError');
  transport.emit('error', new Error('late native error after cleanup'));
}

function fixture(options = {}) {
  const request = new EventEmitter();
  request.abortCalls = 0;
  request.headers = {};
  request.setHeader = (name, value) => { request.headers[name] = value; };
  request.end = (body) => { request.body = body; request.emit('finish'); };
  request.abort = () => {
    request.abortCalls += 1;
    request.emit('abort');
    request.response?.emit('aborted');
    request.emit('error', new Error('late abort error'));
    request.emit('close');
  };
  request.progress = { active: true, started: false, current: 0, total: 0 };
  request.getUploadProgress = () => request.progress;
  const calls = [];
  const progress = [];
  const session = { name: 'mock default session' };
  const controller = new AbortController();
  const promise = uploadRequest({ request: (config) => { calls.push(config); return request; } }, 'https://example.invalid/blob', {
    body: '{"content":"YWJj","encoding":"base64"}',
    headers: { Authorization: 'Bearer mock-only', 'Content-Type': 'application/json' },
    session, signal: controller.signal, onUploadProgress: (p) => progress.push(p), ...options
  });
  const respond = (status = 201, body = '{"sha":"blob"}') => {
    const response = new EventEmitter();
    response.statusCode = status;
    request.response = response;
    request.emit('response', response);
    if (body !== null) {
      const bytes = Buffer.from(body);
      response.emit('data', bytes.subarray(0, 5));
      response.emit('data', bytes.subarray(5));
      response.emit('end');
      response.emit('close');
      request.emit('close');
    }
    return response;
  };
  return { request, calls, promise, progress, session, controller, respond };
}

test('uses the supplied session, rejects redirects/replays and forwards real byte events', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].session, f.session);
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].redirect, 'error');
  assert.equal(f.calls[0].headers, undefined);
  assert.equal(f.request.headers.Authorization, 'Bearer mock-only');
  assert.equal(f.request.headers['Content-Type'], 'application/json');
  assert.equal(f.request.body, '{"content":"YWJj","encoding":"base64"}');
  assert.deepEqual(f.progress, []); // finish is buffering, not bytes sent.
  f.request.emit('upload-progress', {}, 13, 38);
  f.request.emit('upload-progress', {}, 38, 38);
  f.request.emit('upload-progress', {}, 38, 38);
  f.request.emit('upload-progress', {}, 12, 38);
  assert.deepEqual(f.progress, [{ sent: 13, total: 38 }, { sent: 38, total: 38 }]);
  let resolved = false;
  f.promise.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false); // 100% uploaded is not an HTTP success.
  f.respond();
  assert.deepEqual(await f.promise, { sha: 'blob' });
  assert.equal(f.request.abortCalls, 0);
  assertCleanTransport(f.request);
  assert.deepEqual(getEventListeners(f.controller.signal, 'abort'), []);
});

test('Electron 38 progress polling works, and no 30s/10min automatic deadline exists', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture();
  t.mock.timers.tick(30001);
  assert.deepEqual(f.progress, []);
  f.request.progress = { active: true, started: true, current: 1000, total: 9000 };
  t.mock.timers.tick(200);
  assert.deepEqual(f.progress, [{ sent: 1000, total: 9000 }]);
  t.mock.timers.tick(600000);
  assert.equal(f.request.abortCalls, 0);
  f.request.progress = { active: true, started: true, current: 9000, total: 9000 };
  f.respond();
  await f.promise;
  assert.deepEqual(f.progress.at(-1), { sent: 9000, total: 9000 });
  f.request.getUploadProgress = () => { assert.fail('poll must be cleared'); };
  t.mock.timers.tick(1000);
});

test('manual cancel aborts transport once, catches late errors, removes listeners and polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture();
  const rejected = assert.rejects(f.promise, { name: 'AbortError', code: 'UPLOAD_CANCELED' });
  f.controller.abort();
  await rejected;
  assert.equal(f.request.abortCalls, 1);
  assert.equal(f.calls.length, 1);
  assertCleanTransport(f.request);
  assert.deepEqual(getEventListeners(f.controller.signal, 'abort'), []);
  f.request.getUploadProgress = () => { assert.fail('canceled upload must not poll'); };
  t.mock.timers.tick(1000000);
});

test('already canceled uploads never create a request', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture({ signal: controller.signal });
  await assert.rejects(f.promise, { name: 'AbortError', code: 'UPLOAD_CANCELED' });
  assert.equal(f.calls.length, 0);
});

test('HTTP 422 retains the Chinese summary, server message and structured errors', async () => {
  const f = fixture();
  const rejected = assert.rejects(f.promise, (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'EHTTP');
    assert.match(error.message, /提交内容不符合 GitHub 要求.*HTTP 422.*blob too large/);
    assert.match(error.message, /errors:.*content.*too_large/);
    assert.doesNotMatch(error.message, /mock-only|YWJj/);
    return true;
  });
  f.respond(422, JSON.stringify({ message: 'blob too large', errors: [{ field: 'content', code: 'too_large' }] }));
  await rejected;
  assert.equal(f.calls.length, 1);
});

test('network errors and transport abort reject without retrying', async () => {
  for (const event of ['error', 'abort']) {
    const f = fixture();
    const rejected = assert.rejects(f.promise, { code: { error: 'ENETWORK', abort: 'EABORTED' }[event] });
    f.request.emit(event, new Error('net::ERR_CONNECTION_RESET'));
    await rejected;
    assert.equal(f.calls.length, 1);
    assertCleanTransport(f.request);
  }
});

test('response errors, aborted/closed bodies and cancellation while reading reject cleanly', async () => {
  for (const event of ['error', 'aborted', 'close', 'cancel']) {
    const f = fixture();
    const response = f.respond(201, null);
    const rejected = assert.rejects(f.promise, { code: { error: 'ENETWORK', aborted: 'EABORTED', close: 'ECONNCLOSED', cancel: 'UPLOAD_CANCELED' }[event] });
    if (event === 'cancel') f.controller.abort();
    else response.emit(event, new Error('response reset'));
    await rejected;
    assertCleanTransport(response);
    assertCleanTransport(f.request);
  }
});

test('invalid success JSON, non-JSON HTTP errors and empty 204 are handled', async () => {
  for (const [status, body, code] of [[201, 'not json', 'ERESPONSE'], [502, 'bad gateway', 'EHTTP']]) {
    const f = fixture();
    const rejected = assert.rejects(f.promise, { code });
    f.respond(status, body);
    await rejected;
  }
  const f = fixture();
  f.respond(204, '');
  assert.equal(await f.promise, null);
});

test('synchronous creation/end failures reject; progress callback failures abort and clean up', async () => {
  await assert.rejects(uploadRequest({ request() { throw new Error('cannot create'); } }, 'https://example.invalid', { body: '' }), /cannot create/);
  const broken = new EventEmitter();
  broken.end = () => { throw new Error('cannot send'); };
  broken.abort = () => { broken.emit('error', new Error('late error')); broken.emit('close'); };
  await assert.rejects(uploadRequest({ request: () => broken }, 'https://example.invalid', { body: '' }), /cannot send/);
  assertCleanTransport(broken);
  const f = fixture({ onUploadProgress() { throw new Error('consumer failed'); } });
  const rejected = assert.rejects(f.promise, { code: 'EPROGRESS' });
  f.request.emit('upload-progress', {}, 1, 10);
  await rejected;
  assert.equal(f.request.abortCalls, 1);
  assertCleanTransport(f.request);
});

test('cancellation from the final response-time progress callback guards response errors', async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal, onUploadProgress: () => controller.abort() });
  const rejected = assert.rejects(f.promise, { name: 'AbortError', code: 'UPLOAD_CANCELED' });
  f.request.progress = { active: true, started: true, current: 38, total: 38 };
  f.respond(201, null);
  await rejected;
  assert.equal(f.request.abortCalls, 1);
  assertCleanTransport(f.request.response);
});

test('writable close before response and between chunks does not settle or disable cancel', async () => {
  const f = fixture();
  let settled = false;
  f.promise.then(() => { settled = true; }, () => { settled = true; });
  f.request.emit('close');
  await Promise.resolve();
  assert.equal(settled, false);
  const response = f.respond(201, null);
  response.emit('data', Buffer.from('{"sha":'));
  f.request.emit('close');
  await Promise.resolve();
  assert.equal(settled, false);
  response.emit('data', Buffer.from('"complete"}'));
  response.emit('end');
  assert.deepEqual(await f.promise, { sha: 'complete' });
  assert.equal(f.request.abortCalls, 0);
  assertCleanTransport(response);
  assertCleanTransport(f.request);

  for (const withResponse of [false, true]) {
    const canceled = fixture();
    canceled.request.emit('close');
    if (withResponse) canceled.respond(201, null);
    const rejected = assert.rejects(canceled.promise, { code: 'UPLOAD_CANCELED' });
    canceled.controller.abort();
    await rejected;
    assert.equal(canceled.request.abortCalls, 1);
    assertCleanTransport(canceled.request);
  }
});

test('native failures after writable close still reject and abort once', async () => {
  const f = fixture();
  f.request.emit('close');
  const rejected = assert.rejects(f.promise, { code: 'ENETWORK' });
  f.request.emit('error', new Error('net::ERR_CONNECTION_RESET'));
  await rejected;
  assert.equal(f.request.abortCalls, 1);
  assertCleanTransport(f.request);
});

test('header failures abort cleanly before any body is sent', async () => {
  const req = new EventEmitter();
  let aborted = 0;
  req.setHeader = () => { throw new Error('invalid header'); };
  req.end = () => assert.fail('must not send after header failure');
  req.abort = () => { aborted += 1; req.emit('error', new Error('late abort error')); };
  await assert.rejects(uploadRequest({ request: () => req }, 'https://example.invalid', {
    body: 'test', headers: { 'Content-Type': 'application/json' }
  }), /invalid header/);
  assert.equal(aborted, 1);
  assertCleanTransport(req);
});
