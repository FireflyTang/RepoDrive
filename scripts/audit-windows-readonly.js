'use strict';

const path = require('node:path');
const asar = require('@electron/asar');

const archive = path.join(__dirname, '..', 'dist', 'windows-readonly', 'win-unpacked', 'resources', 'app.asar');
const entries = asar.listPackage(archive);
const allowed = new Set([
  '/github-read-service.js', '/main.js', '/package.json', '/preload.js', '/renderer',
  '/renderer/app.js', '/renderer/delete-actions.css', '/renderer/index.html', '/renderer/styles.css',
  '/repodrive.config.json', '/settings-store.js', '/validation.js'
]);
const forbidden = /repo:upload|uploadFiles|uploadDirectory|uploadFile|uploadDropped|repo:rename|method\s*:\s*['"`](?:PUT|POST|PATCH)/i;

for (const entry of entries) {
  if (!allowed.has(entry)) throw new Error(`Windows 包含白名单外文件: ${entry}`);
  if (entry === '/renderer') continue;
  const content = asar.extractFile(archive, entry.slice(1)).toString();
  if (forbidden.test(content)) throw new Error(`Windows 包含上传功能: ${entry}`);
}

console.log(`Windows 无上传审计通过：${entries.length} 个条目，仅允许读取、下载和删除，不包含上传实现或 CLI。`);
