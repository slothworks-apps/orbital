#!/usr/bin/env node
// Zips the phone's built web bundle, encrypts and signs it the way
// `@capgo/capacitor-updater` 8.51.x verifies an encrypted bundle, and uploads
// it to Beam (spec 2026-10-09-phone-ota-updates-design → Signing, ADR
// an-ota-bundle-runs-only-if-signed-by-ci). Run by the `ota` job of
// .github/workflows/release.yml after `npm run build:mobile -w @orbital/web`.
//
//   OTA_PRIVATE_KEY_FILE=<pem> BEAM_UPLOAD_KEY=<key> node scripts/ota-bundle.mjs
//   OTA_PRIVATE_KEY_FILE=<pem> node scripts/ota-bundle.mjs --out <file>
//                                    encrypts and checks, writes the encrypted
//                                    zip there, and uploads nothing
//
// The scheme, as the plugin decrypts it (CryptoCipher.java / CryptoCipher.swift,
// CapgoUpdater.finishDownload / CapacitorUpdaterPlugin.downloadBundle):
//
//   - the zip, `index.html` at its root, is encrypted with AES-128-CBC and
//     PKCS#7 padding under a random 16-byte key and a random 16-byte IV;
//   - session key = `<IV base64>:<AES key base64>`, the AES key encrypted with
//     the RSA *private* key and PKCS#1 v1.5 padding (type 1, the signature
//     padding), which the plugin undoes with the public key;
//   - checksum = SHA-256 of the *plain* zip, the 32 raw bytes encrypted the
//     same way with the private key, hex — 256 bytes for a 2048-bit key, which
//     the plugin requires.
//
// Only the private key can make a session key and a checksum that the public
// key built into the app opens, so Beam can pass them through but not forge
// them. `verifyBundle` repeats the plugin's checks with the committed public
// key before anything is uploaded: a secret that does not match
// mobile/ota-public-key.pem fails here, not on every phone.
/* global URL, console, process, fetch */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateEncrypt,
  publicDecrypt,
  randomBytes,
} from 'node:crypto'
import { Buffer } from 'node:buffer'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { BEAM_CONFIG, readBeam, uploadBundle } from './beam.mjs'
import { GRADLE, changelogSection, packageVersion, phoneVersion } from './release-plan.mjs'

export const BUNDLE_DIR = 'web/dist-mobile'
export const MOBILE_PACKAGE = 'mobile/package.json'
export const MOBILE_CHANGELOG = 'mobile/CHANGELOG.md'
export const PUBLIC_KEY = 'mobile/ota-public-key.pem'

const AES = 'aes-128-cbc'
const PADDING = constants.RSA_PKCS1_PADDING
/** What the plugin's PKCS#1 parser and decryptFile insist on. */
const PKCS1_PUBLIC_HEADER = '-----BEGIN RSA PUBLIC KEY-----'

/**
 * Every file under `dir` by its path inside the zip, `/`-separated. Vite's
 * `.vite/` (the manifest and the bundle guard's module list) is a build record,
 * not part of the app, and stays out.
 */
export function bundleFiles(dir) {
  const files = {}
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      const name = relative(dir, full).split(sep).join('/')
      if (name === '.vite') continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files[name] = readFileSync(full)
    }
  }
  walk(dir)
  return files
}

/** The zip the plugin unpacks as the WebView's root, so `index.html` must be at its top. */
export function zipBundle(files) {
  if (!files['index.html']) throw new Error('the bundle has no index.html at its root')
  const entries = {}
  // A fixed date keeps the zip a function of its files alone.
  for (const name of Object.keys(files).sort())
    entries[name] = [files[name], { mtime: new Date('2026-01-01T00:00:00Z') }]
  return Buffer.from(zipSync(entries, { level: 9 }))
}

function privateKeyOf(pem) {
  const key = createPrivateKey(pem)
  if (key.asymmetricKeyType !== 'rsa')
    throw new Error('the over-the-air private key is not an RSA key')
  // The plugin rejects a checksum that is not exactly 256 bytes.
  if (key.asymmetricKeyDetails?.modulusLength !== 2048)
    throw new Error('the over-the-air private key must be 2048-bit RSA')
  return key
}

export function encryptBundle(zip, privateKeyPem, random = randomBytes) {
  const key = privateKeyOf(privateKeyPem)
  const aesKey = random(16)
  const iv = random(16)
  const cipher = createCipheriv(AES, aesKey, iv)
  const encrypted = Buffer.concat([cipher.update(zip), cipher.final()])
  const sealedKey = privateEncrypt({ key, padding: PADDING }, aesKey)
  const digest = createHash('sha256').update(zip).digest()
  return {
    encrypted,
    sessionKey: `${iv.toString('base64')}:${sealedKey.toString('base64')}`,
    checksum: privateEncrypt({ key, padding: PADDING }, digest).toString('hex'),
  }
}

/** CryptoCipher.isValidSessionKey: exactly two non-empty parts around one `:`. */
function sessionKeyParts(sessionKey) {
  const parts = typeof sessionKey === 'string' ? sessionKey.split(':') : []
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('no valid session key')
  return parts
}

/**
 * What the plugin does with a downloaded bundle when a public key is set,
 * step by step; returns the plain zip or throws where the plugin would fail
 * the download. For the tests and for the check before an upload.
 */
export function verifyBundle({ encrypted, sessionKey, checksum }, publicKeyPem) {
  if (!publicKeyPem.trim().startsWith(PKCS1_PUBLIC_HEADER))
    throw new Error(`the public key is not ${PKCS1_PUBLIC_HEADER}`)
  const publicKey = createPublicKey(publicKeyPem)
  // requireSessionKeyForEncryptedUpdate / requireBundleChecksum
  const [ivB64, keyB64] = sessionKeyParts(sessionKey)
  if (!checksum) throw new Error('no checksum')
  // decryptFile
  const iv = Buffer.from(ivB64, 'base64')
  if (iv.length !== 16) throw new Error('the IV is not 16 bytes')
  const aesKey = publicDecrypt({ key: publicKey, padding: PADDING }, Buffer.from(keyB64, 'base64'))
  if (aesKey.length !== 16) throw new Error('the session key is not 16 bytes')
  const decipher = createDecipheriv(AES, aesKey, iv)
  const zip = Buffer.concat([decipher.update(encrypted), decipher.final()])
  // decryptChecksum: hex when it is all hex digits, base64 otherwise; 256 bytes.
  const sealed = /^[0-9a-fA-F]+$/.test(checksum)
    ? Buffer.from(checksum, 'hex')
    : Buffer.from(checksum, 'base64')
  if (sealed.length !== 256)
    throw new Error(`the checksum is ${sealed.length} bytes, not 256: not signed`)
  const expected = publicDecrypt({ key: publicKey, padding: PADDING }, sealed).toString('hex')
  // calcChecksum over the decrypted file
  const actual = createHash('sha256').update(zip).digest('hex')
  if (expected !== actual) throw new Error('checksum mismatch')
  return zip
}

async function main(argv) {
  const root = new URL('../', import.meta.url)
  const path = (p) => fileURLToPath(new URL(p, root))
  const read = (p) => readFileSync(path(p), 'utf8')

  const keyFile = process.env.OTA_PRIVATE_KEY_FILE
  if (!keyFile)
    throw new Error('OTA_PRIVATE_KEY_FILE names no file with the over-the-air private key')
  const outAt = argv.indexOf('--out')
  const out = outAt === -1 ? null : argv[outAt + 1]
  if (outAt !== -1 && !out) throw new Error('--out needs a file')

  const version = packageVersion(read(MOBILE_PACKAGE), MOBILE_PACKAGE)
  const minNativeVersion = phoneVersion(read(GRADLE))
  const releaseNotes = changelogSection(read(MOBILE_CHANGELOG), version)

  const zip = zipBundle(bundleFiles(path(BUNDLE_DIR)))
  const sealed = encryptBundle(zip, readFileSync(keyFile, 'utf8'))
  try {
    verifyBundle(sealed, read(PUBLIC_KEY))
  } catch (e) {
    throw new Error(
      `the signed bundle does not open with ${PUBLIC_KEY} (${e.message}): ` +
        'the private key is not the pair of the committed public key',
      { cause: e },
    )
  }
  console.log(
    `bundle ${version}: ${Math.round(zip.length / 1024)} KB zipped, signed, and opens with ${PUBLIC_KEY}; ` +
      `needs shell ${minNativeVersion} or newer`,
  )

  if (out) {
    writeFileSync(out, sealed.encrypted)
    console.log(`written to ${out}; nothing uploaded`)
    return
  }
  const beam = readBeam(read(BEAM_CONFIG))
  const answer = await uploadBundle({
    beam,
    uploadKey: process.env.BEAM_UPLOAD_KEY,
    fetch,
    zip: sealed.encrypted,
    version,
    minNativeVersion,
    releaseNotes,
    sessionKey: sealed.sessionKey,
    checksum: sealed.checksum,
  })
  console.log(`uploaded to ${beam.url} as ${beam.appId} ${version}: ${answer.slice(0, 200)}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
