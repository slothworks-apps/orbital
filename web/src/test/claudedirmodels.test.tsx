import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { useClaudeDirCatalog, useClaudeDirModels } from '../lib/useClaudeDirModels'
import type { OrbitalModel } from '../lib/types'
import { useOrbital } from '../store/store'

const row = (value: string, resolvedModel: string): OrbitalModel => ({
  value,
  resolvedModel,
  family: value,
  version: value,
  shortVersion: value,
  variant: null,
  blurb: '',
  contextWindow: null,
})

describe('useClaudeDirCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOrbital.setState({ models: [row('fable', 'claude-fable-5-1')], contextWindows: {}, recentModels: [], claudeDirs: [], defaultClaudeDir: null })
  })

  // The store reads the catalog once when the window loads; models a CLI
  // update added since must show the next time the dialog opens.
  it('reads the default catalog again on every open where a model is chosen', async () => {
    vi.mocked(api.listModels).mockResolvedValue({ models: [row('fable', 'claude-fable-5-2')], contextWindows: {}, recentModels: [] })
    const { result, rerender } = renderHook(
      ({ open }) => useClaudeDirCatalog(null, open, undefined, { refresh: true }).models,
      { initialProps: { open: false } },
    )
    expect(result.current[0].resolvedModel).toBe('claude-fable-5-1')
    expect(api.listModels).not.toHaveBeenCalled()

    rerender({ open: true })
    await waitFor(() => expect(result.current[0].resolvedModel).toBe('claude-fable-5-2'))

    vi.mocked(api.listModels).mockClear()
    rerender({ open: false })
    rerender({ open: true })
    expect(api.listModels).toHaveBeenCalledTimes(1)
  })

  // The detail panel's and the phone's model switchers: the store's catalog
  // answers for the default directory, and another one is read once.
  it('reads nothing for the default directory without refresh, and another directory once', async () => {
    vi.mocked(api.listModels).mockResolvedValue({ models: [row('opus', 'claude-opus-5')], contextWindows: {}, recentModels: [] })
    useOrbital.setState({ claudeDirs: [{ id: 1, name: 'Work' }, { id: 2, name: 'Home' }] as never, defaultClaudeDir: 1 })
    const { result, rerender } = renderHook(({ dir }) => useClaudeDirModels(dir, true), { initialProps: { dir: 1 } })
    rerender({ dir: 1 })
    expect(api.listModels).not.toHaveBeenCalled()
    expect(result.current[0].value).toBe('fable')

    rerender({ dir: 2 })
    await waitFor(() => expect(result.current[0].value).toBe('opus'))
    rerender({ dir: 2 })
    expect(api.listModels).toHaveBeenCalledTimes(1)
  })

  // The map rebuilds from the store's catalog: an answer equal to it must not replace it.
  it('leaves the store alone when the fresh catalog is the one it holds', async () => {
    const held = useOrbital.getState().models
    vi.mocked(api.listModels).mockResolvedValue({ models: [row('fable', 'claude-fable-5-1')], contextWindows: {}, recentModels: [] })
    renderHook(() => useClaudeDirCatalog(null, true, undefined, { refresh: true }))
    await waitFor(() => expect(api.listModels).toHaveBeenCalled())
    await Promise.resolve()
    expect(useOrbital.getState().models).toBe(held)
  })
})
