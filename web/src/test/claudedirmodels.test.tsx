import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { useClaudeDirModels } from '../lib/useClaudeDirModels'
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

describe('useClaudeDirModels', () => {
  beforeEach(() => {
    useOrbital.setState({ models: [row('fable', 'claude-fable-5-1')], contextWindows: {}, claudeDirs: [] })
  })

  // The store reads the catalog once when the window loads; models a CLI
  // update added since must show the next time the dialog opens.
  it('reads the default catalog again on every open', async () => {
    vi.mocked(api.listModels).mockResolvedValue({ models: [row('fable', 'claude-fable-5-2')], contextWindows: {} })
    const { result, rerender } = renderHook(({ open }) => useClaudeDirModels(null, open), {
      initialProps: { open: false },
    })
    expect(result.current[0].resolvedModel).toBe('claude-fable-5-1')
    expect(api.listModels).not.toHaveBeenCalled()

    rerender({ open: true })
    await waitFor(() => expect(result.current[0].resolvedModel).toBe('claude-fable-5-2'))

    vi.mocked(api.listModels).mockClear()
    rerender({ open: false })
    rerender({ open: true })
    expect(api.listModels).toHaveBeenCalledTimes(1)
  })
})
