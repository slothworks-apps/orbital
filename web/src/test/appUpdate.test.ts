import { describe, expect, it } from 'vitest'
import { autoDownloadOn, updateCheckLine, updateNoticeContent } from '../lib/appUpdate'
import { initialSection } from '../panels/Settings'

// Canvas `Feature - App update`: the UPDATE kind's six states.
describe('updateNoticeContent', () => {
  const v = '0.26.0'

  it('Available: one Download, and × skips that version', () => {
    const c = updateNoticeContent({ phase: 'available', version: v, totalMB: 131 })
    expect(c?.primary).toEqual({ label: 'Download', action: 'download' })
    expect(c?.secondary).toBeUndefined()
    expect(c?.close?.action).toBe('skip')
  })

  it('Downloading: the readout follows the line, and nothing can be pressed', () => {
    const c = updateNoticeContent({ phase: 'downloading', version: v, percent: 42, totalMB: 131 })
    expect(c?.label).toBe('UPDATE · ORBITAL 0.26.0 · DOWNLOADING')
    expect(c?.progress).toEqual({ percent: 42, readout: '55 of 131 MB' })
    expect(c?.primary ?? c?.secondary ?? c?.close).toBeUndefined()
  })

  it('Ready with one button restarts only when nothing is working', () => {
    const c = updateNoticeContent({ phase: 'ready', version: v, workingCount: 0, buttons: 'one' })
    expect(c?.primary).toEqual({ label: 'Restart', action: 'restart-when-idle' })
    expect(c?.secondary).toBeUndefined()
    expect(c?.close?.action).toBe('close')
  })

  it('Ready with two buttons counts what now interrupts, live, keeping its buttons', () => {
    const at = (n: number) => updateNoticeContent({ phase: 'ready', version: v, workingCount: n, buttons: 'two' })
    expect(at(1)?.text).toBe('Orbital 0.26.0 is downloaded. Restarting now interrupts 1 working session.')
    expect(at(3)?.text).toBe('Orbital 0.26.0 is downloaded. Restarting now interrupts 3 working sessions.')
    expect(at(0)?.text).toBe('Orbital 0.26.0 is downloaded. No session is working now, so restarting interrupts nothing.')
    for (const n of [0, 3]) {
      expect(at(n)?.primary?.action).toBe('restart-when-idle')
      expect(at(n)?.secondary?.action).toBe('restart-now')
    }
  })

  it('Waiting: only Cancel, no ×', () => {
    const at = (n: number) => updateNoticeContent({ phase: 'waiting', version: v, workingCount: n })
    expect(at(1)?.text).toBe('Orbital restarts when the last working session finishes.')
    expect(at(2)?.text).toBe('Orbital restarts when the 2 working sessions finish.')
    expect(at(2)?.secondary?.action).toBe('cancel-wait')
    expect(at(2)?.primary ?? at(2)?.close).toBeUndefined()
  })

  it('the receipt: OK ends it, no ×', () => {
    const c = updateNoticeContent({ phase: 'closed', version: v })
    expect(c?.primary?.action).toBe('ok')
    expect(c?.close).toBeUndefined()
  })

  it('says nothing new for none or restarting', () => {
    expect(updateNoticeContent({ phase: 'none' })).toBeNull()
    expect(updateNoticeContent({ phase: 'restarting', version: v })).toBeNull()
  })
})

describe('updateCheckLine', () => {
  const now = 10 * 24 * 60 * 60 * 1000
  const base = { checking: false, answer: null, prompt: { phase: 'none' } as const, autoDownload: false, now }

  it('says how long ago an empty check was', () => {
    expect(updateCheckLine({ ...base, checkedAt: now - 30_000 })).toBe('Checked just now · up to date')
    expect(updateCheckLine({ ...base, checkedAt: now - 12 * 60_000 })).toBe('Checked 12 min ago · up to date')
    expect(updateCheckLine({ ...base, checkedAt: now - 2.5 * 3600_000 })).toBe('Checked 2 h ago · up to date')
    expect(updateCheckLine({ ...base, checkedAt: now - 3 * 86_400_000 })).toBe('Checked 3 d ago · up to date')
    expect(updateCheckLine({ ...base, checkedAt: null })).toBe('Not checked yet')
  })

  it('says what a check found, by the download setting', () => {
    const answer = { kind: 'found', version: '0.26.0' } as const
    expect(updateCheckLine({ ...base, checkedAt: now, answer })).toBe('Orbital 0.26.0 found · offered on the map')
    expect(updateCheckLine({ ...base, checkedAt: now, answer, autoDownload: true })).toBe(
      'Orbital 0.26.0 found · downloading; the prompt appears on the map when it is ready',
    )
    // Downloaded by itself, it is on the map now.
    const prompt = { phase: 'ready', version: '0.26.0', workingCount: 0, buttons: 'one' } as const
    expect(updateCheckLine({ ...base, checkedAt: now, answer, prompt, autoDownload: true })).toBe(
      'Orbital 0.26.0 found · offered on the map',
    )
  })

  it('says it is checking, and when a check could not run', () => {
    expect(updateCheckLine({ ...base, checkedAt: now, checking: true })).toBe('Checking…')
    expect(updateCheckLine({ ...base, checkedAt: now, answer: { kind: 'error' } })).toContain('Could not check')
  })
})

describe('autoDownloadOn', () => {
  it('is off unless the setting says true', () => {
    expect(autoDownloadOn({})).toBe(false)
    expect(autoDownloadOn({ update_auto_download: 'false' })).toBe(false)
    expect(autoDownloadOn({ update_auto_download: 'true' })).toBe(true)
  })
})

describe('Settings › Updates', () => {
  it('opens on a stored Updates only where the desktop bridge is', () => {
    expect(initialSection({ settings_last_section: 'updates' }, true)).toBe('updates')
    expect(initialSection({ settings_last_section: 'updates' }, false)).toBe('general')
  })
})
