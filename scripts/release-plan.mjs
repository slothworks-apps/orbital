#!/usr/bin/env node
// Decides what `.github/workflows/release.yml` ships: each app whose version
// is not yet where it ships to (ADR a-version-ships-once-from-one-workflow,
// spec 2026-10-08-builds-for-testers-design → "The release workflow").
//
//   node scripts/release-plan.mjs              the plan, also into $GITHUB_OUTPUT
//   node scripts/release-plan.mjs notes <ver> [changelog]
//                                              that version's section of the
//                                              changelog (desktop/CHANGELOG.md
//                                              unless named), or nothing
//
// The desktop app has shipped when its GitHub Release `v<version>` is
// published (a draft is a release whose upload did not finish), the relay
// when its image is in GHCR, the phone's app version when Beam has its bundle
// (spec 2026-10-09-phone-ota-updates-design → Releasing), the phone's native
// version when the tag the workflow writes after both stores took the build
// exists. A lookup that fails for any other reason than "not there" stops the
// run: read as "not shipped", an outage of GitHub or Beam would ship a version
// again.
//
// Everything above the CLI is pure and takes the lookups as arguments, so
// scripts/release-plan.test.mjs runs without gh, git, docker or Beam.
/* global URL, console, process, fetch */
import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BEAM_CONFIG, bundleExists, readBeam } from './beam.mjs'

export const DESKTOP_PACKAGE = 'desktop/package.json'
export const RELAY_PACKAGE = 'relay/package.json'
export const MOBILE_PACKAGE = 'mobile/package.json'
export const GRADLE = 'mobile/android/app/build.gradle'
export const CHANGELOG = 'desktop/CHANGELOG.md'
export const RELAY_IMAGE = 'orbital-relay'

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function checked(version, where) {
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(
      `${where}: ${version === undefined ? 'no version' : `"${version}" is not a version`}`,
    )
  }
  return version
}

export function packageVersion(json, file) {
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    throw new Error(`${file}: not JSON (${e.message})`, { cause: e })
  }
  return checked(parsed?.version, `${file} version`)
}

// The same line check-versions.mjs and ios-release.sh read.
export function phoneVersion(gradle) {
  const name = /^\s*versionName "([^"]*)"\s*$/m.exec(gradle)?.[1]
  return checked(name, `${GRADLE} versionName`)
}

export function readVersions(read) {
  return {
    mac: packageVersion(read(DESKTOP_PACKAGE), DESKTOP_PACKAGE),
    ota: packageVersion(read(MOBILE_PACKAGE), MOBILE_PACKAGE),
    mobile: phoneVersion(read(GRADLE)),
    relay: packageVersion(read(RELAY_PACKAGE), RELAY_PACKAGE),
  }
}

// What each version is looked up as: the GitHub Release (and its tag, which
// electron-updater expects as `v<version>`), the bundle version on Beam, the
// git tag release.yml pushes for the phone's native build, the image
// reference. GHCR names are lowercase.
export function names(versions, owner) {
  if (!owner)
    throw new Error('no repository owner (GITHUB_REPOSITORY_OWNER) to name the relay image by')
  return {
    mac: `v${versions.mac}`,
    ota: versions.ota,
    mobile: `mobile-v${versions.mobile}`,
    relay: `ghcr.io/${owner.toLowerCase()}/${RELAY_IMAGE}:${versions.relay}`,
  }
}

// Apps that do not ship even with a new version, and why: `<app>: '<reason>'`.
// Empty now; the phone waited here for over-the-air updates (roadmap Phase 3).
export const HELD = {}

// `lookups` answer true when the name is there, false when it is not, and
// throw for anything else; a throw is not caught here.
export async function plan({ read, owner, lookups, held = HELD }) {
  const versions = readVersions(read)
  const asked = names(versions, owner)
  const [mac, ota, mobile, relay] = await Promise.all([
    lookups.release(asked.mac),
    lookups.bundle(asked.ota),
    lookups.tag(asked.mobile),
    lookups.image(asked.relay),
  ])
  const shipped = { mac, ota, mobile, relay }
  for (const [app, answer] of Object.entries(shipped)) {
    if (typeof answer !== 'boolean')
      throw new Error(`the ${app} lookup answered ${String(answer)}, not true or false`)
  }
  const ship = { mac: !mac, ota: !ota, mobile: !mobile, relay: !relay }
  for (const app of Object.keys(held)) ship[app] = false
  return { versions, names: asked, ship, held }
}

export function outputs(result) {
  return [
    `mac=${result.ship.mac}`,
    `ota=${result.ship.ota}`,
    `mobile=${result.ship.mobile}`,
    `relay=${result.ship.relay}`,
    `mac-version=${result.versions.mac}`,
    `ota-version=${result.versions.ota}`,
    `mobile-version=${result.versions.mobile}`,
    `relay-version=${result.versions.relay}`,
  ].join('\n')
}

export function summary(result) {
  const line = (app, label) =>
    `${label.padEnd(13)}${result.versions[app].padEnd(10)}${result.held?.[app] ? 'held' : result.ship[app] ? 'ship' : 'shipped'}  (${result.held?.[app] ?? result.names[app]})`
  return [
    line('mac', 'desktop'),
    line('ota', 'phone app'),
    line('mobile', 'phone shell'),
    line('relay', 'relay'),
  ].join('\n')
}

// The body under `## [<version>]` up to the next `## ` heading, trimmed;
// null when the changelog has no such section or it is empty.
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const heading = `## [${version}]`
  const start = lines.findIndex((l) => l === heading || l.startsWith(`${heading} `))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^##\s/.test(l))
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
  return body === '' ? null : body
}

// The real lookups. `notThere` is the one answer that means "not shipped";
// every other failure, a missing binary included, is thrown.
function run(command, args, notThere) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) return resolve({ found: true, stdout })
      if (notThere(error, stderr)) return resolve({ found: false, stdout })
      const said = (stderr || error.message).trim()
      reject(new Error(`${command} ${args.join(' ')} failed: ${said}`))
    })
  })
}

export const realLookups = {
  // Beam's version lookup, behind the app's upload key (scripts/beam.mjs).
  async bundle(version) {
    const beam = readBeam(readFileSync(new URL(`../${BEAM_CONFIG}`, import.meta.url), 'utf8'))
    return bundleExists({ beam, uploadKey: process.env.BEAM_UPLOAD_KEY, version, fetch })
  },
  async release(tag) {
    const { found, stdout } = await run(
      'gh',
      ['release', 'view', tag, '--json', 'isDraft', '--jq', '.isDraft'],
      (_e, err) => /release not found/i.test(err),
    )
    return found && stdout.trim() === 'false'
  },
  async tag(name) {
    // --exit-code: 2 when no ref matched, anything else is a real failure.
    const { found } = await run(
      'git',
      ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${name}`],
      (e) => e.code === 2,
    )
    return found
  },
  async image(ref) {
    const { found } = await run('docker', ['manifest', 'inspect', ref], (_e, err) =>
      /manifest unknown/i.test(err),
    )
    return found
  },
}

async function main(argv) {
  const root = new URL('../', import.meta.url)
  const read = (path) => readFileSync(new URL(path, root), 'utf8')

  if (argv[0] === 'notes') {
    if (!argv[1]) throw new Error('usage: release-plan.mjs notes <version> [changelog]')
    const notes = changelogSection(read(argv[2] ?? CHANGELOG), argv[1])
    if (notes) process.stdout.write(`${notes}\n`)
    return
  }

  const result = await plan({
    read,
    owner: process.env.GITHUB_REPOSITORY_OWNER,
    lookups: realLookups,
  })
  console.log(summary(result))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${outputs(result)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
