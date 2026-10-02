import { describe, expect, it } from 'vitest'
import { MIN_SERVER_VERSION, compareVersions, isSupportedServer } from '../mobile/version'
import { back, initialMobileState, isMacAsleep, isPairGone, reduce, type MobileState } from '../mobile/state'

const NOW = 1_000
const state = (patch: Partial<MobileState> = {}): MobileState => ({ ...initialMobileState, ...patch })

describe('compareVersions', () => {
  it('compares dotted numbers numerically, a missing part as zero', () => {
    expect(compareVersions('0.17.10', '0.17.9')).toBe(1)
    expect(compareVersions('0.17', '0.17.0')).toBe(0)
    expect(compareVersions('0.16.9', '0.17.0')).toBe(-1)
  })

  it('ignores a pre-release suffix and counts dev as the newest', () => {
    expect(compareVersions('0.18.0-beta.1', '0.18.0')).toBe(0)
    expect(compareVersions('dev', '99.0.0')).toBe(1)
    expect(compareVersions('dev', 'dev')).toBe(0)
    expect(compareVersions('1.0.0', 'dev')).toBe(-1)
  })

  it('supports a Mac from MIN_SERVER_VERSION on', () => {
    expect(isSupportedServer(MIN_SERVER_VERSION)).toBe(true)
    expect(isSupportedServer('dev')).toBe(true)
    expect(isSupportedServer('0.0.1')).toBe(false)
    expect(isSupportedServer('')).toBe(false)
  })
})

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
    expect(next).toMatchObject({ screen: 'mismatch', mismatch: { macVersion: '0.16.0', needed: MIN_SERVER_VERSION } })
  })

  it('leaves 9i for the list once a hello is new enough', () => {
    const blocked = state({ screen: 'mismatch', mismatch: { macVersion: '0.16.0', needed: MIN_SERVER_VERSION } })
    expect(reduce(blocked, { type: 'hello', server: MIN_SERVER_VERSION, macName: 'studio' }, NOW)).toMatchObject({
      screen: 'list', mismatch: null, macName: 'studio',
    })
    expect(reduce(state({ screen: 'session' }), { type: 'hello', server: 'dev', macName: 'studio' }, NOW)).not.toHaveProperty('screen')
  })

  it('blocks the app on bye protocol, keeping a Mac version it already knew', () => {
    const known = state({ mismatch: { macVersion: '0.16.0', needed: MIN_SERVER_VERSION } })
    expect(reduce(known, { type: 'bye', reason: 'protocol' }, NOW)).toMatchObject({
      screen: 'mismatch', mismatch: { macVersion: '0.16.0' },
    })
    expect(reduce(state(), { type: 'bye', reason: 'protocol' }, NOW)).toMatchObject({ mismatch: { macVersion: null } })
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

  it('ignores a relay error that says nothing about the pair', () => {
    expect(isPairGone({ type: 'relay_error', code: 'bad_url' })).toBe(false)
    expect(reduce(state(), { type: 'relay_error', code: 'bad_url' }, NOW)).toEqual({})
  })
})

describe('back', () => {
  it('walks session and settings back to the list, and leaves the app from the list', () => {
    expect(back(state({ screen: 'session', sessionId: 's1' }))).toEqual({ screen: 'list', sessionId: null })
    expect(back(state({ screen: 'settings' }))).toEqual({ screen: 'list' })
    expect(back(state({ screen: 'list' }))).toBe('exit')
    expect(back(state({ screen: 'mismatch' }))).toBe('exit')
  })

  it('returns from pairing to where it came from, and stays when there is nowhere to go', () => {
    expect(back(state({ screen: 'pairing', previous: 'unpaired' }))).toEqual({ screen: 'unpaired', previous: null })
    expect(back(state({ screen: 'pairing', previous: null }))).toBe('exit')
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
