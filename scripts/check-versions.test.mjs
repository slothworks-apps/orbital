import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DESKTOP_PACKAGE,
  GRADLE,
  LOCK,
  MINIMUMS,
  PACKAGE,
  RELAY_PACKAGE,
  XCODE,
  compare,
  copyProblems,
  minimumProblems,
  wentBackProblems,
} from './check-versions.mjs'

const repo = ({
  app = '0.8.0',
  lock = app,
  name = '0.8.0',
  code = 12,
  xName = name,
  xCode = code,
  desktop = '0.25.0',
  relay = '0.4.0',
  minPhone = '0.1.0',
} = {}) => {
  const files = {
    [GRADLE]: `android {\n    defaultConfig {\n        versionCode ${code}\n        versionName "${name}"\n    }\n}\n`,
    [PACKAGE]: JSON.stringify({ name: '@orbital/mobile', version: app }),
    [LOCK]: JSON.stringify({ packages: { mobile: { name: '@orbital/mobile', version: lock } } }),
    // Debug and Release each carry both keys.
    [XCODE]: `CURRENT_PROJECT_VERSION = ${xCode};\nMARKETING_VERSION = ${xName};\nCURRENT_PROJECT_VERSION = ${code};\nMARKETING_VERSION = ${name};\n`,
    [DESKTOP_PACKAGE]: JSON.stringify({ version: desktop }),
    [RELAY_PACKAGE]: JSON.stringify({ version: relay }),
    [MINIMUMS]: `export const MIN_RELAY_VERSION = '0.4.0';\nexport const MIN_SERVER_VERSION = '0.20.6';\nexport const MIN_PHONE_VERSION = '${minPhone}';\n`,
  }
  return (path) => {
    if (!(path in files)) throw new Error(`unexpected read of ${path}`)
    return files[path]
  }
}

test('compares dotted versions part by part', () => {
  assert.equal(compare('0.10.0', '0.9.9'), 1)
  assert.equal(compare('0.8', '0.8.0'), 0)
  assert.equal(compare('0.8.0-rc1', '0.8.0'), 0)
  assert.equal(compare('0.7.9', '0.8.0'), -1)
})

test('copies that agree are no problem', () => {
  assert.deepEqual(copyProblems(repo()), [])
})

test('the app version may run ahead of the native one', () => {
  assert.deepEqual(copyProblems(repo({ app: '0.8.3' })), [])
})

test('an app version below the native one fails', () => {
  assert.match(
    copyProblems(repo({ app: '0.7.9' })).join('\n'),
    /app version 0.7.9 is below the native version 0.8.0/,
  )
})

test('a native copy left behind in Xcode fails', () => {
  const problems = copyProblems(repo({ xName: '0.7.0', xCode: 11 })).join('\n')
  assert.match(problems, /MARKETING_VERSION is 0.7.0, should be 0.8.0/)
  assert.match(problems, /CURRENT_PROJECT_VERSION is 11, should be 12/)
})

test("the lockfile's copy of the app version must follow it", () => {
  assert.match(
    copyProblems(repo({ app: '0.8.1', lock: '0.8.0' })).join('\n'),
    /package-lock.json.*0.8.0, should be 0.8.1/,
  )
})

test("the phone's minimum is held to the app version", () => {
  assert.deepEqual(minimumProblems(repo({ app: '0.8.2', minPhone: '0.8.2' })), [])
  assert.match(
    minimumProblems(repo({ minPhone: '0.8.1' })).join('\n'),
    /MIN_PHONE_VERSION is 0.8.1, but mobile\/package.json is only 0.8.0/,
  )
})

test('with a base, a version may stay', () => {
  assert.deepEqual(wentBackProblems(repo(), repo(), 'main'), [])
})

test('with a base, an app bump alone ships no store build and needs no versionCode', () => {
  assert.deepEqual(wentBackProblems(repo({ app: '0.8.1' }), repo(), 'main'), [])
})

test('with a base, neither phone version may go down', () => {
  const problems = wentBackProblems(
    repo({ app: '0.8.0', name: '0.8.0' }),
    repo({ app: '0.8.2', name: '0.8.1', code: 11 }),
    'main',
  ).join('\n')
  assert.match(problems, /app version.* is 0.8.0, below 0.8.2 on main/)
  assert.match(problems, /versionName is 0.8.0, below 0.8.1 on main/)
})

test('with a base, a new versionName needs a higher versionCode', () => {
  assert.match(
    wentBackProblems(repo({ app: '0.9.0', name: '0.9.0', code: 12 }), repo(), 'main').join('\n'),
    /versionName moved to 0.9.0, but versionCode stayed 12/,
  )
  assert.deepEqual(
    wentBackProblems(repo({ app: '0.9.0', name: '0.9.0', code: 13 }), repo(), 'main'),
    [],
  )
  assert.match(
    wentBackProblems(repo({ code: 11 }), repo(), 'main').join('\n'),
    /versionCode is 11, below 12/,
  )
})

test('with a base, the desktop and relay versions may not go down', () => {
  const problems = wentBackProblems(
    repo({ desktop: '0.24.0', relay: '0.3.0' }),
    repo(),
    'main',
  ).join('\n')
  assert.match(problems, /desktop\/package.json version is 0.24.0, below 0.25.0/)
  assert.match(problems, /relay\/package.json version is 0.3.0, below 0.4.0/)
})
