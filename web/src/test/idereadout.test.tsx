import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  IDE_CURSOR_THROTTLE_MS,
  IDE_SELECTION_DEBOUNCE_MS,
  useIdeReadout,
} from '../lib/useIdeReadout'
import type { IdeSelection } from '../lib/types'

/**
 * The slot's two rates (spec: 2026-09-23-ide-bridge-design § The slot and the
 * lip — "Two rates, because there are two problems").
 *
 * Worth testing because the whole point is that the two halves DISAGREE: one
 * keeps up and the other waits, and a single interval serving both is exactly
 * the regression this can catch.
 */

function caret(line: number): IdeSelection {
  return { filePath: '/w/x/a.ts', lineStart: line, lineCount: 1, text: null }
}

function range(line: number, count: number, text: string): IdeSelection {
  return { filePath: '/w/x/a.ts', lineStart: line, lineCount: count, text }
}

/** Widens the hook's prop to the nullable it really takes, without an assertion. */
function props(s: IdeSelection | null): { s: IdeSelection | null } {
  return { s }
}

describe('useIdeReadout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the first caret at once and rewrites at most once per window', () => {
    const { result, rerender } = renderHook(({ s }: { s: IdeSelection | null }) => useIdeReadout(s), {
      initialProps: props(caret(10)),
    })
    expect(result.current.cursor?.lineStart).toBe(10)

    // Arrowing down: several inputs inside one window.
    act(() => {
      rerender({ s: caret(11) })
      rerender({ s: caret(12) })
      rerender({ s: caret(13) })
    })
    // Still on the leading edge's value — the window has not elapsed.
    expect(result.current.cursor?.lineStart).toBe(10)

    act(() => {
      vi.advanceTimersByTime(IDE_CURSOR_THROTTLE_MS)
    })
    // The trailing edge publishes where the burst ended, not where it began.
    expect(result.current.cursor?.lineStart).toBe(13)
  })

  it('keeps up across windows rather than waiting for quiet', () => {
    const { result, rerender } = renderHook(({ s }: { s: IdeSelection | null }) => useIdeReadout(s), {
      initialProps: props(caret(1)),
    })
    for (let line = 2; line <= 6; line++) {
      act(() => {
        rerender({ s: caret(line) })
        vi.advanceTimersByTime(IDE_CURSOR_THROTTLE_MS)
      })
    }
    expect(result.current.cursor?.lineStart).toBe(6)
  })

  it('never raises a lip over a caret', () => {
    const { result } = renderHook(() => useIdeReadout(caret(10)))
    act(() => {
      vi.advanceTimersByTime(IDE_SELECTION_DEBOUNCE_MS * 2)
    })
    expect(result.current.lip).toBeNull()
  })

  it('does not flash the first reading of a drag before it settles', () => {
    const { result, rerender } = renderHook(({ s }: { s: IdeSelection | null }) => useIdeReadout(s), {
      initialProps: props(caret(10)),
    })

    // A drag: one line, then two, then five, all well inside the window.
    act(() => {
      rerender({ s: range(10, 1, 'a') })
      vi.advanceTimersByTime(IDE_SELECTION_DEBOUNCE_MS / 4)
      rerender({ s: range(10, 2, 'ab') })
      vi.advanceTimersByTime(IDE_SELECTION_DEBOUNCE_MS / 4)
      rerender({ s: range(10, 5, 'abcde') })
    })
    expect(result.current.lip).toBeNull()

    act(() => {
      vi.advanceTimersByTime(IDE_SELECTION_DEBOUNCE_MS)
    })
    expect(result.current.lip?.lineCount).toBe(5)
  })

  it('publishes a drag that never lets go, at wherever it had reached', () => {
    const { result, rerender } = renderHook(({ s }: { s: IdeSelection | null }) => useIdeReadout(s), {
      initialProps: props(null),
    })
    // Never a quiet moment: the window must not be extendable by more input,
    // the way the server's coalescer is not.
    for (let n = 1; n <= 20; n++) {
      act(() => {
        rerender({ s: range(10, n, 'x'.repeat(n)) })
        vi.advanceTimersByTime(IDE_SELECTION_DEBOUNCE_MS / 10)
      })
    }
    expect(result.current.lip).not.toBeNull()
    expect(result.current.lip!.lineCount).toBeGreaterThan(1)
  })

  it('sinks the lip when the selection is released, on the same window', () => {
    const { result, rerender } = renderHook(({ s }: { s: IdeSelection | null }) => useIdeReadout(s), {
      initialProps: props(range(10, 5, 'abcde')),
    })
    act(() => {
      vi.advanceTimersByTime(IDE_SELECTION_DEBOUNCE_MS)
    })
    expect(result.current.lip?.lineCount).toBe(5)

    act(() => {
      rerender({ s: caret(12) })
    })
    expect(result.current.lip).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(IDE_SELECTION_DEBOUNCE_MS)
    })
    expect(result.current.lip).toBeNull()
  })

  it('clears both halves at once when the editor goes, with no window to wait out', () => {
    const { result, rerender } = renderHook(({ s }: { s: IdeSelection | null }) => useIdeReadout(s), {
      initialProps: props(range(10, 5, 'abcde')),
    })
    act(() => {
      vi.advanceTimersByTime(IDE_SELECTION_DEBOUNCE_MS)
    })
    act(() => {
      rerender({ s: null })
    })
    expect(result.current.cursor).toBeNull()
    expect(result.current.lip).toBeNull()
  })

  it('treats an empty text exactly as an absent one', () => {
    const { result } = renderHook(() =>
      useIdeReadout({ filePath: '/w/x/a.ts', lineStart: 3, lineCount: 1, text: '' }),
    )
    act(() => {
      vi.advanceTimersByTime(IDE_SELECTION_DEBOUNCE_MS * 2)
    })
    expect(result.current.lip).toBeNull()
    expect(result.current.cursor?.lineStart).toBe(3)
  })

  it('leaves no timer behind when it unmounts mid-burst', () => {
    const { rerender, unmount } = renderHook(
      ({ s }: { s: IdeSelection | null }) => useIdeReadout(s),
      { initialProps: props(caret(1)) },
    )
    act(() => {
      rerender({ s: range(1, 3, 'abc') })
    })
    unmount()
    // A timer still holding a setState would warn or throw here.
    expect(() => vi.advanceTimersByTime(IDE_SELECTION_DEBOUNCE_MS * 3)).not.toThrow()
  })
})
