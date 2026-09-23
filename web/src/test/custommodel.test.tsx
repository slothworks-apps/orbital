import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ModelValidation } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api, ApiError } from '../lib/api'
import { useCustomModel } from '../lib/customModel'

const onValidated = vi.fn()
const onCleared = vi.fn()

function setup(initial?: { id: string; trusted: true }) {
  return renderHook(() => useCustomModel({ initial, onValidated, onCleared }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useCustomModel', () => {
  it('validates, reports the id, and does not probe the same text twice', async () => {
    vi.mocked(api.validateModel).mockResolvedValue({
      ok: true,
      model: 'claude-opus-4-6',
      resolvedModel: 'claude-opus-4-6-20260101',
      contextWindow: 200_000,
    })
    const { result } = setup()
    act(() => result.current.setText('  claude-opus-4-6 '))
    await act(() => result.current.validate())
    expect(api.validateModel).toHaveBeenCalledWith('claude-opus-4-6')
    expect(result.current.status).toBe('valid')
    expect(result.current.resolvedModel).toBe('claude-opus-4-6-20260101')
    expect(result.current.contextWindow).toBe(200_000)
    expect(onValidated).toHaveBeenCalledWith('claude-opus-4-6', {
      resolvedModel: 'claude-opus-4-6-20260101',
      contextWindow: 200_000,
    })
    // Enter followed by blur: one probe.
    await act(() => result.current.validate())
    expect(api.validateModel).toHaveBeenCalledTimes(1)
  })

  it('does not probe empty text', async () => {
    const { result } = setup()
    act(() => result.current.setText('   '))
    await act(() => result.current.validate())
    expect(api.validateModel).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('carries the server reason for a rejected id and clears the parent', async () => {
    const reason = "There's an issue with the selected model (claude-opus-nope)."
    vi.mocked(api.validateModel).mockResolvedValue({ ok: false, model: 'claude-opus-nope', reason })
    const { result } = setup()
    act(() => result.current.setText('claude-opus-nope'))
    onCleared.mockClear()
    await act(() => result.current.validate())
    expect(result.current.status).toBe('invalid')
    expect(result.current.reason).toBe(reason)
    expect(onCleared).toHaveBeenCalledTimes(1)
    expect(onValidated).not.toHaveBeenCalled()
  })

  it('returns to idle on typing and drops a result for text that is gone', async () => {
    let settle!: (v: ModelValidation) => void
    vi.mocked(api.validateModel).mockImplementation(() => new Promise((r) => (settle = r)))
    const { result } = setup()
    act(() => result.current.setText('claude-opus-4-6'))
    let pending!: Promise<void>
    act(() => {
      pending = result.current.validate()
    })
    expect(result.current.status).toBe('checking')
    act(() => result.current.setText('claude-opus-4-7'))
    expect(result.current.status).toBe('idle')
    await act(async () => {
      settle({ ok: true, model: 'claude-opus-4-6', resolvedModel: null, contextWindow: null })
      await pending
    })
    expect(result.current.status).toBe('idle')
    expect(onValidated).not.toHaveBeenCalled()
  })

  it('starts valid from a trusted id without probing it', async () => {
    const { result } = setup({ id: 'claude-opus-4-6', trusted: true })
    expect(result.current.text).toBe('claude-opus-4-6')
    expect(result.current.status).toBe('valid')
    await act(() => result.current.validate())
    expect(api.validateModel).not.toHaveBeenCalled()
  })

  it('lets the same id be retried after the request itself failed', async () => {
    vi.mocked(api.validateModel).mockRejectedValueOnce(
      new ApiError(JSON.stringify({ error: 'model id is too long' }), 400),
    )
    const { result } = setup()
    act(() => result.current.setText('claude-opus-4-6'))
    await act(() => result.current.validate())
    expect(result.current.status).toBe('invalid')
    expect(result.current.reason).toBe('model id is too long')
    vi.mocked(api.validateModel).mockResolvedValue({
      ok: true,
      model: 'claude-opus-4-6',
      resolvedModel: null,
      contextWindow: null,
    })
    await act(() => result.current.validate())
    expect(api.validateModel).toHaveBeenCalledTimes(2)
    expect(result.current.status).toBe('valid')
  })
})
