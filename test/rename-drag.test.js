'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('macOS client exposes file and directory rename without exposing it to Windows', () => {
  const main = read('src/main.js');
  const preload = read('src/preload.js');
  const renderer = read('src/renderer/app.js');
  const windows = ['platform/windows/main.js', 'platform/windows/preload.js', 'platform/windows/renderer/app.js'].map(read).join('\n');

  assert.match(main, /ipcMain\.handle\('repo:rename'/);
  assert.match(main, /collectRemoteFiles/);
  assert.match(main, /assertRemotePathMissing/);
  assert.match(preload, /api\.rename/);
  assert.match(renderer, /openRename/);
  assert.doesNotMatch(windows, /repo:rename|uploadDropped|api\.rename/);
});

test('drag and drop always uploads to the configured root', () => {
  const main = read('src/main.js');
  const preload = read('src/preload.js');
  const renderer = read('src/renderer/app.js');

  assert.match(preload, /api\.getPathForFile\s*=\s*\(file\)\s*=>\s*webUtils\.getPathForFile\(file\)/);
  assert.match(main, /uploadLocalFiles\(files, ''\)/);
  assert.match(renderer, /dropZone\.addEventListener\('drop'/);
  assert.match(renderer, /getPathForFile\(file\)/);
  assert.match(renderer, /uploadDropped\(paths\)/);
  assert.match(read('src/renderer/index.html'), /上传到根目录/);
});

test('CLI supports rename and blocks it on Windows through the upload policy', () => {
  const cli = read('bin/repodrive.js');
  assert.match(cli, /command === 'rename'/);
  assert.match(cli, /assertUploadAllowed\(\);\s*\n\s*const requested/);
  assert.match(cli, /collectRemoteFiles/);
  assert.match(cli, /client\.delete/);
});
