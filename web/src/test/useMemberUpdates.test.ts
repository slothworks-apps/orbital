import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { UPDATE_POLL_MS, type ServerUpdateState } from '@orbital/shared/remote/serverUpdate'
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

  it('a start that never answers still watches the member, so the next poll shows it updating', async () => {
    const id = nextId()
    let updating = false
    const io: UpdateIo = {
      read: vi.fn(async () => state({ updating })),
      start: vi.fn(() => new Promise<StartAnswer | null>(() => {})),
    }
    const { result } = renderHook(() => useMemberUpdates([{ id, readable: true }], io))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    let pressed!: Promise<string>
    act(() => {
      pressed = result.current.press(id)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_READ_TIMEOUT_MS)
    })
    await expect(pressed).resolves.toBe('unreachable')
    expect(result.current.byId[id]?.watch).toMatchObject({ unconfirmed: true })
    // The start landed after all: the next poll reads it updating.
    updating = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS)
    })
    expect(result.current.byId[id]?.watch).not.toBeNull()
    expect(result.current.byId[id]?.watch?.unconfirmed).toBeUndefined()
  })

  it("the confirm's Update asks again, without starting, when more sessions run there than it named", async () => {
    const id = nextId()
    const reads = [state({ sessions: 1 }), state({ sessions: 3 }), state({ sessions: 3 })]
    const io: UpdateIo = {
      read: vi.fn(async () => reads.shift() ?? state({ sessions: 3 })),
      start: vi.fn(async (): Promise<StartAnswer> => ({ ok: true, state: state({ updating: true, sessions: 3 }) })),
    }
    const { result } = renderHook(() => useMemberUpdates([{ id, readable: false }], io))
    await act(async () => {
      await expect(result.current.press(id)).resolves.toBe('confirm')
    })
    // The confirm named 1; there are 3 now.
    await act(async () => {
      await expect(result.current.start(id)).resolves.toBe('confirm')
    })
    expect(io.start).not.toHaveBeenCalled()
    expect(result.current.byId[id]?.state?.sessions).toBe(3)
    // Confirmed again for 3: it starts.
    await act(async () => {
      await expect(result.current.start(id)).resolves.toBe('started')
    })
    expect(io.start).toHaveBeenCalledTimes(1)
  })

  it("the confirm's Update overtaken by a newer read decides on that one, not on nothing", async () => {
    const id = nextId()
    const slow = deferred<ServerUpdateState>()
    const reads: Array<Promise<ServerUpdateState>> = [
      Promise.resolve(state({ sessions: 1 })), slow.promise, Promise.resolve(state({ sessions: 3 })),
    ]
    const io: UpdateIo = {
      read: vi.fn(() => reads.shift() ?? Promise.resolve(state({ sessions: 3 }))),
      start: vi.fn(async (): Promise<StartAnswer> => ({ ok: true, state: state({ updating: true }) })),
    }
    const { result, rerender } = renderHook(({ readable }) => useMemberUpdates([{ id, readable }], io), {
      initialProps: { readable: false },
    })
    await act(async () => {
      await expect(result.current.press(id)).resolves.toBe('confirm')
    })
    let confirmed!: Promise<string>
    act(() => {
      confirmed = result.current.start(id)
    })
    // The member comes online meanwhile: its read is asked after the confirm's, and lands first.
    await act(async () => {
      rerender({ readable: true })
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      slow.resolve(state({ sessions: 1 }))
      await vi.advanceTimersByTimeAsync(0)
    })
    await expect(confirmed).resolves.toBe('confirm')
    expect(io.start).not.toHaveBeenCalled()
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
