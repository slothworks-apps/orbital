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
}

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

function needKey(uploadKey) {
  if (!uploadKey) throw new Error('no Beam upload key (BEAM_UPLOAD_KEY)')
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

/** Uploads one signed bundle; a version Beam already has (409) fails like any other refusal. */
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
  const res = await fetch(bundlesUrl(beam), {
    method: 'POST',
    headers: { [UPLOAD_KEY_HEADER]: uploadKey },
    body: form,
  })
  const body = await res.text().catch(() => '')
  if (res.status === 409)
    throw new Error(`Beam already has bundle ${version} (409): ${body.slice(0, 200)}`)
  if (!res.ok)
    throw new Error(`Beam refused bundle ${version} (${res.status}): ${body.slice(0, 200)}`)
  return body
}
