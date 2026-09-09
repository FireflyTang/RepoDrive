'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canUpload, assertUploadAllowed, assertCredentialPolicy } = require('../src/platform-policy');

test('macOS and Linux are allowed to upload', () => {
  assert.equal(canUpload('darwin'), true);
  assert.equal(canUpload('linux'), true);
  assert.equal(canUpload('win32'), false);
});

test('Windows upload calls are rejected', () => {
  assert.throws(() => assertUploadAllowed('win32'), { code: 'UPLOAD_PLATFORM_BLOCKED' });
});

test('Windows accepts writable credentials for delete while upload remains blocked', () => {
  assert.doesNotThrow(() => assertCredentialPolicy({ pull: true, push: false }, 'win32'));
  assert.doesNotThrow(() => assertCredentialPolicy({ pull: true, push: true }, 'win32'));
  assert.throws(() => assertUploadAllowed('win32'), { code: 'UPLOAD_PLATFORM_BLOCKED' });
  assert.doesNotThrow(() => assertCredentialPolicy({ pull: true, push: true }, 'darwin'));
  assert.doesNotThrow(() => assertCredentialPolicy({ pull: true, push: true }, 'linux'));
});
