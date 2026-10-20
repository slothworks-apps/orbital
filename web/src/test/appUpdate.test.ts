import { describe, expect, it } from 'vitest'
import {
  autoDownloadOn, receiptLine, selfUpdateStrip, updateCheckLine, updateNoticeContent, updateNoticeOnMap,
} from '../lib/appUpdate'
import type { FoundOutcome, UpdateBridge, UpdateState } from '../lib/desktop'
import { useAppUpdate } from '../store/appUpdate'
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

  it('Waiting is off the map', () => {
    const waiting = { phase: 'waiting', version: v, workingCount: 2 } as const
    expect(updateNoticeOnMap(waiting)).toBe(false)
    expect(updateNoticeContent(waiting)).toBeNull()
    expect(updateNoticeOnMap({ phase: 'ready', version: v, workingCount: 2, buttons: 'two' })).toBe(true)
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
  const base = { checking: false, answer: null, prompt: { phase: 'none' } as const, now }
  const found = (outcome: FoundOutcome) =>
    updateCheckLine({ ...base, checkedAt: now, answer: { kind: 'found', version: '0.26.0', outcome } })

  it('says how long ago an empty check was', () => {
    expect(updateCheckLine({ ...base, checkedAt: now - 30_000 })).toBe('Checked just now · up to date')
    expect(updateCheckLine({ ...base, checkedAt: now - 12 * 60_000 })).toBe('Checked 12 min ago · up to date')
    expect(updateCheckLine({ ...base, checkedAt: now - 2.5 * 3600_000 })).toBe('Checked 2 h ago · up to date')
    expect(updateCheckLine({ ...base, checkedAt: now - 3 * 86_400_000 })).toBe('Checked 3 d ago · up to date')
    expect(updateCheckLine({ ...base, checkedAt: null })).toBe('Not checked yet')
  })

  it('says what became of the version a check found', () => {
    expect(found('offered')).toBe('Orbital 0.26.0 found · offered on the map')
    expect(found('downloading')).toBe(
      'Orbital 0.26.0 found · downloading; the prompt appears on the map when it is ready',
    )
    expect(found('installs-on-quit')).toBe('Orbital 0.26.0 is downloaded · installs when you quit Orbital')
    expect(found('held')).toBe('Orbital 0.26.0 found · offered after Orbital restarts')
  })

  it('names a prompt already on the map when this visit has not checked', () => {
    const prompt = { phase: 'ready', version: '0.26.0', workingCount: 0, buttons: 'one' } as const
    expect(updateCheckLine({ ...base, checkedAt: now, prompt })).toBe('Orbital 0.26.0 found · offered on the map')
  })

  it('says what a waiting restart waits for, since it is off the map', () => {
    const at = (n: number) =>
      updateCheckLine({ ...base, checkedAt: now, prompt: { phase: 'waiting', version: '0.26.0', workingCount: n } })
    expect(at(1)).toBe('Orbital 0.26.0 restarts when the last working session finishes')
    expect(at(2)).toBe('Orbital 0.26.0 restarts when the 2 working sessions finish')
    // Check now pressed while it waits answers with the same wait, not the map.
    const prompt = { phase: 'waiting', version: '0.26.0', workingCount: 1 } as const
    for (const outcome of ['waiting', 'offered'] as const) {
      const answer = { kind: 'found', version: '0.26.0', outcome } as const
      expect(updateCheckLine({ ...base, checkedAt: now, prompt, answer })).toBe(
        'Orbital 0.26.0 restarts when the last working session finishes',
      )
    }
  })

  it('says it is checking, and when a check could not run', () => {
    expect(updateCheckLine({ ...base, checkedAt: now, checking: true })).toBe('Checking…')
    expect(updateCheckLine({ ...base, checkedAt: now, answer: { kind: 'error' } })).toContain('Could not check')
  })
})

// Canvas 50v: the Mac another member updates, every surface per step, the same words in each.
describe('an update another member started on this Mac', () => {
  const v = '0.36.0'
  const at1402 = () => '14:02'
  const line = (prompt: Parameters<typeof updateCheckLine>[0]['prompt']) =>
    updateCheckLine({ checking: false, answer: null, prompt, checkedAt: 0, now: 0, clock: at1402 })
  const dl = (working: number) =>
    ({ phase: 'downloading', version: v, percent: 41, totalMB: 92, remote: { by: 'Pixel 8', working } }) as const
  const last = (working: number) => ({ phase: 'restarting', version: v, remote: { by: 'Pixel 8', working } }) as const
  const busy = { phase: 'ready', version: v, workingCount: 3, buttons: 'two', sessionStarted: true } as const

  it('01 downloading: named in the head and the line, the live count, nothing to press', () => {
    const c = updateNoticeContent(dl(2))
    expect(c).toEqual({
      label: 'UPDATE · ORBITAL 0.36.0 · STARTED ON PIXEL 8',
      text: 'Pixel 8 is updating this Mac to 0.36.0. When the download finishes, Orbital restarts and the 2 running sessions here stop.',
      progress: { percent: 41, readout: '38 of 92 MB' },
    })
    expect(updateNoticeContent(dl(1))?.text).toContain('Orbital restarts and the running session here stops.')
    expect(updateNoticeContent(dl(0))?.text).toBe('Pixel 8 is updating this Mac to 0.36.0. When the download finishes, Orbital restarts.')
    expect(line(dl(2))).toBe('Updating to 0.36.0 · started on Pixel 8 · 38 of 92 MB')
    expect(selfUpdateStrip(dl(2))).toEqual({ to: v, line: 'updating to 0.36.0 · started on Pixel 8', link: true })
  })

  it('02 the last line: swapped in place on the map, then the restart', () => {
    const c = updateNoticeContent(last(2))
    expect(c).toEqual({
      label: 'UPDATE · ORBITAL 0.36.0 · RESTARTING',
      text: 'Restarting on 0.36.0 · started on Pixel 8. The 2 running sessions stop now.',
    })
    expect(updateNoticeOnMap(last(2))).toBe(true)
    expect(updateNoticeContent(last(0))?.text).toBe('Restarting on 0.36.0 · started on Pixel 8.')
    expect(line(last(2))).toBe('Restarting on 0.36.0 · started on Pixel 8')
    expect(selfUpdateStrip(last(2))).toEqual({ to: v, line: 'restarting on 0.36.0 · sessions here stop now', link: false })
  })

  it('02 waiting (Update when sessions finish): on the map with Cancel, the progress under it while it downloads', () => {
    const wait = (working: number) =>
      ({ phase: 'waiting', version: v, workingCount: working, remote: { by: 'Pixel 8', working, wait: true } }) as const
    expect(updateNoticeContent(wait(2))).toEqual({
      label: 'UPDATE · ORBITAL 0.36.0 · STARTED ON PIXEL 8 · WAITING',
      text: 'Pixel 8 is updating this Mac to 0.36.0. Orbital restarts when the 2 working sessions here finish.',
      secondary: { label: 'Cancel', action: 'cancel-wait' },
    })
    expect(updateNoticeContent(wait(1))?.text).toContain('Orbital restarts when the working session here finishes.')
    expect(updateNoticeOnMap(wait(2))).toBe(true)
    // This Mac's own wait stays off the map.
    expect(updateNoticeOnMap({ phase: 'waiting', version: v, workingCount: 2 })).toBe(false)
    const downloading = { ...dl(2), remote: { by: 'Pixel 8', working: 2, wait: true } }
    expect(updateNoticeContent(downloading)).toMatchObject({
      label: 'UPDATE · ORBITAL 0.36.0 · STARTED ON PIXEL 8 · WAITING',
      progress: { percent: 41, readout: '38 of 92 MB' },
      secondary: { action: 'cancel-wait' },
    })
    expect(line(wait(2))).toBe('Waiting for 2 sessions to finish · then restarts on 0.36.0 · started on Pixel 8')
    expect(line(downloading)).toBe('Waiting for 2 sessions to finish · then restarts on 0.36.0 · started on Pixel 8')
    expect(selfUpdateStrip(wait(2))).toEqual({ to: null, line: 'waiting for 2 sessions to finish · then 0.36.0', link: true })
    expect(selfUpdateStrip(wait(0))?.line).toBe('waiting for the sessions here to finish · then 0.36.0')
    expect(line(wait(0))).toBe('Waiting for the sessions here to finish · then restarts on 0.36.0 · started on Pixel 8')
  })

  it('03 a session started here: the normal Ready, and the lines say it waits for this Mac', () => {
    const c = updateNoticeContent(busy)
    expect(c?.text).toBe('Orbital 0.36.0 is downloaded. Restarting now interrupts 3 working sessions.')
    expect(c?.primary?.label).toBe('Restart when sessions finish')
    expect(c?.secondary?.label).toBe('Restart now')
    expect(c?.close).toBeDefined()
    expect(line(busy)).toBe('Orbital 0.36.0 is downloaded · a session started here, so it waits for you')
    expect(selfUpdateStrip(busy)).toEqual({ to: null, line: 'update available · 0.36.0 · downloaded', link: true })
  })

  it('04 after the restart: who and when heads WHAT’S NEW, and Settings › Updates says it', () => {
    const receipt = { by: 'Pixel 8', at: 1, stopped: 2, version: v }
    expect(receiptLine(receipt, at1402)).toBe('Pixel 8 updated this Mac at 14:02. The 2 sessions running then were stopped.')
    expect(receiptLine({ ...receipt, stopped: 1 }, at1402)).toBe(
      'Pixel 8 updated this Mac at 14:02. The session running then was stopped.',
    )
    expect(receiptLine({ ...receipt, stopped: 0 }, at1402)).toBe('Pixel 8 updated this Mac at 14:02.')
    expect(line({ phase: 'none', receipt })).toBe('Up to date · updated from Pixel 8 at 14:02')
    expect(selfUpdateStrip({ phase: 'none', receipt })).toBeNull()
  })

  it('asked on this Mac, it says what it always did', () => {
    const own = { phase: 'downloading', version: v, percent: 41, totalMB: 92 } as const
    expect(updateNoticeContent(own)?.label).toBe('UPDATE · ORBITAL 0.36.0 · DOWNLOADING')
    expect(selfUpdateStrip(own)).toBeNull()
    expect(selfUpdateStrip({ phase: 'ready', version: v, workingCount: 3, buttons: 'two' })).toBeNull()
    expect(updateNoticeContent({ phase: 'restarting', version: v, remote: null })).toBeNull()
  })

  it('the map keeps what it showed into this Mac\'s own restart, but draws a member\'s last line', () => {
    let push: (state: UpdateState) => void = () => {}
    const bridge: UpdateBridge = {
      onUpdateState: (cb) => { push = cb },
      getUpdateState: () => new Promise(() => {}),
      updateAction: () => {},
      checkForUpdates: () => Promise.resolve({ kind: 'up-to-date' }),
    }
    useAppUpdate.setState({ source: null, state: null, shown: null })
    useAppUpdate.getState().connect(bridge)
    const ready = { phase: 'ready', version: v, workingCount: 0, buttons: 'one', checkedAt: null } as const
    push(ready)
    push({ phase: 'restarting', version: v, checkedAt: null })
    expect(useAppUpdate.getState().shown).toEqual(ready)
    push({ ...dl(2), checkedAt: null })
    push({ ...last(2), checkedAt: null })
    expect(useAppUpdate.getState().shown).toMatchObject({ phase: 'restarting', remote: { by: 'Pixel 8' } })
    useAppUpdate.setState({ source: null, state: null, shown: null })
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
