'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { app, session } = require('electron');
const { credentialKind } = require('./git-askpass');

const shellQuote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;

function canceled(pushStarted) {
  return Object.assign(new Error(pushStarted
    ? '已停止上传，请刷新确认远端是否已提交'
    : '已停止上传'), { name: 'AbortError', code: 'UPLOAD_CANCELED' });
}

function proxyUrl(value) {
  let url;
  try { url = new URL(value.includes('://') ? value : `http://${value}`); } catch {
    throw new Error('Git 上传代理地址无效');
  }
  if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(url.protocol) ||
      !url.hostname || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Git 上传需要无内嵌凭据的 HTTP/HTTPS/SOCKS 代理地址');
  }
  return url.toString().replace(/\/$/, '');
}

async function resolveProxy(config) {
  if (config.proxy) return proxyUrl(String(config.proxy).trim());
  // Do not silently fall back to environment proxies or a direct connection.
  const resolved = await session.defaultSession.resolveProxy('https://github.com');
  const first = resolved.split(';')[0].trim();
  if (first === 'DIRECT') return '';
  const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/.exec(first);
  if (!match) throw new Error('无法将当前 Electron 会话代理用于 Git 上传');
  const protocols = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks4', SOCKS4: 'socks4', SOCKS5: 'socks5h' };
  return proxyUrl(`${protocols[match[1]]}://${match[2]}`);
}

// No inherited Git config, credential, trace, proxy or Node injection variables.
// Only public system tools are searched; the temporary repository has no hooks.
function gitEnvironment(temp, askpass, author) {
  return {
    PATH: '/usr/bin:/bin:/usr/local/bin',
    XDG_CONFIG_HOME: temp, TMPDIR: temp,
    LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass,
    REPODRIVE_ASKPASS_SOCKET: path.join(temp, 'auth.sock'), ELECTRON_RUN_AS_NODE: '1',
    GIT_INDEX_FILE: path.join(temp, 'upload.index'),
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email
  };
}

async function startCredentials(socketPath, token) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk.toString('utf8');
      if (request.length > 8192) socket.destroy();
    });
    socket.on('end', () => {
      try {
        const kind = credentialKind(JSON.parse(request).prompt);
        if (!kind) return socket.destroy();
        socket.end(JSON.stringify({ value: kind === 'Username' ? 'x-access-token' : token }));
      } catch { socket.destroy(); }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
}

/** Upload a batch using Git objects, without a worktree or downloading old blobs.
 * Progress counts staged file changes; gitProgress contains actual Git output.
 * Neither a staged file nor "Writing objects: 100%" means a remote commit.
 */
async function commitViaGit(config, changes, message, onProgress, { signal } = {}) {
  let pushStarted = false;
  const checkCanceled = () => { if (signal?.aborted) throw canceled(pushStarted); };
  checkCanceled();
  if (process.platform === 'win32') throw new Error('此客户端的 Git 大文件上传仅支持 macOS/Linux');
  if (!config.token || typeof config.token !== 'string' || /[\r\n\0]/.test(config.token)) throw new Error('Git 上传需要有效 Token');
  if (![config.owner, config.repo].every((v) => typeof v === 'string' && /^[A-Za-z0-9_.-]+$/.test(v) && v !== '.' && v !== '..')) {
    throw new Error('GitHub 代码仓名称无效');
  }
  if (typeof config.branch !== 'string' || !config.branch || config.branch.startsWith('-')) throw new Error('Git 分支名称无效');
  if (!Array.isArray(changes) || !changes.length) throw new Error('没有需要提交的文件变更。');
  const seen = new Set();
  for (const change of changes) {
    if (typeof change.path !== 'string' || !change.path || change.path.includes('\0') ||
        change.path.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      throw new Error('Git 上传路径无效');
    }
    if (seen.has(change.path)) throw new Error('同一次操作中存在重复路径');
    seen.add(change.path);
    if (!change.delete && !Buffer.isBuffer(change.bytes)) throw new Error('Git 上传内容必须为 Buffer');
  }
  const author = config.gitAuthor || { name: 'RepoDrive', email: 'repodrive@users.noreply.github.com' };
  if (![author.name, author.email].every((v) => typeof v === 'string' && v.trim() && !/[<>\r\n\0]/.test(v))) {
    throw new Error('Git 提交作者无效');
  }
  let completed = 0;
  let phase = 'preparing';
  let current = '';
  const redact = (text) => String(text).split(config.token).join('[redacted]')
    .split(Buffer.from(`x-access-token:${config.token}`).toString('base64')).join('[redacted]');
  const progress = (gitProgress) => {
    // UI callbacks must not break process supervision or turn a successful push
    // into an unhandled stream exception.
    try { onProgress?.({ phase, current, completed, total: changes.length, ...(gitProgress ? { gitProgress: redact(gitProgress) } : {}) }); } catch { /* Observer only. */ }
  };
  progress();
  const proxy = await new Promise((resolve, reject) => {
    const abort = () => reject(canceled(false));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    resolveProxy(config).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
  checkCanceled();
  const temp = await fs.mkdtemp(path.join(app.getPath('temp'), 'rd-git-'));
  let stopCredentials;
  let primaryError;
  try {
    await fs.chmod(temp, 0o700);
    const helper = path.join(temp, 'askpass.js');
    const wrapper = path.join(temp, 'askpass');
    // readFile works inside Electron ASAR; the spawned Node-mode process reads
    // ordinary source outside ASAR. No credential is written to either file.
    await fs.writeFile(helper, await fs.readFile(path.join(__dirname, 'git-askpass.js')), { mode: 0o600 });
    await fs.writeFile(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} "$@"\n`, { mode: 0o700 });
    const env = gitEnvironment(temp, wrapper, author);
    stopCredentials = await startCredentials(env.REPODRIVE_ASKPASS_SOCKET, config.token);
    const common = [
      '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
      '-c', 'init.defaultBranch=main',
      '-c', 'core.attributesFile=/dev/null', '-c', 'commit.gpgSign=false',
      '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
      '-c', 'http.lowSpeedLimit=0', '-c', 'http.lowSpeedTime=0', '-c', `http.proxy=${proxy}`,
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'
    ];
    const run = (args, input) => new Promise((resolve, reject) => {
      try { checkCanceled(); } catch (error) { reject(error); return; }
      let child;
      try { child = spawn('git', [...common, ...args], { cwd: temp, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (error) { reject(error); return; }
      let output = [];
      let stderr = '';
      let pending = '';
      let processError;
      const transfer = args[0] === 'fetch' || args[0] === 'push';
      const reportLine = (line) => {
        if (transfer && /(?:Enumerating|Counting|Compressing|Receiving|Resolving|Writing) objects:|Resolving deltas:|Total \d+/.test(line)) progress(line);
      };
      const decoder = new StringDecoder('utf8');
      const cancel = () => {
        // The detached child's PID is its own process-group ID. Never target a
        // parent process, a shared Git process or another upload's process group.
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
            if (error.code !== 'ESRCH') processError = error;
          }
        }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      child.on('error', (error) => { processError = error; });
      child.stdout.on('data', (chunk) => output.push(chunk));
      const consume = (text) => {
        stderr = (stderr + text).slice(-16384);
        pending += text;
        const lines = pending.split(/[\r\n]/);
        pending = lines.pop();
        for (const line of lines) if (line) reportLine(line);
        // Bound even malicious/no-newline remote diagnostics.
        if (pending.length > 16384) { reportLine(pending.slice(0, 16384)); pending = ''; }
      };
      child.stderr.on('data', (chunk) => consume(decoder.write(chunk)));
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') processError = error; });
      child.on('close', (code) => {
        signal?.removeEventListener('abort', cancel);
        consume(decoder.end());
        if (pending) reportLine(pending);
        if (signal?.aborted) return reject(canceled(pushStarted));
        if (processError?.code === 'ENOENT') return reject(Object.assign(new Error('未安装 Git，请先安装系统 Git 后重试大文件上传'), { code: 'GIT_NOT_FOUND' }));
        if (processError || code !== 0) {
          // --porcelain reports ref rejection reasons on stdout, not stderr.
          const pushStatus = args[0] === 'push' ? Buffer.concat(output).toString('utf8').trim() : '';
          const detail = redact([pushStatus, stderr.trim()].filter(Boolean).join('\n') || processError?.message || `exit ${code}`);
          const conflict = /non-fast-forward|fetch first|stale info|cannot lock ref|failed to update ref/.test(detail);
          return reject(Object.assign(new Error(conflict
            ? `远端分支已变化，上传被拒绝，请刷新后重试：${detail}`
            : `Git 上传失败：${detail}${pushStarted ? '；请刷新确认远端是否已提交' : ''}`), {
            code: conflict ? 'GIT_CONFLICT' : 'GIT_UPLOAD_FAILED'
          }));
        }
        resolve(Buffer.concat(output));
        output = [];
      });
      child.stdin.end(input);
    });
    const text = async (args, input) => (await run(args, input)).toString('utf8').trim();
    const ref = `refs/heads/${config.branch}`;
    await run(['check-ref-format', ref]);
    await run(['init', '--bare', '--template=', '.']);
    await run(['remote', 'add', 'origin', `https://x-access-token@github.com/${config.owner}/${config.repo}.git`]);
    await run(['config', 'remote.origin.promisor', 'true']);
    await run(['config', 'remote.origin.partialclonefilter', 'blob:none']);
    await run(['fetch', '--progress', '--depth=1', '--filter=blob:none', '--no-tags', 'origin', ref]);
    const head = await text(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    const oldTree = await text(['rev-parse', `${head}^{tree}`]);
    await run(['read-tree', head]);
    const entries = new Map();
    for (const record of (await run(['ls-files', '--stage', '-z'])).toString('utf8').split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      const [mode, sha] = record.slice(0, tab).split(' ');
      entries.set(record.slice(tab + 1), { mode, sha });
    }
    const updates = [];
    let changed = 0;
    phase = 'uploading';
    for (const change of changes) {
      checkCanceled();
      current = change.path;
      progress();
      const existing = entries.get(change.path);
      if (change.delete) {
        if (existing) { updates.push(`0 ${'0'.repeat(head.length)}\t${change.path}\0`); changed += 1; }
      } else {
        if (existing?.mode === '160000') throw new Error('不能以文件替换 Git 子模块');
        const sha = await text(['hash-object', '-w', '--stdin'], change.bytes);
        const mode = existing?.mode || '100644';
        if (!existing || sha !== existing.sha) { updates.push(`${mode} ${sha}\t${change.path}\0`); changed += 1; }
      }
      completed += 1;
      progress();
    }
    if (updates.length) await run(['update-index', '-z', '--index-info'], Buffer.from(updates.join('')));
    const tree = await text(['write-tree']);
    if (tree === oldTree) { checkCanceled(); return { commitSha: head, changed: 0 }; }
    phase = 'committing';
    current = '';
    progress();
    const commitSha = await text(['commit-tree', tree, '-p', head], Buffer.from(message || 'Upload files via RepoDrive'));
    const remoteHead = async () => {
      const line = await text(['ls-remote', '--exit-code', 'origin', ref]);
      const row = line.split('\n').find((entry) => entry.split('\t')[1] === ref);
      return row?.split('\t')[0];
    };
    if (await remoteHead() !== head) throw Object.assign(new Error('远端分支已变化，上传被拒绝，请刷新后重试'), { code: 'GIT_CONFLICT' });
    checkCanceled();
    pushStarted = true;
    phase = 'uploading';
    progress();
    // An ordinary push rejects concurrent non-fast-forward changes. Never force,
    // rebase, retry a write, or treat pack completion as the remote acknowledgement.
    await run(['push', '--progress', '--porcelain', 'origin', `${commitSha}:${ref}`]);
    phase = 'committing';
    progress();
    if (await remoteHead() !== commitSha) {
      throw Object.assign(new Error('远端分支已变化，无法确认上传结果，请刷新确认远端是否已提交'), { code: 'GIT_REMOTE_UNCONFIRMED' });
    }
    checkCanceled();
    return { commitSha, changed };
  } catch (error) {
    primaryError = error;
    if (signal?.aborted) throw canceled(pushStarted);
    error.message = redact(error.message);
    throw error;
  } finally {
    const cleanupErrors = [];
    try { await stopCredentials?.(); } catch (error) { cleanupErrors.push(error); }
    try { await fs.rm(temp, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      const detail = `临时上传目录清理失败：${temp}`;
      if (primaryError) primaryError.message += `；${detail}`;
      else throw Object.assign(new Error(`${detail}${pushStarted ? '；远端可能已提交，请刷新确认' : ''}`), { code: 'GIT_CLEANUP_FAILED' });
    }
  }
}

module.exports = { commitViaGit };
