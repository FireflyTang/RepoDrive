'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ghCandidates, localGitHubToken } = require('../src/local-gh-auth');

test('macOS checks Homebrew paths even when Finder PATH does not contain them', () => {
  const candidates = ghCandidates('darwin', { PATH: '/usr/bin:/bin' });
  assert.ok(candidates.includes('/opt/homebrew/bin/gh'));
  assert.ok(candidates.includes('/usr/local/bin/gh'));
});

test('local token lookup falls back to Apple Silicon Homebrew gh', () => {
  const calls = [];
  const token = localGitHubToken({
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    execFileSync(executable) {
      calls.push(executable);
      if (executable === '/opt/homebrew/bin/gh') return 'from-keychain\n';
      throw new Error('not found');
    }
  });
  assert.equal(token, 'from-keychain');
  assert.ok(calls.includes('/opt/homebrew/bin/gh'));
});

test('Windows desktop never reads gh credentials', () => {
  let called = false;
  const token = localGitHubToken({
    platform: 'win32',
    env: { PATH: 'C:\\tools' },
    execFileSync() { called = true; return 'unexpected'; }
  });
  assert.equal(token, '');
  assert.equal(called, false);
});
