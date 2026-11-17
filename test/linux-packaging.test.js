'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildArguments } = require('../scripts/pack-linux');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const outputFlag = '--config.directories.output';

test('Linux archives package the shared macOS application and renderer', () => {
  assert.equal(pkg.main, 'src/main.js');
  assert.equal(pkg.scripts['pack:linux'], 'node scripts/pack-linux.js');
  assert.deepEqual(pkg.build.linux.target, ['tar.gz', 'AppImage']);
  assert.equal(pkg.build.asar, true);
  assert.equal(pkg.build.extraMetadata?.main, undefined);
  assert.equal(pkg.build.linux.extraMetadata?.main, undefined);
  for (const file of ['src/**/*', 'bin/**/*', 'repodrive.config.json', 'package.json', 'README.md', 'LICENSE']) {
    assert.ok(pkg.build.files.includes(file), `${file} must be packaged`);
  }
  assert.equal(pkg.build.linux.category, 'Utility');
  assert.equal(pkg.build.linux.artifactName, '${productName}-${version}-linux-${arch}.${ext}');
  const icon = fs.readFileSync(path.join(root, pkg.build.linux.icon));
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(icon.readUInt32BE(16), 512);
  assert.equal(icon.readUInt32BE(20), 512);
  assert.ok(fs.existsSync(path.join(root, 'assets/linux/icon.svg')));
});

test('Linux packaging accepts external absolute output overrides and architecture', () => {
  const output = path.join(fs.realpathSync(os.tmpdir()), 'repodrive-linux-package');
  const expected = [
    '--projectDir', root, '--linux', '--publish', 'never', `${outputFlag}=${output}`,
  ];
  assert.deepEqual(buildArguments([`${outputFlag}=${output}`]), expected);
  assert.deepEqual(buildArguments([outputFlag, output, '--x64']), [...expected, '--x64']);
  assert.deepEqual(buildArguments([`${outputFlag}=${output}`, '--arm64']), [...expected, '--arm64']);
});

test('Linux packaging refuses missing, relative, source-tree or extra overrides', () => {
  for (const args of [
    [], [outputFlag], [`${outputFlag}=outputs`],
    [`${outputFlag}=${root}`], [`${outputFlag}=${path.join(root, 'dist')}`],
    [`${outputFlag}=${path.resolve(root, '..', 'other-source', 'dist')}`],
    [`${outputFlag}=${os.tmpdir()}`, '--config.asar=false'],
    [`${outputFlag}=${os.tmpdir()}`, '--x64', '--arm64'],
  ]) assert.throws(() => buildArguments(args));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/pack-linux.js')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('Linux output validation resolves symlinks before checking source boundaries', (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation requires Windows privileges');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'repodrive-linux-output-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const link = path.join(fixture, 'source-link');
  fs.symlinkSync(root, link, 'dir');
  assert.throws(() => buildArguments([`${outputFlag}=${path.join(link, 'new-output')}`]), /outside/);
});

test('Linux afterPack skips the macOS signing hook', async () => {
  const afterPack = require(path.join(root, pkg.build.afterPack)).default;
  await afterPack({ electronPlatformName: 'linux' });
});

const workflow = fs.readFileSync(path.join(root, '.github/workflows/build.yml'), 'utf8').replace(/\r\n/g, '\n');

function workflowScript(name) {
  const step = workflow.split(`      - name: ${name}\n`)[1];
  assert.ok(step, `missing workflow step: ${name}`);
  const match = step.match(/        run: \|\n((?:          [^\n]*\n|\n)+)/);
  assert.ok(match, `missing script: ${name}`);
  return match[1].split('\n').map(line => line.slice(10)).join('\n');
}

test('CI builds each desktop platform in runner temporary storage with distributable-only uploads', () => {
  // GitHub evaluates job defaults/env before runner context is available.
  assert.doesNotMatch(workflow.match(/    defaults:\n(?:      .*\n)*/)?.[0] || '', /runner\.temp/);
  assert.match(workflowScript('Set release directories'), /RELEASE_ASSETS=\$RUNNER_TEMP\/release-assets/);
  assert.match(workflow, /os: ubuntu-22\.04\s+command: npm run pack:linux -- --config\.directories\.output="\$RUNNER_TEMP\/repodrive-linux" --x64/);
  assert.match(workflow, /os: macos-latest\s+command: npx electron-builder --mac dmg zip --arm64 --publish never && node scripts\/verify-mac-package.js/);
  assert.match(workflow, /working-directory: \$\{\{ runner\.temp \}\}\/repodrive-source\/checkout/);
  assert.match(workflowScript('Prepare temporary build source'), /cp -R "\$GITHUB_WORKSPACE\/\." "\$RUNNER_TEMP\/repodrive-source\/checkout\/"/);
  for (const extension of ['AppImage', 'tar.gz']) {
    assert.ok(workflow.includes('${{ runner.temp }}/repodrive-linux/*.' + extension));
  }
  for (const extension of ['dmg', 'zip']) {
    assert.ok(workflow.includes('${{ runner.temp }}/repodrive-source/checkout/dist/*.' + extension));
  }
  assert.ok(workflow.includes('${{ runner.temp }}/repodrive-source/checkout/dist/windows-readonly/*.exe'));
  assert.equal((workflow.match(/if-no-files-found: error/g) || []).length, 3);
  assert.doesNotMatch(workflow, /path: dist\/\*\*\/\*/);
});

test('CI enables real Electron transport and renderer tests with xvfb and temporary outputs', () => {
  assert.match(workflow, /sudo apt-get install -y xvfb .*libgtk-3-0/);
  assert.match(workflowScript('Test CLI, real Electron transport and renderer'), /xvfb-run -a npm test/);
  assert.match(workflow, /REPODRIVE_ELECTRON_TEST: '1'/);
  for (const variable of ['REPODRIVE_ELECTRON_TEST_WORK', 'REPODRIVE_RENDERER_TEST_WORK']) {
    assert.match(workflow, new RegExp(`${variable}: \\$\\{\\{ runner\\.temp \\}\\}/`));
  }
});

test('Release is tag-push-only, waits for every build/test, and alone has write permission', () => {
  const release = workflow.split('\n  release:\n')[1];
  assert.ok(release);
  assert.match(release, /needs: \[test-linux-cli, build\]/);
  assert.match(release, /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.equal((workflow.match(/contents: write/g) || []).length, 1);
  assert.match(release, /permissions:\s+contents: write/);
  assert.match(release, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(release, /actions\/download-artifact@v4/);
  assert.match(release, /merge-multiple: false/);
  assert.doesNotMatch(release, /always\(\)|continue-on-error/);
  const pack = workflowScript('Package CLI, source and checksums');
  assert.match(pack, /npm pack --ignore-scripts --pack-destination "\$RELEASE_ASSETS"/);
  assert.match(pack, /git archive .*--output="\$RELEASE_ASSETS\/RepoDrive-\$version-source.zip" HEAD/);
  assert.match(pack, /sha256sum -- \* > SHA256SUMS.txt/);
});

function releaseFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repodrive-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const incoming = path.join(directory, 'incoming');
  const output = path.join(directory, 'assets');
  for (const platform of ['Linux', 'macOS', 'Windows']) {
    fs.mkdirSync(path.join(incoming, `RepoDrive-${platform}`), { recursive: true });
  }
  const put = (platform, name) => {
    const file = path.join(incoming, `RepoDrive-${platform}`, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name);
  };
  return { directory, incoming, output, put };
}

function collectAssets(fixture, tag = `v${pkg.version}`) {
  const script = workflowScript('Collect distributable assets').match(/node <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  return spawnSync(process.execPath, ['-e', script], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: tag, RELEASE_INCOMING: fixture.incoming, RELEASE_ASSETS: fixture.output },
  });
}

function putDistributables(fixture) {
  fixture.put('Linux', 'RepoDrive-linux.AppImage');
  fixture.put('Linux', 'RepoDrive-linux.tar.gz');
  fixture.put('macOS', 'RepoDrive-arm64.dmg');
  fixture.put('macOS', 'RepoDrive-arm64-mac.zip');
  fixture.put('Windows', 'RepoDrive Setup.exe');
  fixture.put('Windows', 'RepoDrive-portable.exe');
  fixture.put('Windows', 'RepoDrive-win.zip');
}

test('Release collector admits every distributable extension but ignores unpacked trees and debug files', (t) => {
  const fixture = releaseFixture(t);
  putDistributables(fixture);
  for (const platform of ['Linux', 'macOS', 'Windows']) {
    for (const folder of ['linux-unpacked', 'win-unpacked', 'mac', 'nested/deep']) {
      for (const extension of ['exe', 'zip', 'dmg', 'AppImage', 'tar.gz']) {
        fixture.put(platform, `${folder}/unwanted.${extension}`);
      }
    }
    for (const name of ['builder-debug.yml', 'app.pdb', 'app.exe.blockmap', 'debug.zip', 'app-symbols.tar.gz', 'linux-unpacked.zip']) {
      fixture.put(platform, name);
    }
  }
  const result = collectAssets(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(fixture.output).sort(), [
    'RepoDrive.Setup.exe', 'RepoDrive-arm64-mac.zip', 'RepoDrive-arm64.dmg', 'RepoDrive-linux.AppImage',
    'RepoDrive-linux.tar.gz', 'RepoDrive-portable.exe', 'RepoDrive-win.zip',
  ].sort());
});

test('Release collector rejects duplicate names, missing platforms, and mismatched version tags', (t) => {
  const fixture = releaseFixture(t);
  putDistributables(fixture);
  fixture.put('Windows', 'repodrive-arm64.dmg');
  const duplicate = collectAssets(fixture);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Duplicate release asset/);
  fs.rmSync(fixture.output, { recursive: true, force: true });
  fs.rmSync(path.join(fixture.incoming, 'RepoDrive-Windows'), { recursive: true, force: true });
  assert.notEqual(collectAssets(fixture).status, 0);
  assert.match(collectAssets(fixture, 'v0.0.0').stderr, /Tag\/package version mismatch/);
});

test('Release upload preserves existing notes, publishes only after upload success, and supports reruns', (t) => {
  if (process.platform !== 'linux') return t.skip('release shell runs on Ubuntu');
  const fixture = releaseFixture(t);
  fs.mkdirSync(fixture.output);
  fs.writeFileSync(path.join(fixture.output, 'RepoDrive Setup.exe'), 'fixture');
  const log = path.join(fixture.directory, 'gh.jsonl');
  const mock = path.join(fixture.directory, 'gh');
  fs.writeFileSync(mock, `#!${process.execPath}\n` + `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.GH_TEST_LOG, JSON.stringify(args) + '\\n');
    if (args[1] === 'view' && process.env.GH_TEST_EXISTS === '0') process.exit(1);
    if (args[1] === 'upload' && process.env.GH_TEST_FAIL_UPLOAD === '1') process.exit(1);
  `, { mode: 0o755 });
  const run = (exists, fail = false) => {
    fs.writeFileSync(log, '');
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', workflowScript('Upload and publish Release')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${fixture.directory}:${process.env.PATH}`,
        RELEASE_TAG: `v${pkg.version}`, RELEASE_ASSETS: fixture.output,
        GH_TEST_LOG: log, GH_TEST_EXISTS: exists ? '1' : '0', GH_TEST_FAIL_UPLOAD: fail ? '1' : '0' },
    });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { result, calls };
  };
  const fresh = run(false);
  assert.equal(fresh.result.status, 0, fresh.result.stderr);
  assert.deepEqual(fresh.calls.map(call => call[1]), ['view', 'create', 'upload', 'edit']);
  assert.ok(fresh.calls[1].includes('--draft'));
  assert.ok(fresh.calls[2].includes(path.join(fixture.output, 'RepoDrive Setup.exe')));
  const existing = run(true);
  assert.equal(existing.result.status, 0, existing.result.stderr);
  assert.deepEqual(existing.calls.map(call => call[1]), ['view', 'upload', 'edit']);
  assert.ok(existing.calls[1].includes('--clobber'));
  assert.deepEqual(existing.calls[2].slice(3), ['--draft=false']);
  const failed = run(false, true);
  assert.notEqual(failed.result.status, 0);
  assert.deepEqual(failed.calls.map(call => call[1]), ['view', 'create', 'upload']);
});
