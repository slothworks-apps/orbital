import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api, ApiError } from '../lib/api'
import { DEFAULT_HARNESS_OPTIONS, type HarnessTemplate, type LaunchHarnessTemplates } from '../lib/types'
import { useHarnessChoice } from '../mobile/screens/NewSessionHarness'

// Spec 2026-11-09-harness-from-new-session-design § Phone: the harness screen's template list.

const template = (id: number): HarnessTemplate => ({
  id,
  name: `T${id}`,
  description: '',
  tags: [],
  inputs: [{ key: 'task', label: 'Task link' }],
  steps: [],
  options: DEFAULT_HARNESS_OPTIONS,
  scope: { kind: 'global' },
  draft: false,
  createdAt: 0,
  updatedAt: 0,
})

const offer = (lastUsedId: number | null = 1): LaunchHarnessTemplates => ({
  project: null,
  templates: [template(1), template(2)],
  lastUsedId,
})

const list = () => vi.mocked(api.listHarnessTemplatesForLaunch)

function render(initial: { cwd: string; active: boolean }) {
  return renderHook(({ cwd, active }) => useHarnessChoice(cwd, null, active), { initialProps: initial })
}

beforeEach(() => {
  list().mockReset()
})

describe('useHarnessChoice', () => {
  it('reads again when the screen reopens after ‹ left a read unanswered', async () => {
    let answer!: (data: LaunchHarnessTemplates) => void
    list().mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const hook = render({ cwd: '/w/a', active: true })
    hook.rerender({ cwd: '/w/a', active: false })
    // The abandoned read answers after ‹; nothing takes it.
    await act(async () => answer(offer()))
    expect(hook.result.current.data).toBeNull()

    list().mockResolvedValueOnce(offer())
    hook.rerender({ cwd: '/w/a', active: true })
    await waitFor(() => expect(hook.result.current.data).not.toBeNull())
    expect(list()).toHaveBeenCalledTimes(2)
  })

  it('reads again after a failed read, on reopening and on retry', async () => {
    list().mockRejectedValueOnce(new ApiError('{"error":"boom"}', 500))
    const hook = render({ cwd: '/w/a', active: true })
    await waitFor(() => expect(hook.result.current.error).toBe('boom'))
    expect(hook.result.current.off).toBe(false)

    list().mockRejectedValueOnce(new ApiError('{"error":"again"}', 500))
    hook.rerender({ cwd: '/w/a', active: false })
    hook.rerender({ cwd: '/w/a', active: true })
    await waitFor(() => expect(hook.result.current.error).toBe('again'))

    list().mockResolvedValueOnce(offer())
    act(() => hook.result.current.retry())
    await waitFor(() => expect(hook.result.current.data).not.toBeNull())
    expect(hook.result.current.error).toBeNull()
    expect(list()).toHaveBeenCalledTimes(3)
  })

  it('keeps an answered list across ‹ and back', async () => {
    list().mockResolvedValueOnce(offer())
    const hook = render({ cwd: '/w/a', active: true })
    await waitFor(() => expect(hook.result.current.template?.id).toBe(1))
    hook.rerender({ cwd: '/w/a', active: false })
    hook.rerender({ cwd: '/w/a', active: true })
    expect(hook.result.current.template?.id).toBe(1)
    expect(list()).toHaveBeenCalledTimes(1)
  })

  it('says Harness is off when the device answers harness_disabled, not as an error', async () => {
    list().mockRejectedValueOnce(new ApiError('{"error":"harness_disabled"}', 403))
    const hook = render({ cwd: '/w/a', active: true })
    await waitFor(() => expect(hook.result.current.off).toBe(true))
    expect(hook.result.current.error).toBeNull()
    expect(hook.result.current.launch).toBeNull()
  })

  it('keeps inputs per template, and drops them with a change of directory', async () => {
    list().mockResolvedValue(offer())
    const hook = render({ cwd: '/w/a', active: true })
    await waitFor(() => expect(hook.result.current.template?.id).toBe(1))
    act(() => hook.result.current.setInput('task', 'A-1'))
    expect(hook.result.current.launch?.inputs).toEqual({ task: 'A-1' })

    // Another template's input of the same key starts empty, and the first keeps its own.
    act(() => hook.result.current.pick(2))
    expect(hook.result.current.inputs).toEqual({})
    act(() => hook.result.current.pick(1))
    expect(hook.result.current.inputs).toEqual({ task: 'A-1' })

    hook.rerender({ cwd: '/w/b', active: true })
    await waitFor(() => expect(hook.result.current.template?.id).toBe(1))
    expect(hook.result.current.inputs).toEqual({})
    expect(hook.result.current.launch).toBeNull()
  })
})
