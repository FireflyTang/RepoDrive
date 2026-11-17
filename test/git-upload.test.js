'use strict';

// The shared Git uploader is intentionally macOS/Linux-only; Windows ships
// its independent application without uploads or Unix credential sockets.
const test = process.platform === 'win32' ? require('node:test').skip : require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { credentialKind } = require('../src/git-askpass');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/git-upload.js'), 'utf8');
const config = { owner: 'example', repo: 'drive', branch: 'main', token: 'test-only-in-memory-token' };
const cleanEnv = {
  PATH: '/usr/bin:/bin:/usr/local/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid'
};

function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, input, env: cleanEnv, maxBuffer: 80 * 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

async function fixture(t, files = { 'keep.txt': ['100644', 'unchanged'], 'run.sh': ['100755', 'old'], 'delete.txt': ['100644', 'remove'] }) {
  const dir = await fsp.mkdtemp(path.join(process.env.REPODRIVE_TEST_TMPDIR || os.tmpdir(), 'rd-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  // Unix socket paths are limited to ~104 bytes on macOS / 108 on Linux.
  // Keep app temp short even when the test log/work directory is deeply nested.
  const appTemp = await fsp.mkdtemp(path.join(os.tmpdir(), 'rd-app temp-'));
  t.after(() => fsp.rm(appTemp, { recursive: true, force: true }));
  git(dir, ['init', '--bare', '--template=', remote]);
  git(remote, ['config', 'uploadpack.allowFilter', 'true']);
  const records = [];
  for (const [name, [mode, content]] of Object.entries(files)) {
    const sha = git(remote, ['hash-object', '-w', '--stdin'], Buffer.from(content)).toString().trim();
    records.push(`${mode} blob ${sha}\t${name}\0`);
  }
  const tree = git(remote, ['mktree', '-z'], records.join('')).toString().trim();
  const head = git(remote, ['commit-tree', tree], 'initial').toString().trim();
  git(remote, ['update-ref', 'refs/heads/main', head]);
  return { dir, remote, appTemp, head, tree };
}

function loadUpload(f, options = {}) {
  const calls = [];
  const proxyCalls = [];
  const module = { exports: {} };
  const wrappedSpawn = (command, args, settings) => {
    const call = { command, args: [...args], settings };
    calls.push(call);
    options.beforeSpawn?.(call);
    if (options.spawn) return options.spawn(command, args, settings, call);
    // Transport substitution exists only in tests. Production accepts only a
    // constructed github.com HTTPS URL, never an arbitrary local remote.
    const actual = args.map((arg) => arg === 'https://x-access-token@github.com/example/drive.git'
      ? `file://${f.remote}` : arg);
    const child = spawn(command, ['-c', 'protocol.file.allow=always', ...actual], settings);
    options.onSpawn?.(child, call);
    return child;
  };
  vm.runInNewContext(source, {
    module, Buffer, URL, __dirname: path.join(root, 'src'),
    process: { platform: process.platform, execPath: options.execPath || process.execPath, kill: process.kill.bind(process) },
    require(name) {
      if (name === 'electron') return {
        app: { getPath: (kind) => { assert.equal(kind, 'temp'); return f.appTemp; } },
        session: { defaultSession: { resolveProxy: async (url) => {
          proxyCalls.push(url);
          if (options.proxyError) throw options.proxyError;
          if (options.resolveProxy) return options.resolveProxy(url);
          return options.proxyResult || 'DIRECT';
        } } }
      };
      if (name === 'node:child_process') return { spawn: wrappedSpawn };
      if (name === './git-askpass') return { credentialKind };
      return require(name);
    }
  }, { filename: path.join(root, 'src/git-upload.js') });
  return { commit: module.exports.commitViaGit, calls, proxyCalls };
}

const isCommand = (call, command) => call.args.includes(command);
const remoteHead = (f) => git(f.remote, ['rev-parse', 'refs/heads/main']).toString().trim();
const assertClean = async (f) => assert.deepEqual(await fsp.readdir(f.appTemp), []);

function advanceRemote(f, message = 'concurrent') {
  const parent = remoteHead(f);
  const sha = git(f.remote, ['commit-tree', f.tree, '-p', parent], message).toString().trim();
  git(f.remote, ['update-ref', 'refs/heads/main', sha, parent]);
  return sha;
}

test('one commit stores a real 55 MiB binary plus NUL-delimited Unicode/newline paths and preserves modes', async (t) => {
  const f = await fixture(t);
  const events = [];
  const { commit, calls, proxyCalls } = loadUpload(f, { beforeSpawn(call) {
    if (!isCommand(call, 'hash-object')) return;
    assert.equal(fs.readFileSync(path.join(call.settings.cwd, 'shallow'), 'utf8').trim(), f.head);
    const stored = git(call.settings.cwd, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).toString();
    const oldBlob = git(f.remote, ['rev-parse', 'main:keep.txt']).toString().trim();
    assert(!stored.split('\n').includes(oldBlob), 'unchanged remote blobs must not be downloaded');
  } });
  const archive = randomBytes(55 * 1024 * 1024);
  const unusual = '目录 空格/换\n行\t.bin';
  const changes = [
    { path: 'archive.bin', bytes: archive },
    { path: unusual, bytes: Buffer.from([0, 255, 10, 128]) },
    { path: 'run.sh', bytes: Buffer.from('new executable') },
    { path: 'delete.txt', delete: true }
  ];
  const result = await commit(config, changes, 'one batch', (event) => events.push(event));
  assert.equal(result.changed, 4);
  assert.equal(remoteHead(f), result.commitSha);
  assert.equal(git(f.remote, ['rev-parse', `${result.commitSha}^`]).toString().trim(), f.head);
  assert.equal(git(f.remote, ['rev-list', '--count', 'main']).toString().trim(), '2');
  assert.equal(git(f.remote, ['show', 'main:keep.txt']).toString(), 'unchanged');
  assert.deepEqual(git(f.remote, ['show', 'main:archive.bin']), archive);
  assert.deepEqual(git(f.remote, ['show', `main:${unusual}`]), changes[1].bytes);
  assert.match(git(f.remote, ['ls-tree', 'main', 'run.sh']).toString(), /^100755 blob/);
  assert.equal(git(f.remote, ['ls-tree', 'main', 'delete.txt']).length, 0);
  assert.deepEqual(proxyCalls, ['https://github.com']);
  assert(events.some((event) => /Writing objects:.*100%/.test(event.gitProgress || '')));
  assert(events.filter((event) => /Writing objects:.*100%/.test(event.gitProgress || '')).every((event) => event.phase === 'uploading'));
  assert.equal(events.at(-1).phase, 'committing');
  assert(events.every((event) => event.total === 4 && event.completed <= 4));
  const fetch = calls.find((call) => isCommand(call, 'fetch'));
  assert(fetch.args.includes('--depth=1'));
  assert(fetch.args.includes('--filter=blob:none'));
  assert(fetch.args.includes('--no-tags'));
  assert(calls.some((call) => isCommand(call, 'update-index') && call.args.includes('-z')));
  assert.equal(calls.filter((call) => isCommand(call, 'push')).length, 1);
  assert(calls.every((call) => !call.args.some((arg) => /force|rebase/.test(arg))));
  for (const call of calls) {
    assert(!JSON.stringify([call.args, call.settings.env]).includes(config.token));
    assert.equal(call.settings.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(call.settings.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(call.settings.env.GIT_TERMINAL_PROMPT, '0');
    assert(call.args.includes('credential.helper='));
    assert.equal(call.settings.detached, true);
    assert.equal(call.settings.timeout, undefined);
  }
  await assertClean(f);
});

test('unchanged content and missing deletion do not create an empty commit', async (t) => {
  const f = await fixture(t);
  const { commit, calls } = loadUpload(f);
  const result = await commit(config, [{ path: 'keep.txt', bytes: Buffer.from('unchanged') }, { path: 'missing', delete: true }], 'noop');
  assert.equal(result.changed, 0);
  assert.equal(result.commitSha, f.head);
  assert(!calls.some((call) => isCommand(call, 'push')));
  await assertClean(f);
});

test('concurrent update before push is refused and never overwritten', async (t) => {
  const f = await fixture(t);
  let concurrent;
  const { commit, calls } = loadUpload(f);
  await assert.rejects(commit(config, [{ path: 'new', bytes: Buffer.from('new') }], 'upload', (event) => {
    if (event.phase === 'committing' && !concurrent) concurrent = advanceRemote(f);
  }), (error) => error.code === 'GIT_CONFLICT');
  assert.equal(remoteHead(f), concurrent);
  assert(!calls.some((call) => isCommand(call, 'push')));
  await assertClean(f);
});

test('concurrent update after preflight is rejected by a non-force push', async (t) => {
  const f = await fixture(t);
  let concurrent;
  const { commit } = loadUpload(f, { beforeSpawn(call) {
    if (isCommand(call, 'push')) concurrent = advanceRemote(f);
  } });
  await assert.rejects(commit(config, [{ path: 'new', bytes: Buffer.from('new') }], 'upload'), (error) => error.code === 'GIT_CONFLICT');
  assert.equal(remoteHead(f), concurrent);
  await assertClean(f);
});

test('a successful push is not reported as confirmed if the branch changes before verification', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const { commit } = loadUpload(f, { beforeSpawn(call) {
    if (isCommand(call, 'ls-remote') && ++reads === 2) advanceRemote(f, 'after push');
  } });
  await assert.rejects(commit(config, [{ path: 'new', bytes: Buffer.from('new') }], 'upload'), (error) => error.code === 'GIT_REMOTE_UNCONFIRMED');
  await assertClean(f);
});

test('abort before starting creates no processes or temporary files', async (t) => {
  const f = await fixture(t);
  const { commit, calls } = loadUpload(f);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(commit(config, [{ path: 'new', bytes: Buffer.from('x') }], 'upload', null, { signal: controller.signal }), (error) => error.code === 'UPLOAD_CANCELED');
  assert.equal(calls.length, 0);
  await assertClean(f);
});

test('manual cancel also interrupts pending Electron proxy resolution without a timeout', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const { commit, calls } = loadUpload(f, { resolveProxy() {
    setImmediate(() => controller.abort());
    return new Promise(() => {});
  } });
  await assert.rejects(commit(config, [{ path: 'new', bytes: Buffer.from('x') }], 'upload', null, { signal: controller.signal }), (error) => error.code === 'UPLOAD_CANCELED');
  assert.equal(calls.length, 0);
  await assertClean(f);
});

for (const stage of ['fetch', 'push']) {
  test(`abort during ${stage} kills only the owned process group and cleans temporary state`, async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    let childPid;
    let descendantPid;
    const unrelated = spawn('/bin/sleep', ['60']);
    t.after(() => unrelated.kill('SIGKILL'));
    const { commit } = loadUpload(f, { spawn(command, args, settings, call) {
      if (!isCommand(call, stage)) {
        return spawn(command, ['-c', 'protocol.file.allow=always', ...args.map((arg) => arg === 'https://x-access-token@github.com/example/drive.git' ? `file://${f.remote}` : arg)], settings);
      }
      // Child and descendant have installed handlers before READY. Waiting for
      // output also verifies cancellation of a genuinely running operation.
      const child = spawn('/bin/sh', ['-c', 'sleep 60 & echo "DESC:$!" >&2; wait'], settings);
      childPid = child.pid;
      child.stderr.once('data', (data) => {
        descendantPid = Number(/DESC:(\d+)/.exec(data.toString())[1]);
        controller.abort();
      });
      return child;
    } });
    await assert.rejects(commit(config, [{ path: 'new', bytes: Buffer.from('x') }], 'upload', null, { signal: controller.signal }), (error) => {
      assert.equal(error.code, 'UPLOAD_CANCELED');
      if (stage === 'push') assert.equal(error.message, '已停止上传，请刷新确认远端是否已提交');
      return true;
    });
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    // A killed orphan can remain as a zombie until init reaps it; it cannot run.
    if (process.platform === 'linux' && fs.existsSync(`/proc/${descendantPid}/stat`)) {
      assert.match(fs.readFileSync(`/proc/${descendantPid}/stat`, 'utf8'), /\) Z /);
    } else assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    assert.equal(remoteHead(f), f.head);
    await assertClean(f);
  });
}

test('missing system git produces a clear error and cleans up', async (t) => {
  const f = await fixture(t);
  const { commit } = loadUpload(f, { spawn(_command, args, settings) { return spawn('/nonexistent/repodrive-test-git', args, settings); } });
  await assert.rejects(commit(config, [{ path: 'new', bytes: Buffer.from('x') }], 'upload'), (error) => error.code === 'GIT_NOT_FOUND' && /未安装 Git/.test(error.message));
  await assertClean(f);
});

for (const [proxyResult, expected] of [['DIRECT', ''], ['PROXY 127.0.0.1:7890; DIRECT', 'http://127.0.0.1:7890'], ['SOCKS5 localhost:1080', 'socks5h://localhost:1080'], ['SOCKS localhost:1080', 'socks4://localhost:1080']]) {
  test(`Electron proxy ${proxyResult} is preserved without direct fallback`, async (t) => {
    const f = await fixture(t);
    const { commit, calls } = loadUpload(f, { proxyResult });
    await commit(config, [{ path: 'new', bytes: Buffer.from('x') }], 'upload');
    assert(calls.every((call) => call.args.includes(`http.proxy=${expected}`)));
    assert(calls.every((call) => !('HTTPS_PROXY' in call.settings.env) && !('NO_PROXY' in call.settings.env)));
    await assertClean(f);
  });
}

test('explicit proxy takes precedence and proxy resolution errors fail closed', async (t) => {
  const f = await fixture(t);
  const explicit = loadUpload(f, { proxyError: new Error('must not resolve') });
  await explicit.commit({ ...config, proxy: 'http://127.0.0.1:7891' }, [{ path: 'new', bytes: Buffer.from('x') }], 'upload');
  assert.equal(explicit.proxyCalls.length, 0);
  assert(explicit.calls.every((call) => call.args.includes('http.proxy=http://127.0.0.1:7891')));
  for (const options of [{ proxyError: new Error('proxy unavailable') }, { proxyResult: 'UNKNOWN localhost:8' }]) {
    const { commit, calls } = loadUpload(f, options);
    await assert.rejects(commit(config, [{ path: 'x', bytes: Buffer.from('x') }], 'upload'));
    assert.equal(calls.length, 0);
  }
  await assertClean(f);
});

test('askpass only accepts HTTPS GitHub prompts', () => {
  assert.equal(credentialKind("Username for 'https://github.com': "), 'Username');
  assert.equal(credentialKind("Password for 'https://x-access-token@github.com': "), 'Password');
  for (const prompt of ["Password for 'https://github.com.evil.test': ", "Password for 'http://github.com': ", "Password for 'https://github.com:8443': ", "Password for 'https://evil@github.com': ", "Password for 'https://github.com@evil.test': ", 'Proxy password: ']) {
    assert.equal(credentialKind(prompt), null);
  }
});

function runAskpass(env, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(env.GIT_ASKPASS, [prompt], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function gitCredential(env, host = 'github.com') {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'credential.helper=', 'credential', 'fill'], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`protocol=https\nhost=${host}\n\n`);
  });
}

test('real Electron Node-mode askpass returns the in-memory config token over a private socket', async (t) => {
  let electron;
  try { electron = require('electron'); } catch { t.skip('Electron package unavailable'); return; }
  if (typeof electron !== 'string' || !fs.existsSync(electron)) { t.skip('Electron executable unavailable'); return; }
  const f = await fixture(t);
  const gate = path.join(f.dir, 'auth-gate');
  const mkfifo = spawnSync('mkfifo', [gate], { env: cleanEnv });
  assert.equal(mkfifo.status, 0, mkfifo.stderr?.toString());
  let authChecks;
  let authEnv;
  let authError;
  const { commit, calls } = loadUpload(f, { execPath: electron, beforeSpawn(call) {
    if (authChecks) return;
    authEnv = call.settings.env;
    authChecks = (async () => {
      assert.equal((await fsp.stat(call.settings.cwd)).mode & 0o777, 0o700);
      assert.equal((await fsp.stat(authEnv.REPODRIVE_ASKPASS_SOCKET)).mode & 0o777, 0o600);
      const wrapper = await fsp.readFile(path.join(call.settings.cwd, 'askpass'), 'utf8');
      assert(wrapper.includes(electron));
      for (const file of ['askpass', 'askpass.js']) assert(!(await fsp.readFile(path.join(call.settings.cwd, file), 'utf8')).includes(config.token));
      assert.equal(authEnv.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(authEnv.HOME, undefined);
      const actualGit = await gitCredential(authEnv);
      assert.equal(actualGit.code, 0, actualGit.stderr);
      assert(actualGit.stdout.includes('username=x-access-token\n'));
      assert(actualGit.stdout.includes(`password=${config.token}\n`));
      const deniedGit = await gitCredential(authEnv, 'evil.test');
      assert.notEqual(deniedGit.code, 0);
      assert(!deniedGit.stdout.includes(config.token));
      const password = await runAskpass(authEnv, "Password for 'https://x-access-token@github.com': ");
      assert.deepEqual(password, { code: 0, stdout: `${config.token}\n`, stderr: '' });
      const username = await runAskpass(authEnv, "Username for 'https://github.com': ");
      assert.deepEqual(username, { code: 0, stdout: 'x-access-token\n', stderr: '' });
      const denied = await runAskpass(authEnv, "Password for 'https://evil.test': ");
      assert.equal(denied.code, 1);
      assert.equal(denied.stdout, '');
      // A caller bypassing the helper must also be denied by the socket server.
      const deniedByServer = await new Promise((resolve, reject) => {
        const socket = net.createConnection(authEnv.REPODRIVE_ASKPASS_SOCKET);
        let data = '';
        socket.on('error', reject);
        socket.on('connect', () => socket.end(JSON.stringify({ prompt: "Password for 'https://evil.test': " })));
        socket.on('data', (chunk) => { data += chunk; });
        socket.on('end', () => resolve(data));
      });
      assert.equal(deniedByServer, '');
    })().catch((error) => { authError = error; }).finally(() => fsp.writeFile(gate, 'go\n'));
  }, spawn(command, args, settings, call) {
    if (isCommand(call, 'check-ref-format')) {
      // Keep the operation alive until the real Electron credential exchange
      // finishes, without a synthetic upload timer.
      const child = spawn('/bin/sh', ['-c', 'read ready < "$1"; shift; exec git "$@"', 'test-git', gate, '-c', 'protocol.file.allow=always', ...args], settings);
      return child;
    }
    return spawn(command, ['-c', 'protocol.file.allow=always', ...args.map((arg) => arg === 'https://x-access-token@github.com/example/drive.git' ? `file://${f.remote}` : arg)], settings);
  } });
  const operation = commit(config, [{ path: 'new', bytes: Buffer.from('auth test') }], 'auth integration');
  await operation;
  await authChecks;
  if (authError) throw authError;
  assert(!JSON.stringify(calls.map(({ args, settings }) => [args, settings.env])).includes(config.token));
  await assertClean(f);
});
