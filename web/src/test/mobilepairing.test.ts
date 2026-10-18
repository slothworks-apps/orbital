import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteClientEvent } from '@orbital/shared/remote/client'
import type { JoinResult } from '@orbital/shared/remote/ceremony'
import { EMPTY_ROSTER } from '@orbital/shared/remote/roster'
import type { GroupClientEvent } from '@orbital/shared/remote/groupClient'
import type { LinkStatus } from '@orbital/shared/remote/relayLink'
import { deviceId, generateIdentity, toBase64Url, type Identity } from '@orbital/shared/remote/keys'

// The run's platform calls and its client are stubbed: these tests are about
// what `runPairing` does in order and when it stops. `vi.mock` is hoisted,
// so the fakes are built with `vi.hoisted`.
const io = vi.hoisted(() => ({
  loadOrCreateIdentity: vi.fn<() => Promise<Identity>>(),
  thisDevice: vi.fn(async () => ({ name: 'Pixel', platform: 'android' })),
  clearUnpaired: vi.fn(async () => {}),
  clearEnded: vi.fn(async () => {}),
  clearStandalone: vi.fn(async () => {}),
  loadStandalone: vi.fn(async () => null),
  newGroup: vi.fn(),
}))
vi.mock('../mobile/connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mobile/connect')>()), newGroup: io.newGroup,
}))
vi.mock('../mobile/platform/identity', () => ({ loadOrCreateIdentity: io.loadOrCreateIdentity }))
vi.mock('../mobile/platform/device', () => ({ thisDevice: io.thisDevice }))
vi.mock('../mobile/platform/pairing', () => ({
  clearUnpaired: io.clearUnpaired, clearEnded: io.clearEnded, clearStandalone: io.clearStandalone, loadStandalone: io.loadStandalone,
}))

import { parseQrText, redeemOutcome } from '../mobile/pairingFlow'
import {
  IN_GROUP, PAIRING_FAILED, RELAY_BUSY, RELAY_REFUSED_SECRET, RELAY_UNREACHABLE, alreadyPaired, joinRefused,
  relayTooOldMessage, runPairing, type PairingStep,
} from '../mobile/pairingRun'
import { initialMobileState, useMobile } from '../mobile/state'
import { clientRef } from '../mobile/transport/clientRef'
import { groupRef, type GroupHandle } from '../mobile/transport/groupRef'

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

function listeners<E>() {
  const set = new Set<(event: E) => void>()
  return {
    on: (listener: (event: E) => void) => {
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
    emit: (event: E) => {
      for (const l of [...set]) l(event)
    },
  }
}

/**
 * A group client that comes online on `start` (or says `onStart` instead)
 * and takes the join; the other device's answer is the test's to give
 * (`emit`). The federation over it is ready at once.
 */
function fakeGroup(onStart: GroupClientEvent = { type: 'status', status: 'online' }) {
  const events = listeners<GroupClientEvent>()
  const group = {
    status: 'off' as LinkStatus,
    relayTooOld: null as { relayVersion: string | null; needed: string } | null,
    on: events.on,
    start: vi.fn(() => {
      if (onStart.type === 'status') group.status = onStart.status
      events.emit(onStart)
    }),
    stop: vi.fn(),
    cancelJoin: vi.fn(() => true),
    members: () => [],
    primary: () => null,
    join: vi.fn(async (): Promise<JoinResult> => ({ device: mac, name: 'studio', code: 'ABC-123' })),
  }
  const federation = {
    ready: true, on: listeners<RemoteClientEvent>().on, sources: () => [], pushToken: vi.fn(),
    stop: vi.fn(() => group.stop()),
  }
  const handle = {
    group, federation, persist: vi.fn(async () => {}), close: vi.fn(async () => {}), relayBusy: vi.fn(() => false),
  }
  return { group, handle: handle as unknown as GroupHandle & { persist: typeof handle.persist }, emit: events.emit }
}

describe('runPairing', () => {
  const phone = generateIdentity()
  const empty = { roster: EMPTY_ROSTER, paired: [], pendingRevokes: [] }
  let steps: PairingStep[]
  let cancel: boolean

  beforeEach(() => {
    vi.clearAllMocks()
    groupRef.set(null)
    useMobile.setState(initialMobileState)
    steps = []
    cancel = false
  })

  const run = () => runPairing(qr, (step) => steps.push(step), () => cancel)

  it('stores the group only once the device said joined, then reports paired', async () => {
    const { group, handle, emit } = fakeGroup()
    io.newGroup.mockReturnValue(handle)
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    const done = run()
    await vi.waitFor(() => expect(group.join).toHaveBeenCalledWith(JSON.stringify(qr)))
    // A fresh client on the code's relay, storing nothing until it pairs.
    expect(io.newGroup).toHaveBeenCalledWith(
      { relay: qr.relay, group: empty }, phone, { name: 'Pixel', platform: 'android' }, { persist: false },
    )
    expect(clientRef.client).toBe(handle.federation)
    expect(handle.persist).not.toHaveBeenCalled()
    // Another device's answer is not this one's.
    emit({ type: 'joined', peer: 'someone-else' })
    expect(handle.persist).not.toHaveBeenCalled()
    emit({ type: 'joined', peer: mac })
    await done
    expect(handle.persist).toHaveBeenCalled()
    expect(useMobile.getState().pairing).toMatchObject({ relay: qr.relay, mac: qr.mac, macName: 'studio' })
    // A code without a relay secret (an open relay, an older Mac) stores none.
    expect(useMobile.getState().pairing).not.toHaveProperty('relaySecret')
    expect(steps.map((s) => s.kind)).toEqual(['connecting', 'confirm', 'paired'])
    expect(groupRef.current).toBe(handle)
  })

  it("puts the code's relay secret on the client and keeps it with the pairing", async () => {
    const { group, handle, emit } = fakeGroup()
    io.newGroup.mockReturnValue(handle)
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    const done = runPairing({ ...qr, relaySecret: 's3cret' }, (step) => steps.push(step), () => cancel)
    await vi.waitFor(() => expect(group.join).toHaveBeenCalled())
    expect(io.newGroup).toHaveBeenCalledWith(
      { relay: qr.relay, relaySecret: 's3cret', group: empty }, phone, expect.anything(), { persist: false },
    )
    emit({ type: 'joined', peer: mac })
    await done
    expect(useMobile.getState().pairing?.relaySecret).toBe('s3cret')
  })

  it('a device that rejects the join says so, and the client goes', async () => {
    const { group, handle, emit } = fakeGroup()
    io.newGroup.mockReturnValue(handle)
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    const done = run()
    await vi.waitFor(() => expect(group.join).toHaveBeenCalled())
    emit({ type: 'join_failed', peer: mac, reason: 'rejected' })
    await done
    expect(steps.at(-1)).toEqual({ kind: 'expired', name: 'studio', rejected: true })
    expect(handle.persist).not.toHaveBeenCalled()
    expect(clientRef.client).toBeNull()
    expect(group.stop).toHaveBeenCalled()
  })

  it('a Cancel during the key load builds no client and starts nothing', async () => {
    const identity = deferred<Identity>()
    io.loadOrCreateIdentity.mockReturnValue(identity.promise)
    const setRef = vi.spyOn(clientRef, 'set')
    const done = run()
    cancel = true
    identity.resolve(phone)
    await done
    expect(io.newGroup).not.toHaveBeenCalled()
    expect(setRef).not.toHaveBeenCalled()
    expect(steps.map((s) => s.kind)).toEqual(['connecting'])
    setRef.mockRestore()
  })

  it('a Cancel during the device lookup builds no client and sends no join', async () => {
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    const device = deferred<{ name: string; platform: string }>()
    io.thisDevice.mockReturnValueOnce(device.promise)
    const done = run()
    await vi.waitFor(() => expect(io.thisDevice).toHaveBeenCalled())
    cancel = true
    device.resolve({ name: 'Pixel', platform: 'android' })
    await done
    expect(io.newGroup).not.toHaveBeenCalled()
  })

  it('a relay that refuses the code’s secret goes back to scan at once and drops the client', async () => {
    const { group, handle } = fakeGroup({ type: 'relay_error', code: 'bad_secret' })
    io.newGroup.mockReturnValue(handle)
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    const started = Date.now()
    await runPairing({ ...qr, relaySecret: 'stale' }, (step) => steps.push(step), () => cancel)
    // Not after the connect timeout: the refusal itself ends the wait.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(steps).toEqual([{ kind: 'connecting' }, { kind: 'scan', error: RELAY_REFUSED_SECRET }])
    expect(clientRef.client).toBeNull()
    expect(group.stop).toHaveBeenCalled()
    expect(group.join).not.toHaveBeenCalled()
  })

  it('a relay too old goes back to scan at once, at connect or in the join', async () => {
    const tooOld = { relayVersion: '0.1.0', needed: '0.3.0' }
    const atConnect = fakeGroup({ type: 'relay_too_old', ...tooOld })
    io.newGroup.mockReturnValue(atConnect.handle)
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    const started = Date.now()
    await run()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(steps).toEqual([{ kind: 'connecting' }, { kind: 'scan', error: relayTooOldMessage(qr.relay, tooOld) }])
    expect(atConnect.group.join).not.toHaveBeenCalled()
    expect(clientRef.client).toBeNull()

    const atJoin = fakeGroup()
    atJoin.group.join.mockResolvedValueOnce({ error: 'relay_too_old' })
    atJoin.group.relayTooOld = tooOld
    io.newGroup.mockReturnValue(atJoin.handle)
    steps = []
    await run()
    expect(steps.at(-1)).toEqual({ kind: 'scan', error: relayTooOldMessage(qr.relay, tooOld) })
    expect(atJoin.handle.persist).not.toHaveBeenCalled()
    expect(clientRef.client).toBeNull()
  })

  it('a phone in a group joins through its own client, and keeps it when the code is from another group', async () => {
    const { group, handle } = fakeGroup()
    group.status = 'online'
    group.join.mockResolvedValueOnce({ error: 'in_group' })
    groupRef.set(handle)
    useMobile.setState({ pairing: { relay: qr.relay, mac: 'other', macName: 'laptop', fingerprint: 'f', pairedAt: 1 } })
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    await run()
    expect(io.newGroup).not.toHaveBeenCalled()
    expect(group.start).not.toHaveBeenCalled()
    expect(steps.at(-1)).toEqual({ kind: 'scan', error: IN_GROUP })
    expect(groupRef.current).toBe(handle)
    expect(group.stop).not.toHaveBeenCalled()
  })

  it('a run that throws goes back to scan and drops its client', async () => {
    io.loadOrCreateIdentity.mockRejectedValue(new Error('keystore'))
    await expect(run()).resolves.toBeUndefined()
    expect(steps.at(-1)).toEqual({ kind: 'scan', error: PAIRING_FAILED })

    const { group, handle, emit } = fakeGroup()
    handle.persist.mockRejectedValueOnce(new Error('storage'))
    io.newGroup.mockReturnValue(handle)
    io.loadOrCreateIdentity.mockResolvedValue(phone)
    steps = []
    const done = run()
    await vi.waitFor(() => expect(group.join).toHaveBeenCalled())
    emit({ type: 'joined', peer: mac })
    await done
    expect(steps.at(-1)).toEqual({ kind: 'scan', error: PAIRING_FAILED })
    expect(clientRef.client).toBeNull()
    expect(group.stop).toHaveBeenCalled()
  })
})

describe('joinRefused', () => {
  const ours = 'https://relay.orbital.dev'

  it('tells a busy relay from one that cannot be reached', () => {
    expect(joinRefused({ error: 'relay_error' }, qr, ours, null, true)).toEqual({ kind: 'scan', error: RELAY_BUSY })
    expect(joinRefused({ error: 'relay_error' }, qr, ours, null, false)).toEqual({ kind: 'scan', error: RELAY_UNREACHABLE })
    // Offline is this phone's own link, whatever the relay last said.
    expect(joinRefused({ error: 'offline' }, qr, ours, null, true)).toEqual({ kind: 'scan', error: RELAY_UNREACHABLE })
  })

  it('names both relays when the code is for another one', () => {
    const step = joinRefused({ error: 'other_relay', relay: 'https://relay.lab.internal/' }, qr, ours, null, false)
    expect(step).toEqual({
      kind: 'scan',
      error: {
        title: 'studio uses another relay',
        body: "It's on relay.lab.internal; this phone is on relay.orbital.dev. Both need the same one.",
      },
    })
  })

  it('reads a used-up code as expired, and the device gone as offline with its code still counting down', () => {
    expect(joinRefused({ error: 'bad_code' }, qr, ours, null, false)).toEqual({ kind: 'expired', name: 'studio', rejected: false })
    expect(joinRefused({ error: 'peer_offline', expiresAt: 5 }, qr, ours, null, false)).toEqual({ kind: 'offline', name: 'studio', expiresAt: 5 })
    expect(joinRefused({ error: 'peer_offline' }, { ...qr, expiresAt: 7 }, ours, null, false)).toEqual({ kind: 'offline', name: 'studio', expiresAt: 7 })
    expect(joinRefused({ error: 'peer_offline' }, qr, ours, null, false)).toEqual({ kind: 'offline', name: 'studio', expiresAt: null })
  })

  it('says which device the phone is paired with already, and that a phone in a group leaves it first', () => {
    expect(joinRefused({ error: 'already_paired' }, qr, ours, null, false)).toEqual({ kind: 'scan', error: alreadyPaired('studio') })
    expect(joinRefused({ error: 'in_group' }, qr, ours, null, false)).toEqual({ kind: 'scan', error: IN_GROUP })
  })
})
