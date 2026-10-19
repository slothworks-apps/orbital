import { describe, expect, it } from 'vitest'
import {
  endedSeenVersion, installedLine, parseSeenVersion, serializeSeenVersion, whatsNewOnLaunch,
} from '../lib/whatsNew'

const NOW = 1_760_000_000_000

describe('whatsNewOnLaunch', () => {
  it('remembers a first install silently', () => {
    expect(whatsNewOnLaunch({ stored: null, version: '0.36.0', hasNotes: true, now: NOW })).toEqual({
      show: false,
      installedAt: NOW,
      write: { version: '0.36.0', at: NOW, ended: true },
    })
  })

  it('shows once after the version changed, and remembers it as not ended', () => {
    const stored = { version: '0.35.0', at: 1, ended: true }
    expect(whatsNewOnLaunch({ stored, version: '0.36.0', hasNotes: true, now: NOW })).toEqual({
      show: true,
      installedAt: NOW,
      write: { version: '0.36.0', at: NOW, ended: false },
    })
  })

  it('shows again at the next launch until it ends, dated from the first', () => {
    const pending = { version: '0.36.0', at: 5, ended: false }
    expect(whatsNewOnLaunch({ stored: pending, version: '0.36.0', hasNotes: true, now: NOW })).toEqual({
      show: true,
      installedAt: 5,
      write: null,
    })
    const ended = endedSeenVersion('0.36.0', 5)
    expect(whatsNewOnLaunch({ stored: ended, version: '0.36.0', hasNotes: true, now: NOW })).toMatchObject({
      show: false,
      write: null,
    })
  })

  it('shows nothing for a version the changelog has no section for, and does not ask again', () => {
    const stored = { version: '0.35.0', at: 1, ended: false }
    const launch = whatsNewOnLaunch({ stored, version: '0.36.0', hasNotes: false, now: NOW })
    expect(launch).toEqual({ show: false, installedAt: NOW, write: { version: '0.36.0', at: NOW, ended: true } })
  })

  it('drops a message left behind by a newer version: only the running one shows', () => {
    // 0.36.0's message never ended; 0.37.0 now runs.
    const stored = { version: '0.36.0', at: 5, ended: false }
    expect(whatsNewOnLaunch({ stored, version: '0.37.0', hasNotes: true, now: NOW }).write).toEqual({
      version: '0.37.0',
      at: NOW,
      ended: false,
    })
  })
})

describe('parseSeenVersion', () => {
  it('reads what it wrote', () => {
    const seen = { version: '0.16.0', at: 42, ended: false }
    expect(parseSeenVersion(serializeSeenVersion(seen))).toEqual(seen)
  })

  it('takes anything else as nothing remembered', () => {
    for (const raw of [null, undefined, '', 'not json', '0.35.0', 'null', '{}', '{"version":"","at":1,"ended":true}',
      '{"version":"1","at":"1","ended":true}', '{"version":"1","at":1}']) {
      expect(parseSeenVersion(raw)).toBeNull()
    }
  })
})

describe('installedLine', () => {
  const day = () => '12 Oct'
  it('says today on the day it was installed, and the day after that', () => {
    const at = new Date(2026, 9, 12, 9, 0).getTime()
    expect(installedLine(at, new Date(2026, 9, 12, 23, 59).getTime(), day)).toBe('installed today')
    expect(installedLine(at, new Date(2026, 9, 13, 0, 1).getTime(), day)).toBe('installed 12 Oct')
  })
})

describe('an install from before WHAT’S NEW', () => {
  it('reads the Mac’s sentinel, or a phone in use with nothing remembered, as one', () => {
    expect(parseSeenVersion('before-whats-new')).toBe('before')
    expect(parseSeenVersion(null, true)).toBe('before')
    expect(parseSeenVersion('garbage', true)).toBe('before')
    // What it remembered wins over the phone's state.
    expect(parseSeenVersion(serializeSeenVersion({ version: '1', at: 1, ended: true }), true)).toEqual({
      version: '1', at: 1, ended: true,
    })
  })

  it('shows the running version once, remembered as not ended', () => {
    expect(whatsNewOnLaunch({ stored: 'before', version: '0.36.0', hasNotes: true, now: NOW })).toEqual({
      show: true,
      installedAt: NOW,
      write: { version: '0.36.0', at: NOW, ended: false },
    })
    expect(whatsNewOnLaunch({ stored: 'before', version: '0.36.0', hasNotes: false, now: NOW })).toMatchObject({
      show: false,
      write: { ended: true },
    })
  })
})

describe('a version going backwards', () => {
  it('shows nothing and keeps the newer version remembered', () => {
    const newer = { version: '0.36.0', at: 5, ended: true }
    expect(whatsNewOnLaunch({ stored: newer, version: '0.35.2', hasNotes: true, now: NOW })).toEqual({
      show: false,
      installedAt: NOW,
      write: null,
    })
    // Forward again to the version already told: nothing.
    expect(whatsNewOnLaunch({ stored: newer, version: '0.36.0', hasNotes: true, now: NOW }).show).toBe(false)
    // Numbers, not text: 0.10.0 is newer than 0.9.0.
    expect(whatsNewOnLaunch({ stored: { version: '0.9.0', at: 1, ended: true }, version: '0.10.0', hasNotes: true, now: NOW }).show).toBe(true)
  })
})
