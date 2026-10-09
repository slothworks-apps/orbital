// Nothing from a session leaves the phone, diagnostics on or off (ADR
// an-ota-bundle-runs-only-if-signed-by-ci → Nothing from a session leaves the
// phone). The updater plugin's WebView reporter would send the text of every
// error, its stack, file, line and column, failing resources' addresses and
// the page's URL; mobile/patches strips them so a report says only which kind
// of event happened. This reads the installed plugin's native sources and
// fails when the patch did not apply, or when the plugin is not the version
// the patch was written for.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const PATCHED_VERSION = '8.51.25'

const at = (path) => new URL(`../../${path}`, import.meta.url)
const read = (path) => readFileSync(at(path), 'utf8')
const PLUGIN = 'node_modules/@capgo/capacitor-updater'
const JAVA = `${PLUGIN}/android/src/main/java/ee/forgr/capacitor_updater`
const SWIFT = `${PLUGIN}/ios/Sources/CapacitorUpdaterPlugin`

/** The text from `start` to the first line that closes a member at four spaces. */
function member(source, start) {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `not found: ${start}`)
  const end = source.indexOf('\n    }\n', from)
  return source.slice(from, end === -1 ? undefined : end)
}

// Every field the unpatched reporter fills from the page or the WebView.
const FREE_TEXT = [
  'message',
  'stack',
  'source',
  'line',
  'column',
  'lineno',
  'colno',
  'tag_name',
  'href',
  'user_agent',
  'session_id',
  'previous_href',
  'previous_session_id',
]

test('the plugin is the version the patch was written for', () => {
  assert.equal(JSON.parse(read(`${PLUGIN}/package.json`)).version, PATCHED_VERSION)
  assert.equal(
    JSON.parse(read('mobile/package.json')).dependencies['@capgo/capacitor-updater'],
    PATCHED_VERSION,
  )
  assert.ok(
    readdirSync(at('mobile/patches')).includes(`@capgo+capacitor-updater+${PATCHED_VERSION}.patch`),
    'mobile/patches has no patch for this version',
  )
})

test("Android: the injected reporter sends an event's type and nothing else", () => {
  const script = member(
    read(`${JAVA}/CapacitorUpdaterPlugin.java`),
    'static String buildWebViewStatsReporterScript()',
  )
  const send = /function send\(payload\)\{.*?\}catch\(_\)\{\}\}/.exec(script)?.[0]
  assert.ok(send, 'no send() in the reporter script')
  assert.match(send, /queue\.push\(\{type:key\}\)/)
  assert.doesNotMatch(send, /payload\.(href|user_agent|session_id|message|stack|source)/)
})

test('Android: a WebView report keeps only its type', () => {
  const java = read(`${JAVA}/CapacitorUpdaterPlugin.java`)
  const metadata = member(java, 'static Map<String, String> buildWebViewErrorMetadata(')
  for (const field of FREE_TEXT)
    assert.ok(!metadata.includes(`"${field}"`), `buildWebViewErrorMetadata still sends ${field}`)
  assert.ok(
    !member(java, 'private void reportWebViewPageLoaded(').includes('"href"'),
    'page loaded still sends the URL',
  )
})

test('Android: an app exit carries no text from the system', () => {
  const exit = read(`${JAVA}/AndroidAppExitReporter.java`)
  assert.ok(!exit.includes('"exit_description"'), 'exit_description is still sent')
  assert.ok(!exit.includes('"process_name"'), 'process_name is still sent')
})

test("iOS: the injected reporter sends an event's type and nothing else", () => {
  const swift = read(`${SWIFT}/WebViewStatsReporter.swift`)
  const send = /function send\(payload\)\{[\s\S]*?\n {6}\}/.exec(swift)?.[0]
  assert.ok(send, 'no send() in the reporter script')
  assert.match(send, /queue\.push\(\{type:key\}\)/)
  assert.doesNotMatch(send, /payload\.(href|user_agent|session_id|message|stack|source)/)
})

test('iOS: a WebView report keeps only its type', () => {
  const swift = read(`${SWIFT}/WebViewStatsReporter.swift`)
  const metadata = member(swift, 'static func buildMetadata(')
  for (const field of FREE_TEXT)
    assert.ok(!metadata.includes(`"${field}"`), `buildMetadata still sends ${field}`)
})

test('no native source puts free text into stats metadata', () => {
  const sources = [
    ...readdirSync(at(JAVA)).map((f) => `${JAVA}/${f}`),
    ...readdirSync(at(SWIFT)).map((f) => `${SWIFT}/${f}`),
  ].filter((f) => /\.(java|swift)$/.test(f))
  for (const file of sources) {
    const text = read(file)
    for (const field of ['message', 'stack', 'href', 'exit_description']) {
      assert.ok(!text.includes(`metadata.put("${field}"`), `${file} puts ${field}`)
      assert.ok(
        !text.includes(`putStatsMetadataValue(metadata, "${field}"`),
        `${file} puts ${field}`,
      )
      assert.ok(!text.includes(`put(&metadata, key: "${field}"`), `${file} puts ${field}`)
    }
  }
})
