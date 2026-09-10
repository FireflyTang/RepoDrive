const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('macOS build signs before creating archives and verifies the finished DMG', () => {
  const pkg = require(path.join(root, 'package.json'));
  const afterPack = fs.readFileSync(path.join(root, 'scripts/after-pack.js'), 'utf8');
  const verify = fs.readFileSync(path.join(root, 'scripts/verify-mac-package.js'), 'utf8');

  assert.equal(pkg.build.afterPack, 'scripts/after-pack.js');
  assert.match(pkg.scripts['pack:mac'], /verify-mac-package/);
  assert.match(afterPack, /codesign/);
  assert.match(afterPack, /--deep/);
  assert.match(verify, /hdiutil/);
  assert.match(verify, /codesign/);
});
