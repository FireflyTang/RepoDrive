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

test('Windows application source contains no upload implementation', () => {
  const textFiles = files(root).filter((file) => /\.(js|json|html|css)$/.test(file));
  for (const file of textFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /repo:upload|uploadFiles|uploadDirectory|uploadFile|uploadDropped|repo:rename|method\s*:\s*['"`](?:PUT|POST|PATCH)/i, path.relative(root, file));
  }
});

test('Windows IPC surface allows delete but has no upload channel', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const channels = [...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(channels, ['repo:connect', 'repo:delete', 'repo:download', 'repo:list', 'settings:get', 'settings:save']);
});

test('Windows network mutations are limited to DELETE', () => {
  const service = fs.readFileSync(path.join(root, 'github-read-service.js'), 'utf8');
  assert.match(service, /method:'DELETE'/);
  assert.doesNotMatch(service, /method\s*:\s*['"`](?:PUT|POST|PATCH)/i);
});
