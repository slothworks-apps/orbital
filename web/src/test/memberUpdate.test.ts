import { describe, expect, it } from 'vitest'
import { UPDATE_TIMEOUT_MS, type ServerUpdateState } from '@orbital/shared/remote/serverUpdate'
import {
  applyCancel, applyRead, applyStart, applyStartUnanswered, confirmDecision, selfUpdateAvailable, startDecision, updateNeedsConfirm, updatePhase, updateRow, type MemberUpdate,
  type UpdateRowInput,
} from '../lib/memberUpdate'

const T0 = 1_000_000

function state(patch: Partial<ServerUpdateState> = {}): ServerUpdateState {
  return {
    installed: '0.35.2', candidate: '0.36.0', packaged: true, updating: false, failed: null, sessions: 0, startedBy: null,
    ...patch,
  }
}

const SERVER: UpdateRowInput = {
  name: 'nuc', kind: 'headless', online: true, words: 'online', helloVersion: '0.35.2', selfId: 'me', surface: 'desktop',
}

/** A member read once, then started from here. */
function started(by: { id: string; name: string } | null = { id: 'me', name: 'studio-mbp' }): MemberUpdate {
  const read = applyRead(undefined, state(), T0)
  return applyStart(read, { ok: true, state: state({ updating: true, startedBy: by }) }, T0).next
}

describe('updateRow: what a member row says about its update', () => {
  it('offers Update on an online member with a newer release, and only there', () => {
    const u = applyRead(undefined, state(), T0)
    const row = updateRow(u, SERVER)
    expect(row.phase).toBe('available')
    expect(row.line).toMatchObject({ text: 'update available · 0.36.0', sub: null, action: 'update', bright: true })
    expect(row.version).toBe('0.35.2')
    expect(row.words).toBe('online')

    // Offline: availability still shows, Update does not, and the line says when it will.
    const away = updateRow(u, { ...SERVER, online: false, words: 'offline · seen 2 h ago' })
    expect(away.line).toMatchObject({ action: null, sub: 'Update shows once nuc is online' })
  })

  it('on the phone, an asleep member says so in its state line and waits for it to wake', () => {
    const u = applyRead(undefined, state(), T0)
    const asleep = updateRow(u, { ...SERVER, online: false, words: 'asleep · seen 2 h ago', surface: 'phone' })
    expect(asleep.words).toBe('asleep · seen 2 h ago · update available')
    expect(asleep.line).toMatchObject({ action: null, sub: 'Update shows once nuc wakes' })
    const online = updateRow(u, { ...SERVER, surface: 'phone' })
    expect(online.words).toBe('online · update available · 0.36.0')
    expect(online.line?.head).toBe('Update available · 0.36.0')
  })

  it('a phone row shows its version and never an update', () => {
    const row = updateRow(applyRead(undefined, state(), T0), { ...SERVER, kind: 'phone', helloVersion: '0.2.0' })
    expect(row.line).toBeNull()
    expect(row.phase).toBe('idle')
  })

  it('a member read nowhere shows the version its hello named, and nothing else', () => {
    const row = updateRow(undefined, SERVER)
    expect(row).toMatchObject({ phase: 'idle', version: '0.35.2', line: null, dot: null, words: 'online' })
  })

  it('says nothing while it is current', () => {
    const row = updateRow(applyRead(undefined, state({ installed: '0.36.0' }), T0), SERVER)
    expect(row).toMatchObject({ phase: 'idle', version: '0.36.0', line: null })
  })
})

describe('an update from start to end', () => {
  it('installs while the member answers, and restarts once it does not — never reading offline', () => {
    const u = started()
    const installing = updateRow(u, SERVER)
    expect(installing).toMatchObject({
      phase: 'installing', words: 'updating', dot: 'linking', dim: false, version: '0.35.2 → 0.36.0',
    })
    expect(installing.line).toMatchObject({ text: 'installing 0.36.0 · apt', sub: null, action: null })
    expect(updateRow(u, { ...SERVER, kind: 'desktop' }).line?.text).toBe('installing 0.36.0 · its updater')

    const gone = applyRead(u, null, T0 + 5_000)
    const restarting = updateRow(gone, { ...SERVER, online: false, words: 'offline · seen 1 min ago' })
    expect(restarting).toMatchObject({ phase: 'restarting', words: 'updating', dot: 'linking', dim: false })
    expect(restarting.line?.text).toBe('restarting · offline until it’s back')
    expect(updateRow(gone, { ...SERVER, online: false, surface: 'phone' }).words).toBe('updating to 0.36.0')
  })

  it('names who started it only on members that did not', () => {
    expect(updateRow(started(), SERVER).line?.sub).toBeNull()
    expect(updateRow(started({ id: 'pixel', name: 'Pixel 8' }), SERVER).line?.sub).toBe('started on Pixel 8')
    // An update seen running, started elsewhere, is watched too, with its starter.
    const seen = applyRead(undefined, state({ updating: true, startedBy: { id: 'pixel', name: 'Pixel 8' } }), T0)
    expect(updatePhase(seen, true)).toBe('installing')
    expect(updateRow(seen, SERVER).line?.sub).toBe('started on Pixel 8')
  })

  it('ends when the member answers with the new version', () => {
    const back = applyRead(applyRead(started(), null, T0 + 5_000), state({ installed: '0.36.0' }), T0 + 60_000)
    expect(back.watch).toBeNull()
    expect(updateRow(back, SERVER)).toMatchObject({ phase: 'idle', version: '0.36.0', line: null })
  })

  it('fails when it comes back on the old version: where to look, and Try again once online', () => {
    const back = applyRead(started(), state({ failed: '0.36.0' }), T0 + 60_000)
    const row = updateRow(back, SERVER)
    expect(row.phase).toBe('failed')
    expect(row.line).toMatchObject({
      text: 'update didn’t finish · still on 0.35.2', sub: 'on nuc: journalctl -u orbital-update', action: 'retry',
    })
    expect(updateRow(back, { ...SERVER, kind: 'desktop' }).line?.sub).toBe('on nuc: Settings → Updates')
    expect(updateRow(back, { ...SERVER, online: false }).line?.action).toBeNull()
    expect(updateRow(back, { ...SERVER, surface: 'phone' }).words).toBe('online · update didn’t finish')
  })

  it('says the update waits on the Mac when a session started there, with no Try again, while it reads so', () => {
    const MAC = { ...SERVER, name: 'studio', kind: 'desktop' }
    const back = applyRead(started(), state({ failed: '0.36.0', failedReason: 'sessions' }), T0 + 30_000)
    const row = updateRow(back, MAC)
    expect(row).toMatchObject({ phase: 'failed', version: '0.35.2', words: 'online' })
    expect(row.line).toEqual({
      text: 'didn’t install · a session started working on studio', sub: 'it’s downloaded there · restart it on studio',
      bright: false, head: 'Didn’t install · a session started working on studio', action: null,
    })
    expect(updateRow(back, { ...MAC, surface: 'phone' }).words).toBe('online · update waits on studio')
    expect(updateRow(back, { ...MAC, surface: 'phone', online: false, words: 'asleep' }).words).toBe('asleep')
    // Read again later, the member still says so; a new start forgets it.
    const reread = applyRead(back, state({ failed: '0.36.0', failedReason: 'sessions' }), T0 + 60_000)
    expect(updateRow(reread, MAC).line?.text).toBe('didn’t install · a session started working on studio')
    const again = applyStart(reread, { ok: true, state: state({ updating: true }) }, T0 + 70_000).next
    expect(again.failedReason).toBeNull()
  })

  it('says so when the Mac could not check for its sessions, with Try again; keeps where to look for no reason it knows', () => {
    const MAC = { ...SERVER, name: 'studio', kind: 'desktop' }
    const unknown = applyRead(started(), state({ failed: '0.36.0', failedReason: 'unknown' }), T0 + 30_000)
    expect(updateRow(unknown, MAC).line).toEqual({
      text: 'couldn’t check for sessions on studio', sub: 'nothing was started', bright: false,
      head: 'Couldn’t check for sessions on studio', action: 'retry',
    })
    // The phone row reads as update available, as before it was asked.
    expect(updateRow(unknown, { ...MAC, surface: 'phone' }).words).toBe('online · update available · 0.36.0')
    expect(updateRow(unknown, { ...MAC, online: false }).line?.action).toBeNull()
    expect(startDecision(unknown, true)).toBe('start')
    const plain = applyRead(started(), state({ failed: '0.36.0', failedReason: null }), T0 + 30_000)
    expect(updateRow(plain, MAC).line?.sub).toBe('on studio: Settings → Updates')
  })

  it('fails on the old version even when the member does not say so itself', () => {
    const back = applyRead(started(), state(), T0 + 60_000)
    expect(updatePhase(back, true)).toBe('failed')
  })

  it("times out when it is not back within the wait, then answers for itself once it is", () => {
    let u = applyRead(started(), null, T0 + 5_000)
    u = applyRead(u, null, T0 + UPDATE_TIMEOUT_MS)
    const row = updateRow(u, { ...SERVER, online: false })
    expect(row).toMatchObject({ phase: 'timeout', words: 'offline', dot: 'offline', dim: true })
    expect(row.line).toMatchObject({ text: 'didn’t come back after the update', action: null })
    expect(updateRow(u, { ...SERVER, online: false, surface: 'phone' }).words).toBe('offline · since the update')

    // Back on the old version: the member's own failed state, with Try again.
    const old = applyRead(u, state({ failed: '0.36.0' }), T0 + UPDATE_TIMEOUT_MS + 60_000)
    expect(updateRow(old, SERVER).line?.action).toBe('retry')
    // Back on the new one: the line goes.
    const done = applyRead(u, state({ installed: '0.36.0' }), T0 + UPDATE_TIMEOUT_MS + 60_000)
    expect(updateRow(done, SERVER).phase).toBe('idle')
  })
})

describe('an update when sessions finish', () => {
  const PIXEL = { id: 'px', name: 'Pixel 8' }
  const waiting = (n: number, by = PIXEL) => state({ updating: true, sessions: n, waiting: { sessions: n }, startedBy: by })

  it('reads as waiting on every member, with the live count, who started it, and Cancel', () => {
    const u = applyRead(undefined, waiting(2), T0)
    const row = updateRow(u, SERVER)
    expect(row).toMatchObject({ phase: 'waiting', version: '0.35.2', words: 'online', dot: null, dim: null })
    expect(row.line).toEqual({
      text: 'waiting for 2 sessions to finish · then 0.36.0', sub: 'started on Pixel 8', bright: false,
      head: 'Waiting for 2 sessions to finish · then 0.36.0', action: 'cancel',
    })
    expect(updateRow(u, { ...SERVER, surface: 'phone' }).words).toBe('online · waiting for 2 sessions')
    const one = applyRead(u, waiting(1), T0 + 5_000)
    expect(updateRow(one, SERVER).line?.text).toBe('waiting for 1 session to finish · then 0.36.0')
    // Started here: not named.
    expect(updateRow(applyRead(undefined, waiting(1, { id: 'me', name: 'studio' }), T0), SERVER).line?.sub).toBeNull()
    // Nothing more to start meanwhile.
    expect(startDecision(u, true)).toBe('none')
  })

  it('never times out while it waits; ends in the install as any update does', () => {
    let u = applyRead(undefined, waiting(2), T0)
    u = applyRead(u, waiting(2), T0 + UPDATE_TIMEOUT_MS * 3)
    expect(updatePhase(u, true)).toBe('waiting')
    // The install began: the timeout counts from the last read that said it waited.
    u = applyRead(u, state({ updating: true }), T0 + UPDATE_TIMEOUT_MS * 3 + 5_000)
    expect(updatePhase(u, true)).toBe('installing')
    u = applyRead(u, null, T0 + UPDATE_TIMEOUT_MS * 3 + 10_000)
    expect(updatePhase(u, false)).toBe('restarting')
    expect(updatePhase(applyRead(u, null, T0 + UPDATE_TIMEOUT_MS * 4 + 5_000), false)).toBe('timeout')
  })

  it('a waiting member that stops answering reads as restarting, its wait most likely ended', () => {
    const u = applyRead(applyRead(undefined, waiting(1), T0), null, T0 + 5_000)
    expect(updatePhase(u, true)).toBe('restarting')
  })

  it('cancelled — here, on another member, or dropped by a restart — goes back to update available, not failed', () => {
    const u = applyRead(undefined, waiting(2), T0)
    const elsewhere = applyRead(u, state({ sessions: 2 }), T0 + 5_000)
    expect(elsewhere).toMatchObject({ watch: null, failed: null, timedOut: null })
    expect(updateRow(elsewhere, SERVER).phase).toBe('available')

    const here = applyCancel(u, { ok: true, state: state({ sessions: 2 }) })
    expect(here).toEqual({ next: expect.objectContaining({ watch: null, failed: null }), reread: false })
    expect(updateRow(here.next, SERVER).phase).toBe('available')
    expect(applyCancel(u, { ok: false, error: 'not_waiting' })).toEqual({ next: u, reread: true })

    // A member that says it failed did fail.
    const failed = applyRead(u, state({ failed: '0.36.0' }), T0 + 5_000)
    expect(updateRow(failed, SERVER).phase).toBe('failed')
  })

  it('a wait started here is watched as waiting from its own answer', () => {
    const read = applyRead(undefined, state({ sessions: 2 }), T0)
    const next = applyStart(read, { ok: true, state: waiting(2) }, T0).next
    expect(next.watch).toMatchObject({ waited: true })
    expect(updatePhase(next, true)).toBe('waiting')
  })
})

describe('starting an update', () => {
  it('asks first only with sessions running there', () => {
    expect(updateNeedsConfirm(applyRead(undefined, state({ sessions: 0 }), T0))).toBe(false)
    expect(updateNeedsConfirm(applyRead(undefined, state({ sessions: 3 }), T0))).toBe(true)
    expect(updateNeedsConfirm(undefined)).toBe(false)
  })

  it('decides on the fresh read: its sessions now, nothing when it cannot be read or is no longer offered', () => {
    // Read with no sessions earlier; the fresh read says three run now.
    expect(startDecision(applyRead(undefined, state({ sessions: 3 }), T0), true)).toBe('confirm')
    expect(startDecision(applyRead(undefined, state({ sessions: 0 }), T0), true)).toBe('start')
    expect(startDecision(null, true)).toBe('unreachable')
    expect(startDecision(applyRead(applyRead(undefined, state(), T0), null, T0), false)).toBe('unreachable')
    // Someone else started it meanwhile, or it is current now: the row says so, nothing starts.
    expect(startDecision(applyRead(undefined, state({ updating: true }), T0), true)).toBe('none')
    expect(startDecision(applyRead(undefined, state({ installed: '0.36.0' }), T0), true)).toBe('none')
    // Try again after a failure decides the same way.
    expect(startDecision(applyRead(undefined, state({ failed: '0.36.0', sessions: 1 }), T0), true)).toBe('confirm')
  })

  it('reads again on a refusal a read shows, and keeps the two it does not', () => {
    const u = applyRead(undefined, state(), T0)
    expect(applyStart(u, { ok: false, error: 'updating' }, T0).reread).toBe(true)
    expect(applyStart(u, { ok: false, error: 'no_update' }, T0).reread).toBe(true)
    const refused = applyStart(u, { ok: false, error: 'not_set_up' }, T0)
    expect(refused.reread).toBe(false)
    expect(updateRow(refused.next, SERVER).line).toMatchObject({
      action: 'update', sub: 'not set up for updates · on nuc: orbital setup',
    })
    // The next start forgets it.
    expect(applyStart(refused.next, { ok: false, error: 'updating' }, T0).next.refused).toBeNull()
  })
})

describe("the confirm's Update", () => {
  const read = (sessions: number) => applyRead(undefined, state({ sessions }), T0)

  it('starts with as many sessions as it named, or fewer', () => {
    expect(confirmDecision(2, read(2), true)).toBe('start')
    expect(confirmDecision(2, read(0), true)).toBe('start')
  })

  it('asks again when more run there now than it named', () => {
    expect(confirmDecision(1, read(3), true)).toBe('confirm')
  })

  it('does nothing it cannot read, or no longer offered', () => {
    expect(confirmDecision(1, null, true)).toBe('unreachable')
    expect(confirmDecision(1, applyRead(undefined, state({ updating: true, sessions: 4 }), T0), true)).toBe('none')
  })
})

describe('a start that was not answered', () => {
  it('watches without showing updating, and shows it once a read says so', () => {
    const u = applyStartUnanswered(applyRead(undefined, state(), T0), T0)
    expect(u.watch).toMatchObject({ unconfirmed: true })
    expect(updatePhase(u, true)).toBe('available')
    // Not reachable meanwhile: still watched, so the poll goes on.
    const away = applyRead(u, null, T0 + 5_000)
    expect(away.watch).not.toBeNull()
    expect(updatePhase(away, true)).toBe('available')
    const landed = applyRead(away, state({ updating: true }), T0 + 10_000)
    expect(landed.watch?.unconfirmed).toBeUndefined()
    expect(updatePhase(landed, true)).toBe('installing')
  })

  it('a read that says it is not updating ends the watch and fails nothing', () => {
    const u = applyStartUnanswered(applyRead(undefined, state(), T0), T0)
    const read = applyRead(u, state(), T0 + 5_000)
    expect(read.watch).toBeNull()
    expect(read.failed).toBeNull()
    expect(updatePhase(read, true)).toBe('available')
  })

  it('stops being watched when the wait runs out with no answer, without reading as timed out', () => {
    const u = applyStartUnanswered(applyRead(undefined, state(), T0), T0)
    const late = applyRead(u, null, T0 + UPDATE_TIMEOUT_MS)
    expect(late.watch).toBeNull()
    expect(late.timedOut).toBeNull()
  })

  it('leaves a member never read, or already watched, as it is', () => {
    expect(applyStartUnanswered(undefined, T0).watch).toBeNull()
    const watched = started()
    expect(applyStartUnanswered(watched, T0 + 1)).toBe(watched)
  })
})

describe('selfUpdateAvailable', () => {
  it("is this Mac's newer release, and nothing while it is current or already updating", () => {
    expect(selfUpdateAvailable(applyRead(undefined, state(), T0))).toBe('0.36.0')
    expect(selfUpdateAvailable(applyRead(undefined, state({ installed: '0.36.0' }), T0))).toBeNull()
    expect(selfUpdateAvailable(applyRead(undefined, state({ updating: true }), T0))).toBeNull()
    expect(selfUpdateAvailable(undefined)).toBeNull()
  })
})
