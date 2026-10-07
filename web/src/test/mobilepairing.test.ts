import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteClientEvent } from '@orbital/shared/remote/client'
import { deviceId, generateIdentity, toBase64Url, type Identity } from '@orbital/shared/remote/keys'

// The run's platform calls and its client are stubbed: these tests are about
// what `runPairing` does in order and when it stops. `vi.mock` is hoisted,
// so the fakes are built with `vi.hoisted`.
const io = vi.hoisted(() => ({
  loadOrCreateIdentity: vi.fn<() => Promise<Identity>>(),
  thisDevice: vi.fn(async () => ({ name: 'Pixel', platform: 'android' })),
  savePairing: vi.fn(async () => {}),
  clearUnpaired: vi.fn(async () => {}),
  newClient: vi.fn(),
}))
vi.mock('../mobile/connect', () => ({ newClient: io.newClient }))
vi.mock('../mobile/platform/identity', () => ({ loadOrCreateIdentity: io.loadOrCreateIdentity }))
vi.mock('../mobile/platform/device', () => ({ thisDevice: io.thisDevice }))
vi.mock('../mobile/platform/pairing', () => ({ savePairing: io.savePairing, clearUnpaired: io.clearUnpaired }))

import { parseQrText, redeemOutcome } from '../mobile/pairingFlow'
import { PAIRING_FAILED, RELAY_REFUSED_SECRET, relayTooOldMessage, runPairing, type PairingStep } from '../mobile/pairingRun'
import { initialMobileState, useMobile } from '../mobile/state'
import { clientRef } from '../mobile/transport/clientRef'

const mac = deviceId(generateIdentity().publicKey)
const qr = {
  v: 1 as const, relay: 'https://relay.example.org', mac, name: 'studio', token: 'tok',
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * A client that comes online on `start` (or says `onStart` instead) and
 * answers the redeem with 200; the Mac's answer is the test's to give.
 */
function fakeClient(onStart: RemoteClientEvent = { type: 'status', status: 'online' }) {
  const listeners = new Set<(event: RemoteClientEvent) => void>()
  const outcome = deferred<'paired' | 'rejected' | 'timeout'>()
  const client = {
    ready: true,
    on: (listener: (event: RemoteClientEvent) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start: vi.fn(() => {
      for (const l of [...listeners]) l(onStart)
    }),
    stop: vi.fn(),
    redeem: vi.fn(async () => ({ status: 200, body: {} })),
    waitForPairing: vi.fn(() => outcome.promise),
  }
  return { client, outcome }
}

describe('runPairing', () => {
  const phone = generateIdentity()
  let steps: PairingStep[]
  let cancel: boolean

  beforeEach(() => {
    vi.clearAllMocks()
    clientRef.set(null)
    useMobile.setState(initialMobileState)
    steps = []
    cancel = false
  })

  const run = () => runPairing(qr, (step) => steps.push(step), () => cancel)

  it('saves the pairing only once the Mac said paired, then reports paired', async () => {
    const { client, outcome } = fakeClient()
    io.newClient.mockReturnValue(client)
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    const done = run()
    await vi.waitFor(() => expect(client.redeem).toHaveBeenCalledWith('tok', qr.secret, 'Pixel', 'android'))
    // No pair exists yet: asking the relay to confirm one would get `unpaired`.
    expect(io.newClient).toHaveBeenCalledWith(qr.relay, qr.mac, phone, { expectPaired: false })
    expect(io.savePairing).not.toHaveBeenCalled()
    outcome.resolve('paired')
    await done
    expect(io.savePairing).toHaveBeenCalledWith(expect.objectContaining({ relay: qr.relay, mac: qr.mac, macName: 'studio' }))
    // A code without a relay secret (an open relay, an older Mac) stores none.
    expect(io.savePairing).not.toHaveBeenCalledWith(expect.objectContaining({ relaySecret: expect.anything() }))
    expect(useMobile.getState().pairing?.mac).toBe(qr.mac)
    expect(steps.map((s) => s.kind)).toEqual(['connecting', 'confirm', 'paired'])
  })

  it("sends the code's relay secret and keeps it with the pairing", async () => {
    const { client, outcome } = fakeClient()
    io.newClient.mockReturnValue(client)
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    const done = runPairing({ ...qr, relaySecret: 's3cret' }, (step) => steps.push(step), () => cancel)
    await vi.waitFor(() => expect(client.redeem).toHaveBeenCalled())
    expect(io.newClient).toHaveBeenCalledWith(qr.relay, qr.mac, phone, { expectPaired: false, relaySecret: 's3cret' })
    outcome.resolve('paired')
    await done
    expect(io.savePairing).toHaveBeenCalledWith(expect.objectContaining({ relaySecret: 's3cret' }))
    expect(useMobile.getState().pairing?.relaySecret).toBe('s3cret')
  })

  it('a Cancel during the key load builds no client and starts nothing', async () => {
    const { client } = fakeClient()
    io.newClient.mockReturnValue(client)
    const identity = deferred<Identity>()
    io.loadOrCreateIdentity.mockReturnValue(identity.promise)
    const setRef = vi.spyOn(clientRef, 'set')
    const done = run()
    cancel = true
    identity.resolve(phone)
    await done
    expect(io.newClient).not.toHaveBeenCalled()
    expect(setRef).not.toHaveBeenCalled()
    expect(client.start).not.toHaveBeenCalled()
    expect(steps.map((s) => s.kind)).toEqual(['connecting'])
    setRef.mockRestore()
  })

  it('a Cancel during the device lookup sends no redeem', async () => {
    const { client } = fakeClient()
    io.newClient.mockReturnValue(client)
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    const device = deferred<{ name: string; platform: string }>()
    io.thisDevice.mockReturnValueOnce(device.promise)
    const done = run()
    await vi.waitFor(() => expect(io.thisDevice).toHaveBeenCalled())
    cancel = true
    device.resolve({ name: 'Pixel', platform: 'android' })
    await done
    expect(client.redeem).not.toHaveBeenCalled()
    expect(io.savePairing).not.toHaveBeenCalled()
  })

  it('a relay that refuses the code’s secret goes back to scan at once and drops the client', async () => {
    const { client } = fakeClient({ type: 'relay_error', code: 'bad_secret' })
    io.newClient.mockReturnValue(client)
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    const started = Date.now()
    await runPairing({ ...qr, relaySecret: 'stale' }, (step) => steps.push(step), () => cancel)
    // Not after the connect timeout: the refusal itself ends the wait.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(steps).toEqual([{ kind: 'connecting' }, { kind: 'scan', error: RELAY_REFUSED_SECRET }])
    expect(clientRef.client).toBeNull()
    expect(client.stop).toHaveBeenCalled()
    expect(client.redeem).not.toHaveBeenCalled()
  })

  it('a relay too old goes back to scan at once, at connect or in the redeem', async () => {
    const tooOld = { relayVersion: '0.1.0', needed: '0.3.0' }
    const atConnect = fakeClient({ type: 'relay_too_old', ...tooOld }).client
    io.newClient.mockReturnValue(atConnect)
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    const started = Date.now()
    await run()
    // Not after the connect timeout: the refusal itself ends the wait.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(steps).toEqual([{ kind: 'connecting' }, { kind: 'scan', error: relayTooOldMessage(qr.relay, tooOld) }])
    expect(atConnect.redeem).not.toHaveBeenCalled()
    expect(clientRef.client).toBeNull()

    const { client: atRedeem, outcome } = fakeClient()
    atRedeem.redeem.mockResolvedValueOnce({ status: 200, body: {}, relayTooOld: tooOld } as never)
    io.newClient.mockReturnValue(atRedeem)
    steps = []
    const done = run()
    // Not waiting for the Mac: the redeem's answer already says the relay cannot carry this pair.
    await done
    outcome.resolve('paired')
    expect(steps.at(-1)).toEqual({ kind: 'scan', error: relayTooOldMessage(qr.relay, tooOld) })
    expect(io.savePairing).not.toHaveBeenCalled()
    expect(clientRef.client).toBeNull()
  })

  it('a run that throws goes back to scan and drops its client', async () => {
    io.loadOrCreateIdentity.mockRejectedValue(new Error('keystore'))
    await expect(run()).resolves.toBeUndefined()
    expect(steps.at(-1)).toEqual({ kind: 'scan', error: PAIRING_FAILED })

    const { client } = fakeClient()
    io.newClient.mockReturnValue(client)
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    io.thisDevice.mockRejectedValueOnce(new Error('device'))
    steps = []
    await run()
    expect(steps.at(-1)).toEqual({ kind: 'scan', error: PAIRING_FAILED })
    expect(clientRef.client).toBeNull()
    expect(client.stop).toHaveBeenCalled()
  })
})
