'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('macOS client exposes confirmed file and directory deletion', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('repo:delete'/);
  assert.match(main, /showMessageBox/);
  assert.match(main, /deleteTree/);
  assert.match(preload, /repo:delete/);
});

test('Windows delete also requires confirmation and a token', () => {
  const main = fs.readFileSync(path.join(root, 'platform', 'windows', 'main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('repo:delete'/);
  assert.match(main, /showMessageBox/);
  assert.match(main, /if\(!config\(\)\.token\)/);
});

test('GitHub requests bypass stale caches after deletion', () => {
  for (const relative of ['src/github-service.js', 'platform/windows/github-read-service.js']) {
    assert.match(fs.readFileSync(path.join(root, relative), 'utf8'), /cache:\s*['"]no-store['"]/, relative);
  }
});
