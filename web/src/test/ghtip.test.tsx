import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { GH_TIP_DONE, GH_TIP_KEY, shouldOfferGhTip } from '../lib/ghTip'
import { ghLineVariant } from '../panels/GhLine'
import { useGhTip } from '../panels/GhTip'
import { useMapNotices } from '../store/mapNotices'
import { useOrbital } from '../store/store'

// Spec 2026-10-20-report-to-github-design § Telling people about gh, canvas
// `Feature - Feedback` 61c, 61e, 61g.

describe('the gh line under the PR switch', () => {
  it('names the command for what is wrong, and runs it in Orbital', () => {
    expect(ghLineVariant('missing', true)).toMatchObject({ kind: 'run', reason: 'gh is not installed', run: 'install-gh' })
    expect(ghLineVariant('logged_out', true)).toMatchObject({ kind: 'run', reason: 'gh is not logged in', run: 'login-gh' })
  })

  it('without Homebrew points at cli.github.com instead of a command that cannot run', () => {
    expect(ghLineVariant('missing', false)).toMatchObject({ kind: 'link', reason: 'gh is not installed · no Homebrew' })
    // Logging in needs no Homebrew.
    expect(ghLineVariant('logged_out', false)).toMatchObject({ kind: 'run', run: 'login-gh' })
  })

  it('an older Mac that does not say whether Homebrew is there gets the install command, as before', () => {
    expect(ghLineVariant('missing', undefined)).toMatchObject({ kind: 'run', run: 'install-gh' })
  })

  it('says nothing while gh works or before the server answered', () => {
    expect(ghLineVariant('ready', true)).toBeNull()
    expect(ghLineVariant(null, undefined)).toBeNull()
  })
})

describe('shouldOfferGhTip', () => {
  const missing = { status: 'missing' as const, brew: true }

  it('is offered only while gh is not installed, Homebrew is there and the tip has not ended', () => {
    expect(shouldOfferGhTip({}, true, missing)).toBe(true)
    expect(shouldOfferGhTip({}, true, { status: 'missing' })).toBe(true)
    expect(shouldOfferGhTip({}, true, { status: 'logged_out', brew: true })).toBe(false)
    expect(shouldOfferGhTip({}, true, { status: 'ready', brew: true })).toBe(false)
    expect(shouldOfferGhTip({}, true, { status: 'missing', brew: false })).toBe(false)
    expect(shouldOfferGhTip({ [GH_TIP_KEY]: GH_TIP_DONE }, true, missing)).toBe(false)
  })

  it('decides nothing before the settings and the answer about gh are in', () => {
    // An absent key only means "not ended" once the server's rows are in.
    expect(shouldOfferGhTip({}, false, missing)).toBe(false)
    expect(shouldOfferGhTip({}, true, null)).toBe(false)
  })
})

describe('useGhTip', () => {
  const ids = () => useMapNotices.getState().queue.map((e) => e.id)
  const focus = async () => {
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
  }

  beforeEach(() => {
    vi.mocked(api.ghStatus).mockReset()
    useMapNotices.setState({ queue: [] })
    useOrbital.setState({ settings: {}, settingsLoaded: true })
  })

  it('queues the tip on a launch where gh is not installed', async () => {
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'missing', brew: true })
    renderHook(() => useGhTip())
    await act(async () => {})
    expect(ids()).toEqual(['gh-tip'])
  })

  it('never queues it again once it ended, and does not even ask', async () => {
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'missing', brew: true })
    useOrbital.setState({ settings: { [GH_TIP_KEY]: GH_TIP_DONE } })
    renderHook(() => useGhTip())
    await act(async () => {})
    expect(ids()).toEqual([])
    expect(api.ghStatus).not.toHaveBeenCalled()
  })

  it('waits for the server settings before deciding', async () => {
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'missing', brew: true })
    useOrbital.setState({ settingsLoaded: false })
    renderHook(() => useGhTip())
    await act(async () => {})
    expect(ids()).toEqual([])
    // The rows land and say it ended on an earlier launch.
    await act(async () => {
      useOrbital.setState({ settings: { [GH_TIP_KEY]: GH_TIP_DONE }, settingsLoaded: true })
    })
    expect(ids()).toEqual([])
  })

  it('is dropped unseen when gh appears before it showed', async () => {
    // Something ranked ahead of a tip holds the slot, so the tip waits.
    useMapNotices.getState().push({ id: 'app-update', kind: 'update', Body: () => null })
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'missing', brew: true })
    renderHook(() => useGhTip())
    await act(async () => {})
    expect(ids()).toEqual(['app-update', 'gh-tip'])

    // gh installed in a terminal meanwhile; the window comes back.
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'logged_out', brew: true })
    await focus()
    expect(ids()).toEqual(['app-update'])
  })

  it('once showing, stays until it is ended by × or Install', async () => {
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'missing', brew: true })
    renderHook(() => useGhTip())
    await act(async () => {})
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'ready', brew: true })
    await focus()
    expect(ids()).toEqual(['gh-tip'])
  })
})
