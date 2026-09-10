const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function signMacAppBeforePackaging(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  // This open-source build host has no Developer ID identity. Ad-hoc signing
  // still seals the whole bundle so archived apps never contain a structurally
  // broken signature.
  execFileSync('codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--timestamp=none',
    appPath,
  ], { stdio: 'inherit' });

  execFileSync('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ], { stdio: 'inherit' });
};
