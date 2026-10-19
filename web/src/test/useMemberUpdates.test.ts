import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ServerUpdateState } from '@orbital/shared/remote/serverUpdate'
import type { StartAnswer } from '../lib/memberUpdate'
import { UPDATE_READ_TIMEOUT_MS, useMemberUpdates, type UpdateIo } from '../lib/useMemberUpdates'

function state(patch: Partial<ServerUpdateState> = {}): ServerUpdateState {
  return {
    installed: '0.35.2', candidate: '0.36.0', packaged: true, updating: false, failed: null, sessions: 0, startedBy: null,
    ...patch,
  }
}

/** A promise and the hands that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// The store is shared across tests: each test uses its own member id.
let n = 0
const nextId = () => `member-${++n}`

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useMemberUpdates: pressing Update', () => {
  it('a start that never answers ends as unreachable after the bound, and frees every row', async () => {
    const id = nextId()
    const io: UpdateIo = {
      read: vi.fn(async () => state()),
      start: vi.fn(() => new Promise<StartAnswer | null>(() => {})),
    }
    // Not readable: nothing is read when the hook mounts, only by the press.
    const { result } = renderHook(() => useMemberUpdates([{ id, readable: false }], io))

    let pressed!: Promise<string>
    act(() => {
      pressed = result.current.press(id)
    })
    expect(result.current.starting).toBe(id)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_READ_TIMEOUT_MS)
    })
    await expect(pressed).resolves.toBe('unreachable')
    expect(io.start).toHaveBeenCalledTimes(1)
    expect(result.current.starting).toBeNull()
  })

  it('a double press runs one read and one start', async () => {
    const id = nextId()
    const read = deferred<ServerUpdateState>()
    const io: UpdateIo = {
      read: vi.fn(() => read.promise),
      start: vi.fn(async (): Promise<StartAnswer> => ({ ok: true, state: state({ updating: true }) })),
    }
    const { result } = renderHook(() => useMemberUpdates([{ id, readable: false }], io))

    let first!: Promise<string>
    let second!: Promise<string>
    act(() => {
      // Both before any render or await: the guard must hold without React's state.
      first = result.current.press(id)
      second = result.current.press(id)
    })
    await expect(second).resolves.toBe('none')
    await act(async () => {
      read.resolve(state())
      await first
    })
    await expect(first).resolves.toBe('started')
    expect(io.read).toHaveBeenCalledTimes(1)
    expect(io.start).toHaveBeenCalledTimes(1)
    expect(result.current.byId[id]?.watch).not.toBeNull()
  })

  it('a read asked before a start but answered after it does not undo the start', async () => {
    const id = nextId()
    const slow = deferred<ServerUpdateState>()
    const reads = [slow.promise]
    const io: UpdateIo = {
      // The first read (on mount) hangs; the press's own read answers at once.
      read: vi.fn(() => reads.shift() ?? Promise.resolve(state())),
      start: vi.fn(async (): Promise<StartAnswer> => ({ ok: true, state: state({ updating: true }) })),
    }
    const { result } = renderHook(() => useMemberUpdates([{ id, readable: true }], io))
    await act(async () => {
      await expect(result.current.press(id)).resolves.toBe('started')
    })
    expect(result.current.byId[id]?.watch).not.toBeNull()
    // The mount's read lands now, from before the start: not updating, the old version.
    await act(async () => {
      slow.resolve(state())
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.byId[id]?.watch).not.toBeNull()
    expect(result.current.byId[id]?.failed).toBeNull()
  })
})
