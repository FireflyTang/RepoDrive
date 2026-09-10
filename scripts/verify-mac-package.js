const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const dmgPath = path.join(root, 'dist', `RepoDrive-${pkg.version}-arm64.dmg`);
const mountPath = fs.mkdtempSync(path.join(os.tmpdir(), 'repodrive-verify-'));

if (!fs.existsSync(dmgPath)) {
  throw new Error(`DMG not found: ${dmgPath}`);
}

try {
  execFileSync('hdiutil', [
    'attach',
    '-nobrowse',
    '-readonly',
    '-mountpoint',
    mountPath,
    dmgPath,
  ], { stdio: 'ignore' });

  const appPath = path.join(mountPath, 'RepoDrive.app');
  execFileSync('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ], { stdio: 'inherit' });

  console.log(`macOS package verification passed: ${path.basename(dmgPath)}`);
} finally {
  try {
    execFileSync('hdiutil', ['detach', mountPath], { stdio: 'ignore' });
  } finally {
    fs.rmSync(mountPath, { recursive: true, force: true });
  }
}
