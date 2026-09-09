'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'platform', 'windows');

function files(dir, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files(target, result);
    else result.push(target);
  }
  return result;
}

test('Windows application source contains no write or upload implementation', () => {
  const textFiles = files(root).filter((file) => /\.(js|json|html|css)$/.test(file));
  for (const file of textFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /\bupload\b|上传|repo:upload|method\s*:\s*['"`](?:PUT|POST|PATCH|DELETE)/i, path.relative(root, file));
  }
});

test('Windows IPC surface is an explicit read-only allowlist', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const channels = [...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(channels, ['repo:connect', 'repo:download', 'repo:list', 'settings:get', 'settings:save']);
});
