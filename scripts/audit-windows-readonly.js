'use strict';

const path = require('node:path');
const asar = require('@electron/asar');

const archive = path.join(__dirname, '..', 'dist', 'windows-readonly', 'win-unpacked', 'resources', 'app.asar');
const entries = asar.listPackage(archive);
const allowed = new Set([
  '/file-history.js', '/repository-maintenance.js', '/windows-request-policy.js', '/renderer/maintenance.js', '/github-read-service.js', '/main.js', '/package.json', '/preload.js', '/renderer',
  '/renderer/app.js', '/renderer/delete-actions.css', '/renderer/index.html', '/renderer/styles.css',
  '/repodrive.config.json', '/settings-store.js', '/validation.js'
]);
const forbidden = /repo:upload|uploadFiles|uploadDirectory|uploadFile|uploadDropped|repo:rename|method\s*:\s*['"`]PUT/i;

for (const entry of entries) {
  if (!allowed.has(entry)) throw new Error(`Windows 包含白名单外文件: ${entry}`);
  if (entry === '/renderer') continue;
  const content = asar.extractFile(archive, entry.slice(1)).toString();
  if (entry !== '/repository-maintenance.js' && /method\s*:\s*['"`](?:POST|PATCH)/i.test(content)) throw new Error(`Windows 清理模块以外出现新增写入: ${entry}`);
  if (forbidden.test(content)) throw new Error(`Windows 包含上传功能: ${entry}`);
}

const service = asar.extractFile(archive, 'github-read-service.js').toString();
if (!service.includes('assertWindowsRequest(apiPath, options, config)')) throw new Error('Windows 请求白名单缺失');

console.log(`Windows 无上传审计通过：${entries.length} 个条目，允许读取、下载、删除及限定的历史清理，不包含上传实现或 CLI。`);
