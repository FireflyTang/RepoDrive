'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/audit-windows-readonly.js'), 'utf8');
function audit(entries, content = '') {
  vm.runInNewContext(source, {
    __dirname: '/mock/scripts',
    console: { log() {} },
    require(name) {
      if (name === 'node:path') return path;
      if (name === '@electron/asar') return {
        listPackage: () => entries,
        extractFile(_archive, file) {
          if (file === 'github-read-service.js') return Buffer.from('assertWindowsRequest(apiPath, options, config)');
          return Buffer.from(content);
        }
      };
      throw Error(name);
    }
  });
}
test('Windows package audit accepts native and POSIX ASAR entry separators', () => {
  for (const sep of ['/', '\\']) {
    assert.doesNotThrow(() => audit([sep+'main.js', sep+'renderer', sep+'renderer'+sep+'app.js']));
  }
});
test('normalizing ASAR paths does not relax file or upload restrictions', () => {
  assert.throws(() => audit(['\\unexpected.js']), /白名单外/);
  assert.throws(() => audit(['\\main.js'], 'repo:upload'), /包含上传功能/);
  assert.throws(() => audit(['\\main.js'], 'method: "POST"'), /新增写入/);
});
