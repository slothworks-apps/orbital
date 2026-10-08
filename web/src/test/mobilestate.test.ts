import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_SERVER_VERSION } from '../mobile/version'
import {
  back, dismissTopSheet, initialMobileState, isGated, isMacAsleep, isPairGone, keepsSelection, leaveForeground, lockEnabled,
  mayOpenFromNotice, openFromNotice, pairGoneFor, push, pushedTop, reduce, registerSheet, returnToForeground, useMobile,
  type Mismatch, type MobileState, type Pushed,
} from '../mobile/state'

// `recheck`, `client` and `ready` are all of `clientRef` the module under test reads.
vi.mock('../mobile/transport/clientRef', () => ({ clientRef: { recheck: vi.fn(), client: null, ready: false } }))
import { recheckMac, recheckOnForeground } from '../mobile/connect'
import { clientRef } from '../mobile/transport/clientRef'
import type { Pairing } from '../mobile/platform/parse'

const NOW = 1_000
const state = (patch: Partial<MobileState> = {}): MobileState => ({ ...initialMobileState, ...patch })
const PAIRING: Pairing = { relay: 'https://relay.test', mac: 'm', macName: 'studio', fingerprint: 'ABC123', pairedAt: 1 }
const MAC_OLD: Mismatch = { cause: 'mac', theirs: '0.16.0', needed: MIN_SERVER_VERSION }
const RELAY_OLD: Mismatch = { cause: 'relay', theirs: '0.1.0', needed: '0.3.0' }
const APP_OLD: Mismatch = { cause: 'app', theirs: null, needed: '0.5.0' }

describe('reduce', () => {
  it("tracks the relay link and the Mac's presence", () => {
    expect(reduce(state(), { type: 'status', status: 'connecting' }, NOW)).toEqual({ link: 'connecting' })
    expect(reduce(state(), { type: 'presence', macOnline: true }, NOW)).toEqual({ macOnline: true })
  })

  it('stamps asOf when the tunnel comes up and on every hub frame, not when it goes', () => {
    expect(reduce(state(), { type: 'ready', ready: true }, NOW)).toEqual({ ready: true, asOf: NOW })
    expect(reduce(state(), { type: 'hub', frame: {} }, NOW)).toEqual({ asOf: NOW })
    expect(reduce(state({ asOf: 5 }), { type: 'ready', ready: false }, NOW)).toEqual({ ready: false })
  })

  it('blocks the app behind 9i on a Mac older than MIN_SERVER_VERSION, naming both versions', () => {
    const next = reduce(state({ screen: 'list' }), { type: 'hello', server: '0.16.0', macName: 'studio' }, NOW)
    expect(next).toEqual({
      screen: 'mismatch', macName: 'studio', mismatch: { cause: 'mac', theirs: '0.16.0', needed: MIN_SERVER_VERSION },
    })
  })

  it('leaves 9i for the list once a hello is new enough, whatever the cause was', () => {
    for (const mismatch of [MAC_OLD, RELAY_OLD, APP_OLD]) {
      expect(reduce(state({ screen: 'mismatch', mismatch }), { type: 'hello', server: MIN_SERVER_VERSION, macName: 'studio' }, NOW)).toMatchObject({
        screen: 'list', mismatch: null, macName: 'studio',
      })
    }
    expect(reduce(state({ screen: 'session' }), { type: 'hello', server: 'dev', macName: 'studio' }, NOW)).not.toHaveProperty('screen')
  })

  it('blocks the app on bye protocol, keeping a Mac version it already knew', () => {
    expect(reduce(state({ mismatch: MAC_OLD }), { type: 'bye', reason: 'protocol' }, NOW)).toEqual({
      screen: 'mismatch', mismatch: MAC_OLD,
    })
    expect(reduce(state(), { type: 'bye', reason: 'protocol' }, NOW)).toEqual({
      screen: 'mismatch', mismatch: { cause: 'mac', theirs: null, needed: MIN_SERVER_VERSION },
    })
    // A relay's version is not the Mac's.
    expect(reduce(state({ pairing: PAIRING, mismatch: RELAY_OLD }), { type: 'bye', reason: 'protocol' }, NOW)).toMatchObject({
      mismatch: { cause: 'mac', theirs: null },
    })
  })

  it('blocks the app on bye app_too_old with the minimum the Mac sent', () => {
    expect(reduce(state({ screen: 'list' }), { type: 'bye', reason: 'app_too_old', needed: '0.5.0' }, NOW)).toEqual({
      screen: 'mismatch', mismatch: APP_OLD,
    })
    expect(reduce(state(), { type: 'bye', reason: 'app_too_old' }, NOW)).toMatchObject({
      mismatch: { cause: 'app', needed: null },
    })
  })

  it('blocks a paired app on a relay too old, naming both versions', () => {
    const event = { type: 'relay_too_old', relayVersion: '0.1.0', needed: '0.3.0' } as const
    expect(reduce(state({ pairing: PAIRING, screen: 'session' }), event, NOW)).toEqual({ screen: 'mismatch', mismatch: RELAY_OLD })
    // Mid-pairing the pairing run says it on 9e; the app behind it is not blocked.
    expect(reduce(state({ screen: 'pairing' }), event, NOW)).toEqual({})
  })

  it("leaves a relay's 9i once the relay answers ok, and no other cause", () => {
    const online = { type: 'status', status: 'online' } as const
    expect(reduce(state({ pairing: PAIRING, screen: 'mismatch', mismatch: RELAY_OLD }), online, NOW)).toEqual({
      link: 'online', mismatch: null, screen: 'list',
    })
    for (const mismatch of [MAC_OLD, APP_OLD]) {
      expect(reduce(state({ pairing: PAIRING, screen: 'mismatch', mismatch }), online, NOW)).toEqual({ link: 'online' })
    }
  })

  it('goes to 9h on bye revoked, on the relay saying unpaired, and on a relay error that says the pair is gone', () => {
    for (const event of [
      { type: 'bye', reason: 'revoked' } as const,
      { type: 'unpaired' } as const,
      { type: 'relay_error', code: 'not_paired' } as const,
    ]) {
      expect(isPairGone(event)).toBe(true)
      expect(reduce(state({ screen: 'session', sessionId: 's1' }), event, NOW)).toMatchObject({
        screen: 'unpaired', unpaired: true, sessionId: null, pairing: null,
      })
    }
  })

  it('reads a refused relay secret as the pair gone only while a pairing is stored', () => {
    const pairing: Pairing = { relay: 'https://relay.test', mac: 'm', macName: 'studio', fingerprint: 'ABC123', pairedAt: 1 }
    const refused = { type: 'relay_error', code: 'bad_secret' } as const
    // The relay was re-keyed, and only a new code carries the new secret.
    expect(isPairGone(refused)).toBe(true)
    expect(pairGoneFor(refused, pairing)).toBe(true)
    expect(reduce(state({ pairing, screen: 'list' }), refused, NOW)).toMatchObject({ screen: 'unpaired', unpaired: true })
    // Mid-pairing (nothing stored) the pairing run reports it; there is no pair to lose.
    expect(pairGoneFor(refused, null)).toBe(false)
    expect(reduce(state({ screen: 'pairing' }), refused, NOW)).toEqual({})
  })

  it('reads the Mac revoking or the relay saying unpaired as the pair gone, stored pairing or not', () => {
    const pairing: Pairing = { relay: 'https://relay.test', mac: 'm', macName: 'studio', fingerprint: 'ABC123', pairedAt: 1 }
    for (const event of [{ type: 'bye', reason: 'revoked' } as const, { type: 'unpaired' } as const]) {
      expect(pairGoneFor(event, pairing)).toBe(true)
      expect(pairGoneFor(event, null)).toBe(true)
    }
  })

  it('ignores a relay error that says nothing about the pair', () => {
    expect(isPairGone({ type: 'relay_error', code: 'bad_url' })).toBe(false)
    expect(reduce(state(), { type: 'relay_error', code: 'bad_url' }, NOW)).toEqual({})
  })
})

describe('back', () => {
  it('walks session and settings back to the list, and leaves the app from the list', () => {
    expect(back(state({ screen: 'session', sessionId: 's1' }))).toEqual({ screen: 'list', sessionId: null, pushed: [], composerIntent: null })
    expect(back(state({ screen: 'settings' }))).toEqual({ screen: 'list' })
    expect(back(state({ screen: 'new' }))).toEqual({ screen: 'list' })
    expect(back(state({ screen: 'list' }))).toBe('exit')
    expect(back(state({ screen: 'mismatch' }))).toBe('exit')
  })

  it('returns from pairing to where it came from, and stays when there is nowhere to go', () => {
    expect(back(state({ screen: 'pairing', previous: 'unpaired' }))).toEqual({ screen: 'unpaired', previous: null })
    expect(back(state({ screen: 'pairing', previous: null }))).toBe('exit')
  })
})

describe('pushed screens', () => {
  const subagent: Pushed = { kind: 'subagent', sessionId: 's1', toolUseId: 'tu1' }
  const task: Pushed = { kind: 'task', sessionId: 's1', taskId: 't1' }
  const file: Pushed = { kind: 'file', sessionId: 's1', path: 'src/a.ts', line: 42 }

  it('opens over its own session and keeps the session id', () => {
    for (const item of [subagent, task, file]) {
      expect(push(state({ screen: 'session', sessionId: 's1' }), item)).toEqual({ screen: item.kind, sessionId: 's1', pushed: [item] })
    }
  })

  it('opens its session underneath it from the list, a notice or another session', () => {
    expect(push(state({ screen: 'list' }), task)).toEqual({ screen: 'task', sessionId: 's1', pushed: [task] })
    const elsewhere = state({ screen: 'subagent', sessionId: 's2', pushed: [{ kind: 'subagent', sessionId: 's2', toolUseId: 'x' }] })
    expect(push(elsewhere, file)).toEqual({ screen: 'file', sessionId: 's1', pushed: [file] })
  })

  it('goes back from every pushed screen to its session, not the list', () => {
    for (const item of [subagent, task, file]) {
      expect(back(state({ screen: item.kind, sessionId: 's1', pushed: [item] }))).toEqual({ screen: 'session', pushed: [] })
    }
  })

  it('goes back from a file opened in a task output to the output, then to the session', () => {
    const onTask = state({ screen: 'task', sessionId: 's1', pushed: [task] })
    const onFile = { ...onTask, ...push(onTask, file) }
    expect(onFile).toMatchObject({ screen: 'file', sessionId: 's1', pushed: [task, file] })
    const backOnTask = { ...onFile, ...(back(onFile) as Partial<MobileState>) }
    expect(backOnTask).toMatchObject({ screen: 'task', sessionId: 's1', pushed: [task] })
    expect(back(backOnTask)).toEqual({ screen: 'session', pushed: [] })
  })

  it('reads the top only as the kind asked for', () => {
    const s = state({ pushed: [task, file] })
    expect(pushedTop(s, 'file')).toBe(file)
    expect(pushedTop(s, 'task')).toBeNull()
    expect(pushedTop(state(), 'subagent')).toBeNull()
  })

  it('drops the stack when the session closes or the pair is gone', () => {
    expect(back(state({ screen: 'session', sessionId: 's1' }))).toMatchObject({ pushed: [] })
    expect(reduce(state({ screen: 'task', sessionId: 's1', pushed: [task] }), { type: 'unpaired' }, NOW)).toMatchObject({ pushed: [], sessionId: null })
  })

  describe('through the store', () => {
    beforeEach(() => useMobile.setState({ ...initialMobileState, screen: 'session', sessionId: 's1' }))

    it('walks open → back → back from a subagent to the list', () => {
      const m = useMobile.getState()
      m.openSubagent({ sessionId: 's1', toolUseId: 'tu1' })
      expect(useMobile.getState()).toMatchObject({ screen: 'subagent', sessionId: 's1' })
      expect(useMobile.getState().goBack()).toBe('stayed')
      expect(useMobile.getState()).toMatchObject({ screen: 'session', sessionId: 's1', pushed: [] })
      expect(useMobile.getState().goBack()).toBe('stayed')
      expect(useMobile.getState()).toMatchObject({ screen: 'list', sessionId: null })
    })

    it('starts a fresh stack when a session or a base screen opens', () => {
      useMobile.getState().openTask({ sessionId: 's1', taskId: 't1' })
      useMobile.getState().openSession('s2')
      expect(useMobile.getState()).toMatchObject({ screen: 'session', sessionId: 's2', pushed: [] })
      useMobile.getState().openFile({ sessionId: 's2', path: 'a.png', line: null })
      useMobile.getState().go('settings')
      expect(useMobile.getState()).toMatchObject({ screen: 'settings', pushed: [] })
    })
  })
})

describe('keepsSelection', () => {
  beforeEach(() => useMobile.setState({ ...initialMobileState, screen: 'session', sessionId: 's1' }))

  it('keeps the session selected while a screen is pushed over it', () => {
    useMobile.getState().openSubagent({ sessionId: 's1', toolUseId: 'tu1' })
    expect(keepsSelection(useMobile.getState(), 's1')).toBe(true)
    useMobile.getState().openFile({ sessionId: 's1', path: 'a.png', line: null })
    expect(keepsSelection(useMobile.getState(), 's1')).toBe(true)
  })

  it('lets it go on the way back to the list, to a base screen, or to another session', () => {
    useMobile.getState().goBack()
    expect(keepsSelection(useMobile.getState(), 's1')).toBe(false)
    useMobile.setState({ screen: 'session', sessionId: 's1' })
    useMobile.getState().go('settings')
    expect(keepsSelection(useMobile.getState(), 's1')).toBe(false)
    useMobile.setState({ screen: 'session', sessionId: 's1' })
    useMobile.getState().openTask({ sessionId: 's2', taskId: 't1' })
    expect(keepsSelection(useMobile.getState(), 's1')).toBe(false)
  })
})

describe('focusComposer', () => {
  beforeEach(() => useMobile.setState({ ...initialMobileState, screen: 'session', sessionId: 's1' }))

  it('belongs to the open session and counts every request', () => {
    useMobile.getState().focusComposer({ kind: 'reopen', step: 4 })
    useMobile.getState().focusComposer({ kind: 'reopen', step: 4 })
    expect(useMobile.getState().composerIntent).toEqual({ sessionId: 's1', intent: { kind: 'reopen', step: 4 }, seq: 2 })
  })

  it('survives a screen pushed over the session and is gone back on the list or in another session', () => {
    useMobile.getState().focusComposer({ kind: 'reopen', step: 4 })
    useMobile.getState().openFile({ sessionId: 's1', path: 'a.png', line: null })
    useMobile.getState().goBack()
    expect(useMobile.getState().composerIntent).not.toBeNull()
    useMobile.getState().goBack()
    expect(useMobile.getState().composerIntent).toBeNull()

    useMobile.setState({ screen: 'session', sessionId: 's1' })
    useMobile.getState().focusComposer({ kind: 'reopen', step: 2 })
    useMobile.getState().openSession('s1')
    expect(useMobile.getState().composerIntent).not.toBeNull()
    useMobile.getState().openSession('s2')
    expect(useMobile.getState().composerIntent).toBeNull()
  })
})

describe('dismissTopSheet', () => {
  it('closes the newest open sheet first, and reports when there is none', () => {
    const closed: string[] = []
    const offA = registerSheet({ dismiss: () => closed.push('a') })
    const offB = registerSheet({ dismiss: () => closed.push('b') })
    expect(dismissTopSheet()).toBe(true)
    expect(closed).toEqual(['b'])
    offB()
    expect(dismissTopSheet()).toBe(true)
    expect(closed).toEqual(['b', 'a'])
    offA()
    expect(dismissTopSheet()).toBe(false)
  })
})


describe('back from pairing once paired', () => {
  it('goes to the list, not to where pairing began', () => {
    const pairing = { relay: 'https://relay.test', mac: 'm', macName: 'studio', fingerprint: 'ABC123', pairedAt: 1 }
    expect(back(state({ screen: 'pairing', previous: 'unpaired', pairing }))).toEqual({ screen: 'list', previous: null })
    expect(back(state({ screen: 'pairing', previous: null, pairing }))).toEqual({ screen: 'list', previous: null })
  })
})

describe('isMacAsleep', () => {
  it('is false while the relay is still connecting, whatever the Mac', () => {
    expect(isMacAsleep(state({ link: 'connecting', macOnline: false }))).toBe(false)
    expect(isMacAsleep(state({ link: 'off', macOnline: false }))).toBe(false)
  })

  it('is true only with the relay online and the Mac away', () => {
    expect(isMacAsleep(state({ link: 'online', macOnline: false }))).toBe(true)
    expect(isMacAsleep(state({ link: 'online', macOnline: true }))).toBe(false)
  })

  it('holds its answer from before a check while the check rebuilds the link', () => {
    // A healthy Mac: the check drops presence and reconnects, and the card must not flash.
    expect(isMacAsleep(state({ link: 'online', macOnline: false, rechecking: { asleep: false } }))).toBe(false)
    // An asleep Mac: the relay going to connecting mid-check does not hide the card.
    expect(isMacAsleep(state({ link: 'connecting', macOnline: false, rechecking: { asleep: true } }))).toBe(true)
  })
})

describe('mayOpenFromNotice', () => {
  it('lets a notice navigate only with a pair that works', () => {
    expect(mayOpenFromNotice(state({ pairing: PAIRING }))).toBe(true)
    expect(mayOpenFromNotice(state({ pairing: null }))).toBe(false)
    expect(mayOpenFromNotice(state({ pairing: PAIRING, unpaired: true }))).toBe(false)
    expect(mayOpenFromNotice(state({ pairing: PAIRING, mismatch: MAC_OLD }))).toBe(false)
  })
})

describe('the screen-lock and app-lock gates', () => {
  const paired = (patch: Partial<MobileState> = {}) => state({ pairing: PAIRING, screen: 'session', sessionId: 's1', ...patch })

  it('applies the app lock only while a Mac is paired', () => {
    expect(lockEnabled(state({ appLock: true, pairing: PAIRING }))).toBe(true)
    expect(lockEnabled(state({ appLock: true, pairing: null }))).toBe(false)
    expect(lockEnabled(state({ appLock: false, pairing: PAIRING }))).toBe(false)
  })

  it('covers the app on the way out and keeps the screen underneath', () => {
    const out = leaveForeground(paired(), NOW)
    expect(out).toEqual({ backgroundedAt: NOW, lock: 'covered' })
    // A quick return uncovers the same session; nothing about the screen was touched.
    expect(returnToForeground(paired(out), NOW + 1_000)).toEqual({ backgroundedAt: null, lock: 'open' })
  })

  it('ignores the trips out of the foreground the system prompt makes', () => {
    expect(leaveForeground(paired({ authenticating: true }), NOW)).toEqual({})
    expect(returnToForeground(paired({ authenticating: true, lock: 'locked' }), NOW)).toEqual({})
  })

  it('counts either gate as standing in front of the app', () => {
    expect(isGated(state())).toBe(false)
    expect(isGated(state({ screenLock: true }))).toBe(true)
    expect(isGated(state({ lock: 'covered' }))).toBe(true)
  })

  describe('a notice tapped behind a gate', () => {
    beforeEach(() => useMobile.setState({ ...initialMobileState, pairing: PAIRING, lock: 'locked' }))

    it('waits, and opens once the lock lifts', () => {
      const open = vi.fn()
      openFromNotice(open)
      expect(open).not.toHaveBeenCalled()
      useMobile.setState({ lock: 'open' })
      expect(open).toHaveBeenCalledOnce()
    })

    it('is dropped if the pair is gone by the time the lock lifts', () => {
      const open = vi.fn()
      openFromNotice(open)
      useMobile.setState({ pairing: null, unpaired: true })
      useMobile.setState({ lock: 'open' })
      expect(open).not.toHaveBeenCalled()
    })
  })
})

/** A promise this test resolves from the outside, to control the order two `recheckMac` calls settle in. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('recheckMac', () => {
  beforeEach(() => {
    useMobile.setState({ ...initialMobileState, pairing: PAIRING })
    vi.mocked(clientRef.recheck).mockReset()
  })

  it('lets only the call still current when it resolves clear rechecking and write', async () => {
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    vi.mocked(clientRef.recheck).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    // The foreground check starts, then a Retry tap starts a second one while it is still in flight.
    const call1 = recheckMac(1000)
    const call2 = recheckMac(1000)

    // The earlier call's answer lands first, but it has been superseded: rechecking must hold.
    first.resolve(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(useMobile.getState().rechecking).not.toBeNull()
    expect(useMobile.getState().checkedAt).toBeNull()

    // The later call's answer lands: it clears rechecking and writes what it found.
    second.resolve(false)
    await Promise.all([call1, call2])
    expect(useMobile.getState().rechecking).toBeNull()
    expect(useMobile.getState().macOnline).toBe(false)
    expect(useMobile.getState().checkedAt).not.toBeNull()
  })

  it('writes nothing for a check that resolves after the pairing is gone', async () => {
    const check = deferred<boolean>()
    vi.mocked(clientRef.recheck).mockReturnValueOnce(check.promise)

    const call = recheckMac(1000)
    // forgetEverything's reset, mid-flight.
    useMobile.setState({ pairing: null, checkedAt: null, macOnline: false, rechecking: null })
    check.resolve(true)
    await call

    expect(useMobile.getState().checkedAt).toBeNull()
    expect(useMobile.getState().macOnline).toBe(false)
  })
})

describe('recheckOnForeground', () => {
  const ref = clientRef as unknown as { client: object | null; ready: boolean }
  beforeEach(() => {
    useMobile.setState({ ...initialMobileState, pairing: PAIRING })
    vi.mocked(clientRef.recheck).mockReset().mockResolvedValue(true)
    ref.client = {}
    ref.ready = false
  })

  it('leaves a ready tunnel alone, so an upload in flight is not cut', async () => {
    ref.ready = true
    await recheckOnForeground()
    expect(clientRef.recheck).not.toHaveBeenCalled()
  })

  it('rebuilds the link when the tunnel is not ready', async () => {
    await recheckOnForeground()
    expect(clientRef.recheck).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a client', async () => {
    ref.client = null
    await recheckOnForeground()
    expect(clientRef.recheck).not.toHaveBeenCalled()
  })
})
