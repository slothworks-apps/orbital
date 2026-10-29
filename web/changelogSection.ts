import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Plugin } from 'vite'
import { recentReleaseSections } from '../shared/src/changelog.ts'

/**
 * WHAT'S NEW (spec 2026-10-19-whats-new-design) reads the notes of the
 * running version and of those the person skipped from the app's changelog,
 * imported as `CHANGELOG.md?raw`. A build runs one version only, so it is
 * handed just the sections WHAT'S NEW can tell for it — that version's, the
 * version in the `package.json` beside the changelog (`desktop/` for the Mac,
 * `mobile/` for the phone), and the ones before it up to
 * `WHATS_NEW_MAX_VERSIONS` — instead of the whole history, and never
 * Unreleased. The dev server and the tests import the whole file; the client
 * reads either the same way.
 */
export function changelogSection(): Plugin {
  return {
    name: 'orbital-changelog-section',
    apply: 'build',
    enforce: 'pre',
    load(id) {
      const [file, query] = id.split('?')
      if (query !== 'raw' || basename(file) !== 'CHANGELOG.md') return null
      const { version } = JSON.parse(readFileSync(join(dirname(file), 'package.json'), 'utf8')) as { version: string }
      return `export default ${JSON.stringify(recentReleaseSections(readFileSync(file, 'utf8'), version))}`
    },
  }
}
