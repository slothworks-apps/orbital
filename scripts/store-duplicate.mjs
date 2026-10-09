#!/usr/bin/env node
// Tells whether a failed store upload failed only because the store already
// has that build: App Store Connect or Google Play refusing a build number it
// has seen. `.github/workflows/release.yml` then counts the platform as
// shipped and writes its tag, since the store is where the build ships to
// (ADR a-version-ships-once-from-one-workflow). Every other failure is still
// a failure, so the patterns match the duplicate-build refusals and nothing
// near them.
//
//   node scripts/store-duplicate.mjs <ios|android> <log>...
//
// Exits 0 and prints the matched line when a log shows the store refusing a
// duplicate of build.gradle's versionCode, 1 when none does (a missing log
// included: the build failed before the upload), 2 on wrong usage.
// mobile/scripts/ios-release.sh calls it too, to not retry a duplicate.
/* global URL, console, process */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const GRADLE = 'mobile/android/app/build.gradle'

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Each list is the store's own wording, as the upload tool prints it.
export function duplicatePatterns(platform, build) {
  const b = escape(String(build))
  if (platform === 'android') {
    return [
      // The Play Developer API's refusal of a used version code, in the
      // GoogleJsonResponseException Gradle Play Publisher throws (with
      // --stacktrace, which the `play` script passes, Gradle prints it).
      /APK specifies a version code that has already been used/,
      // The newer form of the same refusal, which names the code.
      new RegExp(`Version code ${b} has already been used`),
    ]
  }
  if (platform === 'ios') {
    return [
      // App Store Connect's error code for an attribute value already
      // taken; on a build upload that is the build number.
      /ENTITY_ERROR\.ATTRIBUTE\.INVALID\.DUPLICATE/,
      // The same error's text (code -19232).
      /The provided entity includes an attribute with a value that has already been used/,
      // ITMS-90189, the older form, which names the build number.
      new RegExp(
        `Redundant Binary Upload\\. You've already uploaded a build with build number ['‘’"]${b}['‘’"]`,
      ),
    ]
  }
  throw new Error(`unknown platform "${platform}" (ios or android)`)
}

// The first line of `output` that shows the store refusing `build` as a
// duplicate, or null.
export function duplicateRefusal(platform, build, output) {
  const patterns = duplicatePatterns(platform, build)
  for (const line of output.split(/\r?\n/)) {
    if (patterns.some((p) => p.test(line))) return line.trim()
  }
  return null
}

export function versionCode(gradle) {
  const code = /^\s*versionCode (\d+)\s*$/m.exec(gradle)?.[1]
  if (!code) throw new Error(`${GRADLE}: no versionCode`)
  return code
}

function main([platform, ...logs]) {
  if (!['ios', 'android'].includes(platform) || logs.length === 0) {
    console.error('usage: store-duplicate.mjs <ios|android> <log>...')
    return 2
  }
  const build = versionCode(readFileSync(new URL(`../${GRADLE}`, import.meta.url), 'utf8'))
  for (const log of logs) {
    if (!existsSync(log)) continue
    const line = duplicateRefusal(platform, build, readFileSync(log, 'utf8'))
    if (line) {
      console.log(line)
      return 0
    }
  }
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    process.exitCode = 2
  }
}
