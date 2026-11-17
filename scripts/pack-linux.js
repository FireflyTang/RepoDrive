'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectDir = path.resolve(__dirname, '..');

// Resolve existing ancestors too, so a symlink cannot redirect output into sources.
function realOutputPath(value) {
  let ancestor = path.resolve(value);
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

function buildArguments(args) {
  const options = [...args];
  const outputFlag = '--config.directories.output';
  const first = options.shift() || '';
  const value = first === outputFlag ? options.shift() :
    first.startsWith(`${outputFlag}=`) ? first.slice(outputFlag.length + 1) : '';
  if (!value || !path.isAbsolute(value) || options.length > 1 ||
      (options[0] && !['--x64', '--arm64'].includes(options[0]))) {
    throw new Error('Usage: npm run pack:linux -- --config.directories.output=/absolute/external/directory [--x64|--arm64]');
  }
  const output = realOutputPath(value);
  const sources = fs.realpathSync(path.resolve(projectDir, '..'));
  const relative = path.relative(sources, output);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Linux build output must be outside the source parent directory; use the chat work/ or outputs/.');
  }
  return [
    '--projectDir', projectDir, '--linux', '--publish', 'never',
    `--config.directories.output=${output}`,
    ...options,
  ];
}

if (require.main === module) {
  try {
    const args = buildArguments(process.argv.slice(2));
    const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...args], {
      cwd: projectDir,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildArguments };
