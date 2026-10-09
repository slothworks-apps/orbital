#!/usr/bin/env node
// The phone has two versions (ADR the-phone-has-an-app-version-and-a-native-version):
//
//   - the app version, `version` in mobile/package.json (package-lock.json
//     repeats it), ships over the air; the app reads it for `hello` and the
//     settings footer;
//   - the native version, `versionName` / `versionCode` in build.gradle, ships
//     through the stores; the Xcode project repeats it as MARKETING_VERSION /
//     CURRENT_PROJECT_VERSION.
//
// This keeps each copy equal to its source, and the app version not below the
// native one: a native bump bumps the app too. A bump that misses a copy fails
// the PR.
//
// It also holds each minimum in shared/src/remote/version.ts to a version the
// repo has reached: an app must not ship needing a relay, a Mac or a phone
// that does not exist yet (spec 2026-10-07-version-compatibility-design § 6).
// The phone's minimum is held to the app version, the one its `hello` sends.
//
// Given `--base <ref>`, it also holds every shipped version to at least what
// <ref> has: a version may stay, since most changes ship nothing, but never
// go back, and a new phone versionName needs a higher versionCode, which the
// stores require (ADR a-shipped-version-never-goes-back).
//
// Everything above the CLI is pure and takes the file reads as arguments, so
// scripts/check-versions.test.mjs runs without git.
/* global URL, console, process */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const GRADLE = 'mobile/android/app/build.gradle'
export const PACKAGE = 'mobile/package.json'
export const LOCK = 'package-lock.json'
export const XCODE = 'mobile/ios/App/App.xcodeproj/project.pbxproj'
export const MINIMUMS = 'shared/src/remote/version.ts'
export const DESKTOP_PACKAGE = 'desktop/package.json'
export const RELAY_PACKAGE = 'relay/package.json'

// Dotted numbers, part by part, a missing part as zero and a pre-release
// suffix ignored: `compareVersions` from MINIMUMS, minus `dev`, which no file
// here holds.
export function compare(a, b) {
  const parse = (v) => v.split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [pa, pb] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return Math.sign((pa[i] ?? 0) - (pb[i] ?? 0))
  }
  return 0
}

export function nativeVersion(gradle) {
  return {
    name: /^\s*versionName "([^"]+)"\s*$/m.exec(gradle)?.[1],
    code: /^\s*versionCode (\d+)\s*$/m.exec(gradle)?.[1],
  }
}

const versionOf = (json) => JSON.parse(json).version

/** The phone's versions as one file set has them; `read` returns a file's text. */
export function phoneVersions(read) {
  const native = nativeVersion(read(GRADLE))
  if (!native.name || !native.code) throw new Error(`no versionName/versionCode in ${GRADLE}`)
  return { app: versionOf(read(PACKAGE)), name: native.name, code: native.code }
}

/** Copies that disagree with their source, and an app version below the native one. */
export function copyProblems(read) {
  const { app, name, code } = phoneVersions(read)
  const problems = []
  const expect = (file, what, actual, wanted) => {
    if (actual !== wanted) problems.push(`${file}: ${what} is ${actual ?? 'missing'}, should be ${wanted}`)
  }

  expect(LOCK, 'packages["mobile"].version', JSON.parse(read(LOCK)).packages?.mobile?.version, app)

  const xcode = read(XCODE)
  const all = (key) => [...xcode.matchAll(new RegExp(`\\b${key} = ([^;]+);`, 'g'))].map((m) => m[1].trim())
  for (const [key, wanted] of [['MARKETING_VERSION', name], ['CURRENT_PROJECT_VERSION', code]]) {
    const values = all(key)
    if (values.length === 0) expect(XCODE, key, undefined, wanted)
    for (const value of values) expect(XCODE, key, value, wanted)
  }

  if (compare(app, name) < 0) {
    problems.push(`${PACKAGE}: the app version ${app} is below the native version ${name} in ${GRADLE}`)
  }
  return [...new Set(problems)]
}

/** Minimums in MINIMUMS that name a version nothing in the repo has reached. */
export function minimumProblems(read) {
  const minimums = read(MINIMUMS)
  const minimum = (name) => new RegExp(`^export const ${name} = '([^']+)';`, 'm').exec(minimums)?.[1]
  const problems = []
  for (const [name, file, version] of [
    ['MIN_RELAY_VERSION', RELAY_PACKAGE, versionOf(read(RELAY_PACKAGE))],
    ['MIN_SERVER_VERSION', DESKTOP_PACKAGE, versionOf(read(DESKTOP_PACKAGE))],
    ['MIN_PHONE_VERSION', PACKAGE, versionOf(read(PACKAGE))],
  ]) {
    const needed = minimum(name)
    if (!needed) problems.push(`${MINIMUMS}: no ${name}`)
    else if (compare(needed, version) > 0) problems.push(`${name} is ${needed}, but ${file} is only ${version}`)
  }
  return problems
}

/** Shipped versions that went below what `readBase` (the base branch) has. */
export function wentBackProblems(read, readBase, base) {
  const problems = []
  const now = phoneVersions(read)
  const was = phoneVersions(readBase)
  for (const [what, before, after] of [
    [`${DESKTOP_PACKAGE} version`, versionOf(readBase(DESKTOP_PACKAGE)), versionOf(read(DESKTOP_PACKAGE))],
    [`${RELAY_PACKAGE} version`, versionOf(readBase(RELAY_PACKAGE)), versionOf(read(RELAY_PACKAGE))],
    [`${PACKAGE} version (the phone's app version)`, was.app, now.app],
    [`${GRADLE} versionName`, was.name, now.name],
  ]) {
    if (before && compare(after, before) < 0) problems.push(`${what} is ${after}, below ${before} on ${base}`)
  }
  const [codeWas, codeNow] = [Number(was.code), Number(now.code)]
  if (codeNow < codeWas) problems.push(`${GRADLE} versionCode is ${codeNow}, below ${codeWas} on ${base}`)
  else if (was.name !== now.name && codeNow === codeWas) {
    problems.push(`${GRADLE} versionName moved to ${now.name}, but versionCode stayed ${codeNow}`)
  }
  return problems
}

function main(argv) {
  const root = new URL('../', import.meta.url)
  const read = (path) => readFileSync(new URL(path, root), 'utf8')
  const baseAt = argv.indexOf('--base')
  const base = baseAt === -1 ? undefined : argv[baseAt + 1]
  if (baseAt !== -1 && !base) throw new Error('--base needs a git ref')
  const readBase = (path) => execFileSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8' })

  const { app, name, code } = phoneVersions(read)
  const copies = copyProblems(read)
  const minimums = minimumProblems(read)
  const wentBack = base ? wentBackProblems(read, readBase, base) : []

  if (copies.length > 0) {
    console.error(`The phone app is ${app} on shell ${name} (${code}), but:`)
    for (const p of copies) console.error(`  ${p}`)
  }
  if (minimums.length > 0) {
    console.error('A minimum names a version nothing in the repo has reached:')
    for (const p of minimums) console.error(`  ${p}`)
  }
  if (wentBack.length > 0) {
    console.error('A shipped version goes back:')
    for (const p of wentBack) console.error(`  ${p}`)
  }
  if (copies.length > 0 || minimums.length > 0 || wentBack.length > 0) process.exit(1)
  console.log(
    `phone versions agree: app ${app} on shell ${name} (${code}); every minimum is reached` +
      (base ? `; no shipped version is below ${base}` : ''),
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
