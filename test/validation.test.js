'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRepoPath, parseRepository, validateBranch, validateProxy } = require('../src/validation');

test('repository accepts slug and GitHub URL', () => {
  assert.deepEqual(parseRepository('octo/repo'), { owner: 'octo', repo: 'repo' });
  assert.deepEqual(parseRepository('https://github.com/octo/repo.git'), { owner: 'octo', repo: 'repo' });
});

test('paths cannot escape configured root', () => {
  assert.equal(normalizeRepoPath('/shared\\docs/'), 'shared/docs');
  assert.throws(() => normalizeRepoPath('../secret'));
});

test('proxy requires HTTP protocol and port', () => {
  assert.equal(validateProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.throws(() => validateProxy('socks5://127.0.0.1:7890'));
});

test('branch rejects invalid refs', () => {
  assert.equal(validateBranch('main'), 'main');
  assert.throws(() => validateBranch('../main'));
});
