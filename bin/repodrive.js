#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fetch, ProxyAgent } = require('undici');
const { parseRepository, normalizeRepoPath, validateBranch, validateProxy } = require('../src/validation');
const { assertUploadAllowed, assertCredentialPolicy } = require('../src/platform-policy');

function usage() {
  console.log(`RepoDrive CLI

用法:
  repodrive list [远程路径] [选项]
  repodrive download <远程路径> --output <本地路径> [选项]
  repodrive upload <本地文件或目录> [--path <远程父目录>] [选项]
  repodrive info [选项]
  repodrive configure --repo owner/repo [选项]

公共选项:
  --config 文件           固定配置文件（默认自动查找 repodrive.config.json）
  --repo owner/repo       临时覆盖配置文件中的代码仓
  --branch main           分支（默认 main）
  --root shared/files     仓库内根目录
  --proxy http://host:port  HTTP/HTTPS 代理
  --message 文本          上传提交说明
  --json                  输出机器可读 JSON

认证顺序: REPODRIVE_TOKEN 环境变量，其次读取 gh CLI 当前登录 Token。
Windows 只允许 list、download 和 info，upload 会在联网前被拒绝。`);
}

function parseArgs(argv) {
  const result = { _: [] };
  const valueOptions = new Set(['config', 'repo', 'branch', 'root', 'path', 'output', 'proxy', 'message']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) result._.push(arg);
    else {
      const key = arg.slice(2);
      if (valueOptions.has(key)) {
        if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`--${key} 缺少值`);
        result[key] = argv[++i];
      } else if (key === 'json' || key === 'help') result[key] = true;
      else throw new Error(`未知选项: --${key}`);
    }
  }
  return result;
}

function getToken() {
  if (process.env.REPODRIVE_TOKEN) return process.env.REPODRIVE_TOKEN.trim();
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

function loadConfig(args) {
  const candidates = [
    args.config,
    process.env.REPODRIVE_CONFIG,
    path.join(process.cwd(), 'repodrive.config.json'),
    path.join(os.homedir(), '.config', 'repodrive', 'config.json'),
    path.join(__dirname, '..', 'repodrive.config.json')
  ].filter(Boolean);
  const selected = candidates.find((candidate) => fsSync.existsSync(path.resolve(candidate)));
  if (!selected) return { data: {}, path: '' };
  const absolute = path.resolve(selected);
  try { return { data: JSON.parse(fsSync.readFileSync(absolute, 'utf8')), path: absolute }; }
  catch (error) { throw new Error(`无法读取配置文件 ${absolute}: ${error.message}`); }
}

async function saveConfiguration(args, current) {
  const repository = args.repo || current.repository;
  if (!repository || repository === 'OWNER/REPOSITORY') throw new Error('configure 需要 --repo owner/repository');
  const parsed = parseRepository(repository);
  const data = {
    repository: `${parsed.owner}/${parsed.repo}`,
    branch: validateBranch(args.branch || current.branch || 'main'),
    rootPath: normalizeRepoPath(args.root || current.rootPath || ''),
    proxy: validateProxy(args.proxy || current.proxy || '')
  };
  const explicit = args.config || process.env.REPODRIVE_CONFIG;
  const projectConfig = path.join(process.cwd(), 'repodrive.config.json');
  const target = path.resolve(explicit || (fsSync.existsSync(projectConfig) ? projectConfig : path.join(os.homedir(), '.config', 'repodrive', 'config.json')));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return { configured: true, config: target, ...data };
}

function joinRepoPath(...parts) { return parts.map(normalizeRepoPath).filter(Boolean).join('/'); }
function encodePath(value) { return value.split('/').filter(Boolean).map(encodeURIComponent).join('/'); }

class Client {
  constructor(config) { this.config = config; this.dispatcher = config.proxy ? new ProxyAgent(config.proxy) : undefined; }
  async request(apiPath, options = {}) {
    const headers = { Accept: options.accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'RepoDrive-CLI/0.5' };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    const response = await fetch(`https://api.github.com${apiPath}`, { method: options.method || 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined, dispatcher: this.dispatcher });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).message || ''; } catch { detail = await response.text(); }
      const error = new Error(`GitHub ${response.status}: ${detail || response.statusText}`); error.status = response.status; throw error;
    }
    if (options.raw) return Buffer.from(await response.arrayBuffer());
    return response.status === 204 ? null : response.json();
  }
  prefix() { return `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`; }
  async info() { return this.request(this.prefix()); }
  async list(remotePath = '') {
    const suffix = remotePath ? `/${encodePath(remotePath)}` : '';
    const value = await this.request(`${this.prefix()}/contents${suffix}?ref=${encodeURIComponent(this.config.branch)}`);
    return (Array.isArray(value) ? value : [value]).map(({ name, path: itemPath, type, size, sha }) => ({ name, path: itemPath, type, size, sha })).sort((a,b)=>(a.type===b.type?a.name.localeCompare(b.name):a.type==='dir'?-1:1));
  }
  async raw(remotePath) { return this.request(`${this.prefix()}/contents/${encodePath(remotePath)}?ref=${encodeURIComponent(this.config.branch)}`, { accept: 'application/vnd.github.raw+json', raw: true }); }
  async upload(remotePath, bytes, message) {
    let sha;
    try { sha = (await this.request(`${this.prefix()}/contents/${encodePath(remotePath)}?ref=${encodeURIComponent(this.config.branch)}`)).sha; } catch (error) { if (error.status !== 404) throw error; }
    return this.request(`${this.prefix()}/contents/${encodePath(remotePath)}`, { method: 'PUT', body: { message: message || `Upload ${remotePath} via RepoDrive CLI`, content: Buffer.from(bytes).toString('base64'), branch: this.config.branch, ...(sha ? { sha } : {}) } });
  }
  close() { return this.dispatcher?.close(); }
}

async function downloadTree(client, remotePath, destination, progress) {
  const items = await client.list(remotePath); await fs.mkdir(destination, { recursive: true });
  for (const item of items) {
    const target = path.join(destination, item.name);
    if (item.type === 'dir') await downloadTree(client, item.path, target, progress);
    else { progress(item.path); await fs.writeFile(target, await client.raw(item.path)); }
  }
}

async function collectFiles(root, current = root, result = []) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const localPath = path.join(current, entry.name);
    if (entry.isDirectory()) await collectFiles(root, localPath, result);
    else if (entry.isFile()) result.push({ localPath, relative: path.relative(root, localPath).split(path.sep).join('/') });
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2)); const command = args._[0];
  if (!command || args.help || command === 'help') return usage();
  const loaded = loadConfig(args); const fixed = loaded.data;
  if (command === 'configure') {
    console.log(JSON.stringify(await saveConfiguration(args, fixed), null, args.json ? 0 : 2));
    return;
  }
  const repository = args.repo || process.env.REPODRIVE_REPO || fixed.repository;
  if (!repository || repository === 'OWNER/REPOSITORY') throw new Error('请先运行 repodrive configure --repo owner/repository 完成一次性配置');
  const parsed = parseRepository(repository);
  const config = { ...parsed, branch: validateBranch(args.branch || process.env.REPODRIVE_BRANCH || fixed.branch || 'main'), root: normalizeRepoPath(args.root || process.env.REPODRIVE_ROOT || fixed.rootPath || ''), proxy: validateProxy(args.proxy || process.env.REPODRIVE_PROXY || fixed.proxy || ''), token: getToken() };
  const client = new Client(config); const emit = (value) => console.log(JSON.stringify(value, null, args.json ? 0 : 2)); const progress = (value) => { if (!args.json) console.error(`→ ${value}`); };
  try {
    if (command === 'info') {
      const repo = await client.info(); assertCredentialPolicy(repo.permissions || {}); emit({ repository: repo.full_name, private: repo.private, defaultBranch: repo.default_branch, permissions: repo.permissions });
    } else if (command === 'list') {
      emit(await client.list(joinRepoPath(config.root, args._[1] || '')));
    } else if (command === 'download') {
      const requested = args._[1]; if (!requested) throw new Error('download 需要远程路径');
      const remote = joinRepoPath(config.root, requested); const info = await client.list(remote); const first = info.length === 1 && info[0].path === remote ? info[0] : null;
      const output = path.resolve(args.output || path.basename(requested));
      if (first && first.type !== 'dir') { progress(remote); await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, await client.raw(remote)); }
      else await downloadTree(client, remote, output, progress);
      emit({ downloaded: requested, output });
    } else if (command === 'upload') {
      assertUploadAllowed();
      const localInput = args._[1]; if (!localInput) throw new Error('upload 需要本地文件或目录');
      const local = path.resolve(localInput); const stat = await fs.stat(local); const parent = joinRepoPath(config.root, args.path || '');
      let files;
      if (stat.isDirectory()) { files = await collectFiles(local); if (!files.length) throw new Error('目录内没有可上传文件'); if (files.length > 1000) throw new Error('单次最多上传 1000 个文件'); files = files.map((file)=>({ ...file, remote: joinRepoPath(parent, path.basename(local), file.relative) })); }
      else files = [{ localPath: local, relative: path.basename(local), remote: joinRepoPath(parent, path.basename(local)) }];
      const repo = await client.info(); assertCredentialPolicy(repo.permissions || {});
      for (let i=0;i<files.length;i+=1) { const file=files[i]; const size=(await fs.stat(file.localPath)).size; if(size>100*1024*1024) throw new Error(`${file.relative} 超过 100 MB`); progress(`${i+1}/${files.length} ${file.remote}`); await client.upload(file.remote, await fs.readFile(file.localPath), args.message); }
      emit({ uploaded: files.length, destination: parent || '/', paths: files.map((file)=>file.remote) });
    } else throw new Error(`未知命令: ${command}`);
  } finally { await client.close(); }
}

main().catch((error) => { console.error(`RepoDrive: ${error.message}`); process.exitCode = 1; });
