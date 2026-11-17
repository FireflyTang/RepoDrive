'use strict';

// Opt-in real transport regression (no GitHub, credentials or application UI):
// REPODRIVE_ELECTRON_TEST=1 REPODRIVE_ELECTRON_TEST_WORK=/absolute/artifact/dir \
//   node --test test/upload-request-electron.test.js
// Only the test harness has watchdogs; uploadRequest has no automatic deadline.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const headers = {
  Authorization: 'Bearer local-fixture-only',
  'Content-Type': 'application/json',
  Accept: 'application/vnd.github+json'
};
// Synthetic 8272-byte file: never read the user's file or application settings.
const file = Buffer.alloc(8272, 'x');
const body = JSON.stringify({ content: file.toString('base64'), encoding: 'base64' });
const success = JSON.stringify({ sha: 'local-blob', size: file.length });
const detail = { message: 'local blob validation failed', errors: [{ field: 'content', code: 'invalid' }] };

async function electronWorker() {
  const { app, net, session } = require('electron');
  const { uploadRequest } = require('../src/upload-request');
  app.setPath('userData', path.join(process.env.REPODRIVE_ELECTRON_TEST_WORK, 'user-data'));
  app.setPath('crashDumps', path.join(process.env.REPODRIVE_ELECTRON_TEST_WORK, 'crash-dumps'));
  await app.whenReady();
  const isolated = session.fromPartition('upload-request-local-test', { cache: false });
  await isolated.setProxy({ mode: 'direct' });
  let active;
  process.on('message', async (message) => {
    if (message.kind === 'stop') { app.exit(0); return; }
    if (message.kind === 'cancel') {
      if (active?.name === message.name) {
        active.mark('test.cancel');
        active.controller.abort();
      }
      return;
    }
    if (message.kind !== 'run') return;
    const events = [];
    const progress = [];
    const controller = new AbortController();
    const start = performance.now();
    const mark = (event, data = {}) => events.push({ ms: performance.now() - start, event, ...data });
    active = { name: message.name, controller, mark };
    let request;
    let response;
    let abortCalls = 0;
    const transport = { request(options) {
      request = net.request(options);
      const abort = request.abort;
      request.abort = function() { abortCalls += 1; return abort.call(this); };
      const emit = request.emit;
      request.emit = function(event, ...args) {
        if (event === 'response') {
          response = args[0];
          mark('request.response', { status: response.statusCode, headers: response.headers });
          const responseEmit = response.emit;
          response.emit = function(type, ...values) {
            if (['data', 'end', 'close', 'error', 'aborted'].includes(type)) {
              mark(`response.${type}`, type === 'data' ? { bytes: values[0].length } : {});
            }
            const emitted = responseEmit.call(this, type, ...values);
            if (type === 'data' && message.name === 'cancel-body') process.send({ kind: 'body-received' });
            return emitted;
          };
        } else if (['finish', 'close', 'abort', 'error', 'upload-progress'].includes(event)) {
          mark(`request.${event}`, event === 'error' ? { message: args[0].message } : {});
        }
        return emit.call(this, event, ...args);
      };
      return request;
    }};
    let outcome;
    try {
      const value = await uploadRequest(transport, message.url, {
        body, headers, session: isolated, signal: controller.signal,
        onUploadProgress(p) {
          progress.push(p);
          if (message.name === 'progress-error') throw new Error('local consumer failed');
        }
      });
      mark('promise.resolve');
      outcome = { value };
    } catch (error) {
      mark('promise.reject');
      outcome = { code: error.code, status: error.status, message: error.message };
    }
    // Let native abort/error/close events run before inspecting cleanup and exit.
    await new Promise(resolve => setTimeout(resolve, 80));
    const remaining = target => target ? target.eventNames().map(event => ({
      event: String(event), handlers: target.listeners(event).map(handler => handler.name)
    })).filter(entry => entry.handlers.some(name => name === 'ignoreLateError' || name === 'networkError')) : [];
    process.send({ kind: 'result', name: message.name, outcome, events, progress, abortCalls,
      guards: { request: remaining(request), response: remaining(response) } });
    active = null;
  });
  process.send({ kind: 'ready', electron: process.versions.electron });
}

if (process.versions.electron) {
  electronWorker().catch(error => {
    console.error(error.stack);
    require('electron').app.exit(1);
  });
} else {
  const test = require('node:test');
  const http = require('node:http');
  const { once } = require('node:events');
  const { spawn } = require('node:child_process');
  test('real Electron 38 upload transport against a Node HTTP server', {
    skip: process.env.REPODRIVE_ELECTRON_TEST !== '1', timeout: 30000
  }, async (t) => {
    assert.ok(path.isAbsolute(process.env.REPODRIVE_ELECTRON_TEST_WORK || ''),
      'set REPODRIVE_ELECTRON_TEST_WORK to an absolute artifact directory outside source');
    const work = fs.mkdtempSync(path.join(process.env.REPODRIVE_ELECTRON_TEST_WORK, 'electron-'));
    const report = { node: process.version, requests: [], cases: [] };
    const timers = new Set();
    const later = (fn, ms) => {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
      timers.add(timer);
    };
    let child;
    const server = http.createServer((req, res) => {
      const name = req.url.slice(1);
      const received = { name, method: req.method, headers: req.headers, body: '', bytes: 0 };
      report.requests.push(received);
      res.on('finish', () => { received.responseFinished = true; });
      res.on('close', () => { received.responseClosed = true; });
      req.on('data', chunk => { received.body += chunk.toString(); received.bytes += chunk.length; });
      req.on('end', () => {
        received.complete = true;
        if (name === 'cancel-headers') {
          // Cancel only after the server has received the entire upload, while
          // native transport is still waiting for headers (after writable close).
          child.send({ kind: 'cancel', name });
          return;
        }
        if (name === 'redirect') {
          res.writeHead(307, { Location: '/must-not-replay' }); res.end(); return;
        }
        if (name === 'empty204') { res.writeHead(204); res.end(); return; }
        if (name !== 'no-content-type') res.setHeader('Content-Type', 'application/json');
        const payload = name === 'unprocessable' ? JSON.stringify(detail) : success;
        const status = name === 'unprocessable' ? 422 : 201;
        if (name === 'delayed-headers') {
          later(() => { res.writeHead(status); res.end(payload); }, 350);
        } else if (['delayed-body-close', 'cancel-body', 'truncated'].includes(name)) {
          res.setHeader('Connection', 'close');
          if (name === 'truncated') res.setHeader('Content-Length', Buffer.byteLength(payload) + 10);
          res.writeHead(status);
          res.write(payload.slice(0, 5));
          if (name === 'cancel-body') {
            // Parent observes actual response data via the child's IPC trace.
            return;
          }
          later(() => {
            if (name === 'truncated') res.destroy();
            else res.end(payload.slice(5));
          }, 350);
        } else { res.writeHead(status); res.end(payload); }
      });
    });
    let stdout = '', stderr = '';
    const inbox = [];
    let wake;
    const receive = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise(resolve => { wake = resolve; });
    t.after(async () => {
      for (const timer of timers) clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'close');
        child.kill('SIGKILL');
        await exited;
      }
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 2));
      fs.writeFileSync(path.join(work, 'electron.stdout.log'), stdout);
      fs.writeFileSync(path.join(work, 'electron.stderr.log'), stderr);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = { ...process.env, REPODRIVE_ELECTRON_TEST_WORK: work,
      TMPDIR: work, XDG_CACHE_HOME: path.join(work, 'cache'),
      XDG_CONFIG_HOME: path.join(work, 'config'), XDG_STATE_HOME: path.join(work, 'state') };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require('electron'), ['--no-sandbox', '--ozone-platform=headless', '--disable-gpu', __filename], {
      cwd: work, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', message => {
      if (message.kind === 'body-received') { child.send({ kind: 'cancel', name: 'cancel-body' }); return; }
      if (wake) { const resolve = wake; wake = null; resolve(message); } else inbox.push(message);
    });
    child.on('error', error => {
      if (wake) { const resolve = wake; wake = null; resolve({ kind: 'crash', error: error.message }); }
    });
    child.on('close', (code, signal) => {
      const message = { kind: 'exit', code, signal };
      if (wake) { const resolve = wake; wake = null; resolve(message); } else inbox.push(message);
    });
    const ready = await receive();
    assert.equal(ready.kind, 'ready', JSON.stringify({ ready, stderr }));
    assert.match(ready.electron, /^38\./);
    report.electron = ready.electron;
    const scenarios = ['created', 'delayed-headers', 'delayed-body-close', 'no-content-type', 'unprocessable',
      'cancel-headers', 'cancel-body', 'progress-error', 'truncated', 'redirect', 'empty204'];
    for (const name of scenarios) {
      await t.test(name, async () => {
        child.send({ kind: 'run', name, url: `http://127.0.0.1:${server.address().port}/${name}` });
        const result = await receive();
        report.cases.push(result);
        assert.equal(result.kind, 'result', JSON.stringify({ result, stderr }));
        assert.equal(result.name, name);
        const requests = report.requests.filter(entry => entry.name === name);
        assert.equal(requests.length, 1, 'no retries');
        const sent = requests[0];
        assert.equal(sent.method, 'POST');
        assert.equal(sent.headers.authorization, headers.Authorization);
        assert.equal(sent.headers['content-type'], headers['Content-Type']);
        assert.equal(sent.headers.accept, headers.Accept);
        assert.equal(sent.bytes, Buffer.byteLength(body));
        assert.equal(sent.body, body, 'actual wire body, including base64 encoding');
        assert.deepEqual(Buffer.from(JSON.parse(sent.body).content, 'base64'), file);
        assert.equal(sent.complete, true);
        const events = result.events.map(entry => entry.event);
        assert.ok(events.indexOf('request.close') > events.indexOf('request.finish'));
        if (['created', 'delayed-headers', 'delayed-body-close', 'no-content-type', 'empty204'].includes(name)) {
          assert.deepEqual(result.outcome.value, name === 'empty204' ? null : JSON.parse(success));
          assert.ok(events.indexOf('request.close') < events.indexOf('request.response'), JSON.stringify(events));
          assert.ok(events.indexOf('response.end') < events.indexOf('promise.resolve'));
          assert.equal(result.abortCalls, 0);
          assert.deepEqual(result.progress.at(-1), { sent: Buffer.byteLength(body), total: Buffer.byteLength(body) });
          if (name.startsWith('delayed-')) {
            assert.ok(result.events.find(entry => entry.event === 'promise.resolve').ms >= 300);
          }
          if (name === 'delayed-body-close') {
            assert.ok(result.events.filter(entry => entry.event === 'response.data').length >= 2);
          }
        } else if (name === 'unprocessable') {
          assert.equal(result.outcome.code, 'EHTTP');
          assert.equal(result.outcome.status, 422);
          assert.match(result.outcome.message, /HTTP 422.*local blob validation failed.*errors:.*content.*invalid/);
          assert.equal(result.abortCalls, 0, 'complete HTTP error body needs no transport abort');
        } else {
          const code = name.startsWith('cancel-') ? 'UPLOAD_CANCELED' : name === 'progress-error' ? 'EPROGRESS' : 'ENETWORK';
          assert.equal(result.outcome.code, code);
          assert.equal(result.abortCalls, 1, 'abort pending native transport even after writable close');
          if (name.startsWith('cancel-')) {
            assert.equal(sent.responseClosed, true, 'server sees native cancellation');
            assert.notEqual(sent.responseFinished, true);
            assert.ok(events.indexOf('request.close') < events.indexOf('test.cancel'));
            assert.equal(events.includes('request.response'), name === 'cancel-body');
          }
        }
        assert.ok(result.guards.request.some(entry => entry.handlers.includes('ignoreLateError')));
        assert.ok(!Object.values(result.guards).flat().some(entry => entry.handlers.includes('networkError')));
        assert.equal(report.requests.some(entry => entry.name === 'must-not-replay'), false);
      });
    }
    child.send({ kind: 'stop' });
    assert.deepEqual(await receive(), { kind: 'exit', code: 0, signal: null });
    assert.doesNotMatch(stderr, /Unhandled|uncaught|ERR_UNHANDLED_ERROR/);
    t.diagnostic(`Electron ${report.electron}; real wire records and event order: ${path.join(work, 'report.json')}`);
  });
}
