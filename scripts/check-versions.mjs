#!/usr/bin/env node
// The phone app's version lives in three files. `versionName` and
// `versionCode` in build.gradle are what ships (mobile/CLAUDE.md); the app
// reads `version` from mobile/package.json for `hello` and the settings
// footer, and the Xcode project labels builds run from Xcode. This keeps the
// copies equal to the source, so a bump that misses one fails the PR.
/* global URL, console, process */
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const GRADLE = 'mobile/android/app/build.gradle'
const PACKAGE = 'mobile/package.json'
const XCODE = 'mobile/ios/App/App.xcodeproj/project.pbxproj'

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

if (problems.length > 0) {
  console.error(`The phone app is ${versionName} (${versionCode}) in ${GRADLE}, but:`)
  for (const p of new Set(problems)) console.error(`  ${p}`)
  process.exit(1)
}
console.log(`phone app versions agree: ${versionName} (${versionCode})`)
