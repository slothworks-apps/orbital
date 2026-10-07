#!/usr/bin/env node
// The phone app's version lives in three files. `versionName` and
// `versionCode` in build.gradle are what ships (mobile/CLAUDE.md); the app
// reads `version` from mobile/package.json for `hello` and the settings
// footer, and the Xcode project labels builds run from Xcode. This keeps the
// copies equal to the source, so a bump that misses one fails the PR.
//
// It also holds each minimum in shared/src/remote/version.ts to a version the
// repo has reached: an app must not ship needing a relay, a Mac or a phone
// that does not exist yet (spec 2026-10-07-version-compatibility-design § 6).
/* global URL, console, process */
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const GRADLE = 'mobile/android/app/build.gradle'
const PACKAGE = 'mobile/package.json'
const XCODE = 'mobile/ios/App/App.xcodeproj/project.pbxproj'
const MINIMUMS = 'shared/src/remote/version.ts'

const gradle = read(GRADLE)
const versionName = /^\s*versionName "([^"]+)"\s*$/m.exec(gradle)?.[1]
const versionCode = /^\s*versionCode (\d+)\s*$/m.exec(gradle)?.[1]
if (!versionName || !versionCode) {
  console.error(`no versionName/versionCode in ${GRADLE}`)
  process.exit(1)
}

const problems = []
const expect = (file, what, actual, wanted) => {
  if (actual !== wanted) problems.push(`${file}: ${what} is ${actual ?? 'missing'}, should be ${wanted}`)
}

expect(PACKAGE, 'version', JSON.parse(read(PACKAGE)).version, versionName)

const xcode = read(XCODE)
const all = (key) => [...xcode.matchAll(new RegExp(`\\b${key} = ([^;]+);`, 'g'))].map((m) => m[1].trim())
for (const [key, wanted] of [['MARKETING_VERSION', versionName], ['CURRENT_PROJECT_VERSION', versionCode]]) {
  const values = all(key)
  if (values.length === 0) expect(XCODE, key, undefined, wanted)
  for (const value of values) expect(XCODE, key, value, wanted)
}

// Dotted numbers, part by part, a missing part as zero and a pre-release
// suffix ignored: `compareVersions` from MINIMUMS, minus `dev`, which no file
// here holds.
const compare = (a, b) => {
  const parse = (v) => v.split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [pa, pb] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return Math.sign((pa[i] ?? 0) - (pb[i] ?? 0))
  }
  return 0
}

const minimums = read(MINIMUMS)
const minimum = (name) => new RegExp(`^export const ${name} = '([^']+)';`, 'm').exec(minimums)?.[1]
const tooHigh = []
for (const [name, file, version] of [
  ['MIN_RELAY_VERSION', 'relay/package.json', JSON.parse(read('relay/package.json')).version],
  ['MIN_SERVER_VERSION', 'desktop/package.json', JSON.parse(read('desktop/package.json')).version],
  ['MIN_PHONE_VERSION', GRADLE, versionName],
]) {
  const needed = minimum(name)
  if (!needed) tooHigh.push(`${MINIMUMS}: no ${name}`)
  else if (compare(needed, version) > 0) tooHigh.push(`${name} is ${needed}, but ${file} is only ${version}`)
}

if (problems.length > 0) {
  console.error(`The phone app is ${versionName} (${versionCode}) in ${GRADLE}, but:`)
  for (const p of new Set(problems)) console.error(`  ${p}`)
}
if (tooHigh.length > 0) {
  console.error('A minimum names a version nothing in the repo has reached:')
  for (const p of tooHigh) console.error(`  ${p}`)
}
if (problems.length > 0 || tooHigh.length > 0) process.exit(1)
console.log(`phone app versions agree: ${versionName} (${versionCode}); every minimum is reached`)
