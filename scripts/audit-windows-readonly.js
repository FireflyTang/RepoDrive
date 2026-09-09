'use strict';

const path = require('node:path');
const asar = require('@electron/asar');

const archive = path.join(__dirname, '..', 'dist', 'windows-readonly', 'win-unpacked', 'resources', 'app.asar');
const entries = asar.listPackage(archive);
const allowed = new Set([
  '/github-read-service.js', '/main.js', '/package.json', '/preload.js', '/renderer',
  '/renderer/app.js', '/renderer/index.html', '/renderer/styles.css',
  '/repodrive.config.json', '/settings-store.js', '/validation.js'
]);
const forbidden = /\bupload\b|上传|repo:upload|method\s*:\s*['"`](?:PUT|POST|PATCH|DELETE)/i;

for (const entry of entries) {
  if (!allowed.has(entry)) throw new Error(`Windows 包含白名单外文件: ${entry}`);
  if (entry === '/renderer') continue;
  const content = asar.extractFile(archive, entry.slice(1)).toString();
  if (forbidden.test(content)) throw new Error(`Windows 包含写入功能: ${entry}`);
}

console.log(`Windows 只读审计通过：${entries.length} 个条目，未包含上传实现、写请求或 CLI。`);
