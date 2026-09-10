'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

function ghCandidates(platform = process.platform, env = process.env) {
  if (!['darwin', 'linux'].includes(platform)) return [];
  const fromPath = String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, 'gh'));
  const common = platform === 'darwin'
    ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/opt/local/bin/gh']
    : ['/usr/local/bin/gh', '/usr/bin/gh', '/snap/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh'];
  return [...new Set([...fromPath, ...common, 'gh'])];
}

function localGitHubToken(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const execute = options.execFileSync || execFileSync;
  for (const executable of ghCandidates(platform, env)) {
    try {
      const token = execute(executable, ['auth', 'token'], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      }).trim();
      if (token) return token;
    } catch { /* try the next known installation path */ }
  }
  return '';
}

module.exports = { ghCandidates, localGitHubToken };
