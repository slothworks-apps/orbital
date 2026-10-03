import { describe, expect, it, vi } from 'vitest'
import { deviceId, generateIdentity, toBase64Url } from '@orbital/shared/remote/keys'
import { base64ToBytes, bytesToBase64 } from '../mobile/platform/base64'
import { forgetIdentity, IDENTITY_KEY, loadOrCreateIdentity } from '../mobile/platform/identity'
import { readCachedImage } from '../mobile/platform/imageCache'
import {
  FALLBACK_DEVICE_NAME, acceptMessages, acceptNotifications, acceptSessions, deviceName, identityBackend,
  isImageRef, parseCached, parseIdentity, parsePairing, serializeIdentity,
} from '../mobile/platform/parse'

// Stubbed so `readCachedImage`'s ref check is provably checked before any
// plugin call reaches native code — never a real file read in this suite.
// `vi.mock` is hoisted above every import, so the fake it returns must be
// built with `vi.hoisted` rather than a plain top-level `const`.
const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: { readFile },
}))

describe('identity', () => {
  it('round-trips through its stored form', () => {
    const identity = generateIdentity()
    const back = parseIdentity(serializeIdentity(identity))
    expect(back && Array.from(back.publicKey)).toEqual(Array.from(identity.publicKey))
  })

  it('reads nothing from nothing, garbage, a wrong length or a non-canonical spelling', () => {
    expect(parseIdentity(null)).toBeNull()
    expect(parseIdentity('not a key')).toBeNull()
    expect(parseIdentity(toBase64Url(new Uint8Array(16)))).toBeNull()
    expect(parseIdentity(`${serializeIdentity(generateIdentity())}=`)).toBeNull()
  })

  it('keeps the key in secure storage on a device and in localStorage in a browser', () => {
    expect(identityBackend(true)).toBe('secure')
    expect(identityBackend(false)).toBe('local')
  })
})

describe('parsePairing', () => {
  const mac = deviceId(generateIdentity().publicKey)
  const good = { relay: 'https://relay.example.org', mac, macName: 'studio', fingerprint: 'ABC123', pairedAt: 1 }

  it('reads a stored pairing', () => {
    expect(parsePairing(JSON.stringify(good))).toEqual(good)
  })

  it('reads nothing from bad JSON, a missing field, a bad Mac id or a relay that is not http(s)', () => {
    expect(parsePairing(null)).toBeNull()
    expect(parsePairing('{')).toBeNull()
    expect(parsePairing(JSON.stringify({ ...good, macName: undefined }))).toBeNull()
    expect(parsePairing(JSON.stringify({ ...good, mac: 'nope' }))).toBeNull()
    expect(parsePairing(JSON.stringify({ ...good, relay: 'ftp://relay.example.org' }))).toBeNull()
  })

  it('keeps the relay secret when there is one, and reads anything but a string as none', () => {
    expect(parsePairing(JSON.stringify({ ...good, relaySecret: 's3cret' }))).toEqual({ ...good, relaySecret: 's3cret' })
    expect(parsePairing(JSON.stringify({ ...good, relaySecret: 42 }))).toEqual(good)
    expect(parsePairing(JSON.stringify({ ...good, relaySecret: null }))).toEqual(good)
  })
})

describe('parseCached', () => {
  it('reads a cached value with its asOf', () => {
    const raw = JSON.stringify({ asOf: 5, value: { sessions: [], tags: [] } })
    expect(parseCached(raw, acceptSessions)).toEqual({ asOf: 5, value: { sessions: [], tags: [] } })
  })

  it('reads nothing from bad JSON, a missing asOf or a value of the wrong shape', () => {
    expect(parseCached('{nope', acceptSessions)).toBeNull()
    expect(parseCached(JSON.stringify({ value: { sessions: [], tags: [] } }), acceptSessions)).toBeNull()
    expect(parseCached(JSON.stringify({ asOf: 5, value: { sessions: 'x', tags: [] } }), acceptSessions)).toBeNull()
    expect(parseCached(JSON.stringify({ asOf: 5, value: {} }), acceptMessages)).toBeNull()
  })

  it('accepts notification rules only in their full shape', () => {
    const rules = { needsInput: true, sessionEnded: false, sessionFailed: true, onlyWhenBackground: true, sound: false }
    expect(acceptNotifications(rules)).toEqual(rules)
    expect(acceptNotifications({ ...rules, sound: undefined })).toBeNull()
  })
})

describe('base64', () => {
  it('round-trips every byte value, past one chunk', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256)
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
    expect(bytesToBase64(new Uint8Array(0))).toBe('')
  })
})

describe('deviceName', () => {
  it('names the phone by its model, else by the fallback', () => {
    expect(deviceName({ model: 'Pixel 8' })).toBe('Pixel 8')
    expect(deviceName({ model: '  ' })).toBe(FALLBACK_DEVICE_NAME)
    expect(deviceName(null)).toBe(FALLBACK_DEVICE_NAME)
  })
})

describe('isImageRef', () => {
  it('accepts the one canonical shape and rejects a path escape, a wrong case, a wrong extension or nothing', () => {
    expect(isImageRef(`${'a'.repeat(64)}.png`)).toBe(true)
    expect(isImageRef('../x.png')).toBe(false)
    expect(isImageRef(`${'A'.repeat(64)}.png`)).toBe(false)
    expect(isImageRef(`${'a'.repeat(64)}.bmp`)).toBe(false)
    expect(isImageRef('')).toBe(false)
  })
})

describe('readCachedImage', () => {
  it('rejects a ref that could escape the cache directory without touching the plugin', async () => {
    readFile.mockClear()
    expect(await readCachedImage('../etc')).toBeNull()
    expect(readFile).not.toHaveBeenCalled()
  })
})

describe('loadOrCreateIdentity', () => {
  it('does not remember a failed read: the next call reads again', async () => {
    // jsdom is no native platform, so the identity lives in localStorage here.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
      throw new Error('keystore hiccup')
    })
    try {
      await expect(loadOrCreateIdentity()).rejects.toThrow('keystore hiccup')
      const identity = await loadOrCreateIdentity()
      expect(localStorage.getItem(IDENTITY_KEY)).not.toBeNull()
      expect(await loadOrCreateIdentity()).toBe(identity)
    } finally {
      getItem.mockRestore()
      await forgetIdentity()
    }
  })
})
