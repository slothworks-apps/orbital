/* global Response */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import {
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  publicDecrypt,
} from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { unzipSync } from 'fflate'
import { bundleFiles, encryptBundle, verifyBundle, zipBundle } from './ota-bundle.mjs'
import { bundleExists, bundleUrl, readBeam, uploadBundle } from './beam.mjs'

// The plugin parses only a PKCS#1 public key ("BEGIN RSA PUBLIC KEY"), the
// format the runbook's openssl command writes.
const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    publicPem: publicKey.export({ type: 'pkcs1', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }
}
const ours = pair()
const theirs = pair()

const files = {
  'index.html': Buffer.from('<!doctype html><div id="root"></div>'),
  'assets/index-abc.js': Buffer.from('console.log("orbital")'.repeat(200)),
}

test('zips the bundle with index.html at the root and leaves .vite out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ota-bundle-'))
  try {
    mkdirSync(join(dir, 'assets'))
    mkdirSync(join(dir, '.vite'))
    writeFileSync(join(dir, 'index.html'), files['index.html'])
    writeFileSync(join(dir, 'assets', 'index-abc.js'), files['assets/index-abc.js'])
    writeFileSync(join(dir, '.vite', 'manifest.json'), '{}')
    const unzipped = unzipSync(zipBundle(bundleFiles(dir)))
    assert.deepEqual(Object.keys(unzipped).sort(), ['assets/index-abc.js', 'index.html'])
    assert.equal(Buffer.from(unzipped['index.html']).toString(), files['index.html'].toString())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bundle without index.html at its root is refused', () => {
  assert.throws(() => zipBundle({ 'dist/index.html': Buffer.from('x') }), /no index.html/)
})

test('round trip: what the script seals opens with the public key, as the plugin opens it', () => {
  const zip = zipBundle(files)
  const sealed = encryptBundle(zip, ours.privatePem)
  assert.notDeepEqual(sealed.encrypted, zip)
  assert.match(sealed.sessionKey, /^[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/)
  // Hex, 256 bytes: the format the plugin reads first.
  assert.match(sealed.checksum, /^[0-9a-f]{512}$/)
  assert.deepEqual(verifyBundle(sealed, ours.publicPem), zip)
})

test('every bundle gets its own AES key and IV', () => {
  const zip = zipBundle(files)
  const a = encryptBundle(zip, ours.privatePem)
  const b = encryptBundle(zip, ours.privatePem)
  assert.notEqual(a.sessionKey, b.sessionKey)
  assert.equal(a.checksum, b.checksum)
})

test('a zip altered after signing fails the checksum', () => {
  const zip = zipBundle(files)
  const sealed = encryptBundle(zip, ours.privatePem)
  // Swapping in another bundle encrypted under the same session key: it decrypts, and the checksum catches it.
  const other = encryptBundle(
    zipBundle({ ...files, 'index.html': Buffer.from('<script>evil()</script>') }),
    ours.privatePem,
    fixed(sealed),
  )
  assert.throws(
    () => verifyBundle({ ...sealed, encrypted: other.encrypted }, ours.publicPem),
    /checksum mismatch/,
  )
  // A flipped byte in the ciphertext's last block breaks the padding or the checksum.
  const flipped = Buffer.from(sealed.encrypted)
  flipped[flipped.length - 20] ^= 0xff
  assert.throws(() => verifyBundle({ ...sealed, encrypted: flipped }, ours.publicPem))
})

test('a bundle signed with another key does not open with ours', () => {
  const sealed = encryptBundle(zipBundle(files), theirs.privatePem)
  assert.throws(() => verifyBundle(sealed, ours.publicPem))
})

test("our session key with another key's checksum is refused", () => {
  const zip = zipBundle(files)
  const sealed = encryptBundle(zip, ours.privatePem)
  const forged = encryptBundle(zip, theirs.privatePem)
  assert.throws(() => verifyBundle({ ...sealed, checksum: forged.checksum }, ours.publicPem))
})

test('no session key, or a plain SHA-256 for a checksum, is refused', () => {
  const sealed = encryptBundle(zipBundle(files), ours.privatePem)
  assert.throws(
    () => verifyBundle({ ...sealed, sessionKey: '' }, ours.publicPem),
    /no valid session key/,
  )
  assert.throws(
    () => verifyBundle({ ...sealed, sessionKey: 'abc' }, ours.publicPem),
    /no valid session key/,
  )
  const plain = 'a'.repeat(64)
  assert.throws(
    () => verifyBundle({ ...sealed, checksum: plain }, ours.publicPem),
    /32 bytes, not 256/,
  )
})

test('a public key in SPKI form is refused, as the plugin would skip decryption with it', () => {
  const spki = createPublicKey(ours.publicPem).export({ type: 'spki', format: 'pem' })
  const sealed = encryptBundle(zipBundle(files), ours.privatePem)
  assert.throws(() => verifyBundle(sealed, spki), /BEGIN RSA PUBLIC KEY/)
})

test('a key that is not 2048-bit RSA is refused before anything is signed', () => {
  const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  })
  assert.throws(() => encryptBundle(zipBundle(files), small), /2048-bit/)
})

test('the checksum is the SHA-256 of the plain zip, signed: the hex the plugin compares', () => {
  const zip = zipBundle(files)
  const sealed = encryptBundle(zip, ours.privatePem)
  const opened = publicDecrypt(
    { key: createPublicKey(ours.publicPem), padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(sealed.checksum, 'hex'),
  )
  assert.equal(opened.toString('hex'), createHash('sha256').update(zip).digest('hex'))
  // The base64 form older CLIs wrote is read too.
  const b64 = Buffer.from(sealed.checksum, 'hex').toString('base64')
  assert.deepEqual(verifyBundle({ ...sealed, checksum: b64 }, ours.publicPem), zip)
})

// A random source that hands back the AES key and IV of an earlier seal.
function fixed(sealed) {
  const iv = Buffer.from(sealed.sessionKey.split(':')[0], 'base64')
  const key = publicDecryptKey(sealed.sessionKey.split(':')[1])
  const queue = [key, iv]
  return () => queue.shift()
}

function publicDecryptKey(b64) {
  return publicDecrypt(
    { key: createPublicKey(ours.publicPem), padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(b64, 'base64'),
  )
}

// Beam's contract, through a fake fetch.
const beam = readBeam('{"url":"https://beam.example/","appId":"io.example.app"}')

test('looks a version up behind the upload key: 200 is there, 404 is not', async () => {
  const seen = []
  const fetch = (status) => async (url, init) => {
    seen.push([url, init.headers['X-Upload-Key']])
    return new Response('', { status })
  }
  assert.equal(
    await bundleExists({ beam, uploadKey: 'k', version: '0.8.0', fetch: fetch(200) }),
    true,
  )
  assert.equal(
    await bundleExists({ beam, uploadKey: 'k', version: '0.8.0', fetch: fetch(404) }),
    false,
  )
  assert.deepEqual(seen[0], ['https://beam.example/api/apps/io.example.app/bundles/0.8.0', 'k'])
  assert.equal(bundleUrl(beam, '0.8.0'), seen[0][0])
})

test('any other answer, or no upload key, fails the lookup', async () => {
  const fetch = async () => new Response('down', { status: 502 })
  await assert.rejects(bundleExists({ beam, uploadKey: 'k', version: '0.8.0', fetch }), /502/)
  await assert.rejects(
    bundleExists({ beam, uploadKey: 'k', version: '0.8.0', fetch: unauthorized }),
    /401/,
  )
  await assert.rejects(
    bundleExists({ beam, uploadKey: '', version: '0.8.0', fetch }),
    /BEAM_UPLOAD_KEY/,
  )
})

async function unauthorized() {
  return new Response('', { status: 401 })
}

test('uploads the encrypted zip with its session key and signed checksum', async () => {
  let form
  const fetch = async (url, init) => {
    assert.equal(url, 'https://beam.example/api/apps/io.example.app/bundles')
    assert.equal(init.method, 'POST')
    form = init.body
    return new Response('{"id":"1"}', { status: 201 })
  }
  await uploadBundle({
    beam,
    uploadKey: 'k',
    fetch,
    zip: Buffer.from('zip'),
    version: '0.8.0',
    minNativeVersion: '0.8.0',
    releaseNotes: '- Notes.',
    sessionKey: 'iv:key',
    checksum: 'ab',
  })
  assert.equal(form.get('version'), '0.8.0')
  assert.equal(form.get('minNativeVersion'), '0.8.0')
  assert.equal(form.get('releaseNotes'), '- Notes.')
  assert.equal(form.get('sessionKey'), 'iv:key')
  assert.equal(form.get('checksum'), 'ab')
  assert.equal(Buffer.from(await form.get('bundle').arrayBuffer()).toString(), 'zip')
})

test('a version Beam already has is a failed upload', async () => {
  const fetch = async () => new Response('exists', { status: 409 })
  await assert.rejects(
    uploadBundle({
      beam,
      uploadKey: 'k',
      fetch,
      zip: Buffer.from(''),
      version: '0.8.0',
      minNativeVersion: '0.8.0',
      sessionKey: 'a:b',
      checksum: 'c',
    }),
    /already has bundle 0.8.0/,
  )
})
