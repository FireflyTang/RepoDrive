'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('desktop renderers use expandable directory trees and SVG icons', () => {
  for (const relative of ['src/renderer/app.js', 'platform/windows/renderer/app.js']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /tree:\s*new Map\(\)/, relative);
    assert.match(source, /expanded:\s*new Set\(\)/, relative);
    assert.match(source, /toggleDirectory/, relative);
    assert.match(source, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg'/, relative);
  }
});

test('macOS tree tracks one selected upload destination', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
  assert.match(source, /selectedPath/);
  assert.match(source, /window\.repoDrive\[method\]\(state\.selectedPath\)/);
});
