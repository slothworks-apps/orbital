import { describe, expect, it } from 'vitest'
import { deviceId, generateIdentity, toBase64Url } from '@orbital/shared/remote/keys'
import { parseQrText, redeemOutcome } from '../mobile/pairingFlow'

const mac = deviceId(generateIdentity().publicKey)
const qr = {
  v: 1, relay: 'https://relay.example.org', mac, name: 'studio', token: 'tok',
  secret: toBase64Url(new Uint8Array(16).fill(1)),
}

describe('parseQrText', () => {
  it('reads the code the Mac shows, with whatever whitespace came with it', () => {
    expect(parseQrText(JSON.stringify(qr))).toEqual(qr)
    expect(parseQrText(`\n  ${JSON.stringify(qr, null, 2)}  \n`)).toEqual(qr)
  })

  it('refuses what is not an Orbital pairing code', () => {
    expect(parseQrText('')).toBeNull()
    expect(parseQrText('https://relay.example.org/pair')).toBeNull()
    expect(parseQrText(JSON.stringify({ ...qr, v: 2 }))).toBeNull()
    expect(parseQrText(JSON.stringify({ ...qr, relay: 'ftp://relay.example.org' }))).toBeNull()
    expect(parseQrText(JSON.stringify({ ...qr, mac: 'nope' }))).toBeNull()
    expect(parseQrText(JSON.stringify({ ...qr, token: '' }))).toBeNull()
  })
})

describe('redeemOutcome', () => {
  it('waits for the Mac only on 200', () => {
    expect(redeemOutcome(200)).toBe('wait')
  })

  it('reads an unknown, used, expired or Mac-offline code as expired', () => {
    for (const status of [400, 401, 404, 409]) expect(redeemOutcome(status)).toBe('expired')
  })

  it('tells a busy relay from one that cannot be reached', () => {
    expect(redeemOutcome(429)).toBe('busy')
    expect(redeemOutcome(0)).toBe('network')
    expect(redeemOutcome(502)).toBe('network')
  })
})
