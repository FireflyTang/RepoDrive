'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('multi-file uploads use one Git tree commit', () => {
  const service = read('src/github-service.js');
  const main = read('src/main.js');
  assert.match(service, /async commitChanges\(/);
  assert.match(service, /\/git\/blobs/);
  assert.match(service, /\/git\/trees/);
  assert.match(service, /parents:\s*\[head\.commitSha\]/);
  assert.match(main, /github\.commitChanges\(changes/);
  assert.doesNotMatch(main.match(/async function uploadLocalFiles[\s\S]*?\n}/)?.[0] || '', /github\.uploadFile/);
});

test('macOS renderer exposes clipboard upload and batch deletion', () => {
  const main = read('src/main.js');
  const preload = read('src/preload.js');
  const renderer = read('src/renderer/app.js');
  assert.match(main, /repo:uploadClipboard/);
  assert.match(main, /clipboard\.readImage\(\)/);
  assert.match(main, /repo:deleteBatch/);
  assert.match(preload, /api\.uploadClipboard/);
  assert.match(preload, /api\.deleteBatch/);
  assert.match(renderer, /addEventListener\('paste'/);
  assert.match(renderer, /selectedItems:\s*new Map\(\)/);
});

test('Windows package has none of the new write surfaces', () => {
  const windows = ['platform/windows/main.js', 'platform/windows/preload.js', 'platform/windows/renderer/app.js'].map(read).join('\n');
  assert.doesNotMatch(windows, /uploadClipboard|deleteBatch|commitChanges/);
});

test('macOS follows the system proxy by default and times out failed GitHub requests', () => {
  const main = read('src/main.js');
  const service = read('src/github-service.js');
  assert.match(main, /proxy \? \{ proxyRules: proxy \} : \{ mode: 'system' \}/);
  assert.match(service, /AbortSignal\.timeout\(30000\)/);
  assert.match(service, /无法连接 GitHub/);
});
