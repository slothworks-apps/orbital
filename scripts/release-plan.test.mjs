import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DESKTOP_PACKAGE,
  GRADLE,
  RELAY_PACKAGE,
  changelogSection,
  names,
  outputs,
  phoneVersion,
  plan,
  readVersions,
  summary,
} from './release-plan.mjs'

const gradle = (line) =>
  `android {\n    defaultConfig {\n        versionCode 11\n${line}\n    }\n}\n`

const files = (overrides = {}) => {
  const all = {
    [DESKTOP_PACKAGE]: JSON.stringify({ name: '@orbital/desktop', version: '0.25.0' }),
    [RELAY_PACKAGE]: JSON.stringify({ name: '@orbital/relay', version: '0.4.0' }),
    [GRADLE]: gradle('        versionName "0.7.0"'),
    ...overrides,
  }
  return (path) => {
    if (!(path in all)) throw new Error(`unexpected read of ${path}`)
    return all[path]
  }
}

const lookups = (answers) => {
  const asked = []
  const answer = (kind) => async (name) => {
    asked.push([kind, name])
    const a = answers[kind]
    if (a instanceof Error) throw a
    return a
  }
  return {
    asked,
    lookups: { release: answer('release'), tag: answer('tag'), image: answer('image') },
  }
}

test('reads the three versions', () => {
  assert.deepEqual(readVersions(files()), { mac: '0.25.0', mobile: '0.7.0', relay: '0.4.0' })
})

test('a missing or malformed versionName fails', () => {
  assert.throws(() => phoneVersion(gradle('        versionCode 12')), /versionName.*no version/)
  assert.throws(
    () => phoneVersion(gradle('        versionName "seven"')),
    /"seven" is not a version/,
  )
  assert.throws(() => phoneVersion(gradle('        versionName ""')), /"" is not a version/)
  // A commented-out line is not the version.
  assert.throws(() => phoneVersion(gradle('        // versionName "0.7.0"')), /no version/)
})

test('a package without a usable version fails', () => {
  assert.throws(
    () => readVersions(files({ [RELAY_PACKAGE]: '{"name":"x"}' })),
    /relay\/package.json version: no version/,
  )
  assert.throws(
    () => readVersions(files({ [DESKTOP_PACKAGE]: '{"version":"1.2"}' })),
    /"1.2" is not a version/,
  )
  assert.throws(
    () => readVersions(files({ [DESKTOP_PACKAGE]: '{' })),
    /desktop\/package.json: not JSON/,
  )
})

test('names what it asks about, the image owner lowercased', () => {
  assert.deepEqual(names({ mac: '0.25.0', mobile: '0.7.0', relay: '0.4.0' }, 'SlothWorks-Apps'), {
    mac: 'v0.25.0',
    mobile: 'mobile-v0.7.0',
    relay: 'ghcr.io/slothworks-apps/orbital-relay:0.4.0',
  })
  assert.throws(
    () => names({ mac: '1.0.0', mobile: '1.0.0', relay: '1.0.0' }, undefined),
    /GITHUB_REPOSITORY_OWNER/,
  )
})

test('ships what is missing and skips what is there', async () => {
  const { asked, lookups: l } = lookups({ release: false, tag: false, image: true })
  const result = await plan({ read: files(), owner: 'slothworks-apps', lookups: l, held: {} })
  assert.deepEqual(result.ship, { mac: true, mobile: true, relay: false })
  assert.deepEqual(asked.sort(), [
    ['image', 'ghcr.io/slothworks-apps/orbital-relay:0.4.0'],
    ['release', 'v0.25.0'],
    ['tag', 'mobile-v0.7.0'],
  ])
  assert.equal(
    outputs(result),
    'mac=true\nmobile=true\nrelay=false\nmac-version=0.25.0\nmobile-version=0.7.0\nrelay-version=0.4.0',
  )
})

test('a held app does not ship even with a new version', async () => {
  const { lookups: l } = lookups({ release: false, tag: false, image: false })
  const result = await plan({ read: files(), owner: 'o', lookups: l, held: { mobile: 'not yet' } })
  assert.deepEqual(result.ship, { mac: true, mobile: false, relay: true })
  assert.match(summary(result), /phone\s+0\.7\.0\s+held\s+\(not yet\)/)
})

test('ships nothing when everything is there', async () => {
  const { lookups: l } = lookups({ release: true, tag: true, image: true })
  const result = await plan({ read: files(), owner: 'o', lookups: l })
  assert.deepEqual(result.ship, { mac: false, mobile: false, relay: false })
})

test('a lookup that errors fails the plan instead of reading as not shipped', async () => {
  const { lookups: l } = lookups({ release: new Error('gh: HTTP 502'), tag: false, image: true })
  await assert.rejects(plan({ read: files(), owner: 'o', lookups: l }), /HTTP 502/)
})

test('a lookup that answers something other than a boolean fails the plan', async () => {
  const { lookups: l } = lookups({ release: false, tag: undefined, image: true })
  await assert.rejects(
    plan({ read: files(), owner: 'o', lookups: l }),
    /mobile lookup answered undefined/,
  )
})

const changelog = `# Changelog

## [Unreleased]

## [0.25.0] — 2026-10-09

### Added

- The app updates itself.

## [0.24.0] — 2026-10-08

- Older.

[0.24.0]: https://example.com
`

test('takes one version section out of the changelog', () => {
  assert.equal(changelogSection(changelog, '0.25.0'), '### Added\n\n- The app updates itself.')
  assert.equal(changelogSection(changelog, '0.24.0'), '- Older.\n\n[0.24.0]: https://example.com')
})

test('no section, or an empty one, is no notes', () => {
  assert.equal(changelogSection(changelog, '0.26.0'), null)
  assert.equal(changelogSection(changelog, 'Unreleased'), null)
  // A prefix of a version is not that version.
  assert.equal(changelogSection(changelog, '0.2'), null)
})
