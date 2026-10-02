// electron-builder `afterSign` hook. When the configured identity is not in
// the keychain, electron-builder logs "skipped macOS application code signing"
// and packages the bundle anyway — an app macOS silently refuses notification
// permission (ADR desktop-app-is-ad-hoc-signed). Fail the build instead.
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const LOCAL_IDENTITY = 'Orbital Local';

exports.default = async function verifySignature(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { appInfo, platformSpecificBuildOptions } = context.packager;
  const app = path.join(context.appOutDir, `${appInfo.productFilename}.app`);
  const identity = platformSpecificBuildOptions.identity;

  // codesign -d writes its report to stderr.
  const info = spawnSync('codesign', ['-dvv', app], { encoding: 'utf8' }).stderr;
  // A self-signed identity (`Orbital Local`, runbook run-the-desktop-app) is
  // its own authority; a Developer ID one is named under Apple's prefix.
  const expected =
    identity === '-'
      ? 'Signature=adhoc'
      : identity === LOCAL_IDENTITY
        ? `Authority=${identity}\n`
        : `Authority=Developer ID Application: ${identity}`;
  if (!info.includes(expected) || !info.includes(`Identifier=${appInfo.id}\n`)) {
    throw new Error(
      `${app} is not signed as configured (expected "${expected}").\n` +
        'Is the Developer ID certificate in the keychain? See runbook run-the-desktop-app.\n' +
        info,
    );
  }
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
