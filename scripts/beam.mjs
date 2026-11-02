// Beam, the phone's over-the-air update server (spec
// 2026-10-09-phone-ota-updates-design → Beam): everything the release scripts
// assume about its HTTP contract is here, so a change on Beam's side is a
// change in this one file. The phone's own side of the contract (the stats
// event) is web/src/mobile/update/beam.ts; the plugin's update and stats URLs
// are built in mobile/capacitor.config.ts.
//
// Beam's address and the app's id there live in mobile/beam.json, which the
// native config and the web build read too.
/* global FormData, Blob */

export const BEAM_CONFIG = 'mobile/beam.json'

/** The app's upload key, from Beam's admin; CI has it as the secret BEAM_UPLOAD_KEY. */
export const UPLOAD_KEY_HEADER = 'X-Upload-Key'

/** The multipart fields of an upload. */
export const UPLOAD_FIELDS = {
  bundle: 'bundle',
  version: 'version',
  minNativeVersion: 'minNativeVersion',
  releaseNotes: 'releaseNotes',
  /** `<iv base64>:<RSA-signed AES key base64>`, passed through to the plugin as `session_key`. */
  sessionKey: 'sessionKey',
  /** The signed SHA-256 of the plain zip, passed through to the plugin as `checksum`. */
  checksum: 'checksum',
  /** The channel the bundle is deployed to; without it Beam deploys to `production`. */
  channel: 'channel',
}

/**
 * Where every release goes (spec 2026-11-02-experimental-release-channel-design
 * → Beam contract), and where Promote moves it to: the channel every phone
 * that did not choose another reads.
 */
export const RELEASE_CHANNEL = 'experimental'
export const STABLE_CHANNEL = 'production'

export function readBeam(json) {
  const beam = JSON.parse(json)
  if (typeof beam?.url !== 'string' || typeof beam?.appId !== 'string') {
    throw new Error(`${BEAM_CONFIG}: needs "url" and "appId"`)
  }
  return { url: beam.url.replace(/\/+$/, ''), appId: beam.appId }
}

/** `POST` here uploads a bundle. */
export function bundlesUrl(beam) {
  return `${beam.url}/api/apps/${encodeURIComponent(beam.appId)}/bundles`
}

/** `GET` here answers 200 when that version is uploaded, 404 when it is not. */
export function bundleUrl(beam, version) {
  return `${bundlesUrl(beam)}/${encodeURIComponent(version)}`
}

/** `GET` here reads the channel's live version; `POST …/promote` deploys a version to it. */
export function channelUrl(beam, name) {
  return `${beam.url}/api/apps/${encodeURIComponent(beam.appId)}/channels/${encodeURIComponent(name)}`
}

function needKey(uploadKey) {
  if (!uploadKey) throw new Error('no Beam upload key (BEAM_UPLOAD_KEY)')
}

/** Beam's `{ error }` from a JSON body, or null. */
function errorOf(body) {
  try {
    return JSON.parse(body)?.error ?? null
  } catch {
    return null
  }
}

/**
 * The version channel `name` serves, or null when it serves none. An unknown
 * channel, like any other answer but 200, throws.
 */
export async function channelVersion({ beam, uploadKey, name, fetch }) {
  needKey(uploadKey)
  const res = await fetch(channelUrl(beam, name), { headers: { [UPLOAD_KEY_HEADER]: uploadKey } })
  const body = await res.text().catch(() => '')
  if (res.status === 404)
    throw new Error(`Beam has no channel "${name}" for ${beam.appId} (404): ${body.slice(0, 200)}`)
  if (res.status !== 200)
    throw new Error(`Beam answered ${res.status} for channel ${name}: ${body.slice(0, 200)}`)
  let version
  try {
    version = JSON.parse(body)?.version
  } catch {
    throw new Error(`Beam's answer for channel ${name} is not JSON: ${body.slice(0, 200)}`)
  }
  if (version !== null && typeof version !== 'string')
    throw new Error(`Beam's answer for channel ${name} carries no version: ${body.slice(0, 200)}`)
  return version
}

/**
 * Deploys the app's bundle `version` to channel `name`. Answers `promoted`,
 * or `unchanged` when it was live there already, so a re-run succeeds.
 */
export async function promoteBundle({ beam, uploadKey, name, version, fetch }) {
  needKey(uploadKey)
  const res = await fetch(`${channelUrl(beam, name)}/promote`, {
    method: 'POST',
    headers: { [UPLOAD_KEY_HEADER]: uploadKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  })
  const body = await res.text().catch(() => '')
  if (!res.ok)
    throw new Error(
      `Beam refused to promote ${version} to ${name} (${res.status}): ${body.slice(0, 200)}`,
    )
  let status
  try {
    status = JSON.parse(body)?.status
  } catch {
    status = undefined
  }
  if (status !== 'promoted' && status !== 'unchanged')
    throw new Error(
      `Beam's answer to promoting ${version} to ${name} is not a status: ${body.slice(0, 200)}`,
    )
  return status
}

/**
 * Whether Beam has the bundle `version`. 404 is the one answer that means
 * no; anything else but 200 throws, so an outage never reads as "not shipped".
 */
export async function bundleExists({ beam, uploadKey, version, fetch }) {
  needKey(uploadKey)
  const res = await fetch(bundleUrl(beam, version), { headers: { [UPLOAD_KEY_HEADER]: uploadKey } })
  if (res.status === 200) return true
  if (res.status === 404) return false
  const body = await res.text().catch(() => '')
  throw new Error(`Beam answered ${res.status} for bundle ${version}: ${body.slice(0, 200)}`)
}

/**
 * Uploads one signed bundle, deployed to `channel` only when one is named.
 * A version Beam already has (409) and a channel it does not have (404
 * channel_not_found) fail like any other refusal, with their own message.
 */
export async function uploadBundle({
  beam,
  uploadKey,
  fetch,
  zip,
  version,
  minNativeVersion,
  releaseNotes,
  sessionKey,
  checksum,
  channel,
}) {
  needKey(uploadKey)
  const form = new FormData()
  form.append(
    UPLOAD_FIELDS.bundle,
    new Blob([zip], { type: 'application/zip' }),
    `orbital-${version}.zip`,
  )
  form.append(UPLOAD_FIELDS.version, version)
  form.append(UPLOAD_FIELDS.minNativeVersion, minNativeVersion)
  if (releaseNotes) form.append(UPLOAD_FIELDS.releaseNotes, releaseNotes)
  form.append(UPLOAD_FIELDS.sessionKey, sessionKey)
  form.append(UPLOAD_FIELDS.checksum, checksum)
  if (channel) form.append(UPLOAD_FIELDS.channel, channel)
  const res = await fetch(bundlesUrl(beam), {
    method: 'POST',
    headers: { [UPLOAD_KEY_HEADER]: uploadKey },
    body: form,
  })
  const body = await res.text().catch(() => '')
  if (res.status === 409)
    throw new Error(`Beam already has bundle ${version} (409): ${body.slice(0, 200)}`)
  if (res.status === 404 && errorOf(body) === 'channel_not_found')
    throw new Error(
      `Beam has no channel "${channel}" for ${beam.appId}: create it in Beam's admin ` +
        `(runbook ship-the-phone-over-the-air); nothing was stored`,
    )
  if (!res.ok)
    throw new Error(`Beam refused bundle ${version} (${res.status}): ${body.slice(0, 200)}`)
  return body
}
