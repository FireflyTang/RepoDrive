'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('desktop repository settings are editable and not locked by presets', () => {
  for (const relative of [
    'src/settings-store.js',
    'src/main.js',
    'src/renderer/app.js',
    'platform/windows/settings-store.js',
    'platform/windows/main.js',
    'platform/windows/renderer/app.js'
  ]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, relative), 'utf8'), /fixedRepository/, relative);
  }
});

test('packaged defaults require one-time repository setup', () => {
  for (const relative of ['repodrive.config.json', 'platform/windows/repodrive.config.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
    assert.equal(config.repository, '', relative);
  }
});
