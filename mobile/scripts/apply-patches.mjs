#!/usr/bin/env node
// Applies mobile/patches to the installed plugins: the root package.json's
// `postinstall`, so every `npm ci` and `npm install` — on this Mac and in CI —
// gets them (ADR an-ota-bundle-runs-only-if-signed-by-ci → Nothing from a
// session leaves the phone). An install of only some workspaces (the relay's
// CI job) has no updater plugin and no patch-package, and is left alone.
// mobile/scripts/plugin-privacy.test.mjs fails when a patch did not apply.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const has = (path) => existsSync(new URL(`../../${path}`, import.meta.url))

if (
  !has('node_modules/@capgo/capacitor-updater/package.json') ||
  !has('node_modules/patch-package/package.json')
) {
  console.log('apply-patches: no updater plugin installed here, nothing to patch')
  process.exit(0)
}

const run = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../../node_modules/patch-package/index.js', import.meta.url)),
    '--patch-dir',
    'mobile/patches',
    '--error-on-fail',
  ],
  { cwd: root, stdio: 'inherit' },
)
process.exit(run.status ?? 1)
