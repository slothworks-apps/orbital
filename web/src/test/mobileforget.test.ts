import { beforeEach, describe, expect, it, vi } from 'vitest'

// Every platform write stubbed: these tests are about what the app does in
// order, never about Capacitor storage. `vi.mock` is hoisted, so the fakes
// are built with `vi.hoisted`.
const io = vi.hoisted(() => {
  const calls: string[] = []
  const step = (name: string) => vi.fn(async () => {
    calls.push(name)
  })
  return {
    calls,
    writeSessionsCache: step('writeSessions'),
    writeTranscriptCache: step('writeTranscript'),
    clearCaches: step('clearCaches'),
    forgetIdentity: step('forgetIdentity'),
    clearImageCache: step('clearImageCache'),
    clearPairing: step('clearPairing'),
    setUnpaired: step('setUnpaired'),
  }
})
vi.mock('../mobile/platform/cache', () => ({
  writeSessionsCache: io.writeSessionsCache, writeTranscriptCache: io.writeTranscriptCache, clearCaches: io.clearCaches,
}))
vi.mock('../mobile/platform/identity', () => ({ forgetIdentity: io.forgetIdentity }))
vi.mock('../mobile/platform/imageCache', () => ({ clearImageCache: io.clearImageCache }))
vi.mock('../mobile/platform/pairing', () => ({ clearPairing: io.clearPairing, setUnpaired: io.setUnpaired }))
vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import type { ApiSession } from '../lib/types'
import { cancelCacheWrite, persist, wireCache } from '../mobile/cacheWriter'
import { CACHE_WRITE_DEBOUNCE_MS } from '../mobile/constants'
import { forgetEverything } from '../mobile/forget'
import type { Pairing } from '../mobile/platform/parse'
import { initialMobileState, useMobile } from '../mobile/state'
import { useOrbital } from '../store/store'

const PAIRING: Pairing = { relay: 'https://relay.test', mac: 'm1', macName: 'studio', fingerprint: 'f', pairedAt: 1 }

function session(id: string): ApiSession {
  return {
    id, cwd: `/w/${id}`, title: id, firstAt: 1, lastAt: 1, messageCount: 1, source: 'web', permissionMode: null,
    model: null, resolvedModel: null, tagIds: [], status: 'idle', subagents: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  io.calls.length = 0
  cancelCacheWrite()
  useMobile.setState({ ...initialMobileState })
  useOrbital.getState().seatSessions([session('s1')], [])
  useOrbital.setState((s) => ({
    transcripts: { s1: [] }, historyLoaded: { s1: true }, ui: { ...s.ui, selectedId: 's1' },
  }))
})

describe('persist', () => {
  it('writes while the pair is live, and nothing once it is gone or the tunnel is down', async () => {
    useMobile.setState({ pairing: PAIRING, ready: true })
    await persist()
    expect(io.writeSessionsCache).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    useMobile.setState({ pairing: null, ready: true })
    await persist()
    useMobile.setState({ pairing: PAIRING, ready: false })
    await persist()
    expect(io.writeSessionsCache).not.toHaveBeenCalled()
    expect(io.writeTranscriptCache).not.toHaveBeenCalled()
  })
})

describe('forgetEverything', () => {
  it('drops a cache write still waiting, so the old Mac is not written back after the clear', async () => {
    vi.useFakeTimers()
    const unwire = wireCache()
    try {
      useMobile.setState({ pairing: PAIRING, ready: true })
      useOrbital.getState().seatSessions([session('s2')], [])
      await forgetEverything({ unpaired: false })
      // Even a pairing that came straight back would find no write pending.
      useMobile.setState({ pairing: PAIRING, ready: true })
      await vi.advanceTimersByTimeAsync(CACHE_WRITE_DEBOUNCE_MS * 2)
      expect(io.writeSessionsCache).not.toHaveBeenCalled()
    } finally {
      unwire()
      vi.useRealTimers()
    }
  })

  it("leaves no selection or transcript of the old Mac's in the store", async () => {
    useMobile.setState({ pairing: PAIRING })
    await forgetEverything({ unpaired: true })
    const state = useOrbital.getState()
    expect(state.ui.selectedId).toBeNull()
    expect(state.transcripts).toEqual({})
    expect(state.historyLoaded).toEqual({})
    expect(state.sessions).toEqual({})
    expect(useMobile.getState()).toMatchObject({ screen: 'unpaired', unpaired: true, pairing: null, macName: 'studio' })
  })

  it('writes the unpaired flag before the pairing goes, so a kill in between still lands on 9h', async () => {
    useMobile.setState({ pairing: PAIRING })
    await forgetEverything({ unpaired: true })
    expect(io.calls.indexOf('setUnpaired')).toBeLessThan(io.calls.indexOf('clearPairing'))
    expect(io.calls.indexOf('clearPairing')).toBeLessThan(io.calls.indexOf('clearCaches'))
  })

  it('goes to the scanner without the flag when the user chose to forget', async () => {
    useMobile.setState({ pairing: PAIRING })
    await forgetEverything({ unpaired: false })
    expect(io.setUnpaired).not.toHaveBeenCalled()
    expect(useMobile.getState()).toMatchObject({ screen: 'pairing', unpaired: false, macName: null })
  })
})
