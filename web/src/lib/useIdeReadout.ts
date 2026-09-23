import { useEffect, useRef, useState } from 'react'
import { isAttachable, selectionId } from './ideSelection'
import type { IdeSelection } from './types'

/**
 * The composer slot's two rates (spec: 2026-09-23-ide-bridge-design § The slot
 * and the lip — "Two rates, because there are two problems").
 *
 * The server already coalesces the flood — 92 notifications in one second were
 * measured — but one publish stream cannot serve both halves of the slot. The
 * cursor line wants to KEEP UP, so arrowing down a file reads as a number
 * counting rather than a number strobing. The lip wants to WAIT, so a
 * drag-select does not flash "1 line" before it settles on five. One interval
 * cannot be both.
 */

/**
 * How often the cursor line is allowed to rewrite itself — canvas
 * `Feature - IDE bridge` 20f, "cursor moves": the file and line rewrite in
 * place, with no transition, throttled so arrowing through a file does not
 * strobe.
 */
export const IDE_CURSOR_THROTTLE_HZ = 4

/** Derived, so the two can never drift apart. */
export const IDE_CURSOR_THROTTLE_MS = Math.round(1000 / IDE_CURSOR_THROTTLE_HZ)

/**
 * How long the lip waits after the FIRST change of a burst before it shows what
 * the burst ended on (canvas 20f, "selection grows").
 *
 * Deliberately the same shape as the server's coalescer: the timer starts on
 * the first change and is NOT extended by the rest, so a drag that never lets
 * go still raises a lip — what it raises is wherever the drag had reached.
 */
export const IDE_SELECTION_DEBOUNCE_MS = 250

export interface IdeReadout {
  /** Where the caret is, throttled. Null when there is no editor. */
  cursor: IdeSelection | null
  /**
   * The selection the lip stands over, debounced, or null when the caret
   * merely moved. Never an empty selection — an empty `text` is the same fact
   * as an absent one.
   */
  lip: IdeSelection | null
}

/**
 * Runs the incoming selection through both rates.
 *
 * `selection` is whatever the session shape last carried; passing null (no
 * editor, an editor on another project, a socket that dropped) clears both
 * halves at once and immediately — a slot that is going away should not linger
 * for a debounce window it can no longer be told to leave.
 */
export function useIdeReadout(selection: IdeSelection | null): IdeReadout {
  const [cursor, setCursor] = useState<IdeSelection | null>(selection)
  const [lip, setLip] = useState<IdeSelection | null>(() =>
    isAttachable(selection) ? selection : null,
  )

  /** The latest input, for whichever timer fires next. */
  const latest = useRef<IdeSelection | null>(selection)
  const cursorAt = useRef(0)
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The keys, not the objects: every republish of the session rebuilds the
  // selection, and its identity means nothing.
  const key = selection ? selectionId(selection) : null
  const lipKey = isAttachable(selection) ? key : null

  useEffect(() => {
    latest.current = selection

    // No editor. Both halves drop now, and every pending timer with them.
    if (selection === null) {
      if (cursorTimer.current !== null) clearTimeout(cursorTimer.current)
      if (lipTimer.current !== null) clearTimeout(lipTimer.current)
      cursorTimer.current = null
      lipTimer.current = null
      cursorAt.current = 0
      setCursor(null)
      setLip(null)
      return
    }

    // The cursor line: leading edge, then at most one rewrite per window, and
    // a trailing one so the last position of a burst is never the one missed.
    const since = Date.now() - cursorAt.current
    if (since >= IDE_CURSOR_THROTTLE_MS) {
      cursorAt.current = Date.now()
      setCursor(selection)
    } else if (cursorTimer.current === null) {
      cursorTimer.current = setTimeout(() => {
        cursorTimer.current = null
        cursorAt.current = Date.now()
        setCursor(latest.current)
      }, IDE_CURSOR_THROTTLE_MS - since)
    }

    // The lip: one window per burst, publishing whatever the burst ended on —
    // including a null, which is how the lip sinks back to the cursor line
    // when the selection is released.
    if (lipTimer.current === null) {
      lipTimer.current = setTimeout(() => {
        lipTimer.current = null
        const now = latest.current
        setLip(isAttachable(now) ? now : null)
      }, IDE_SELECTION_DEBOUNCE_MS)
    }
    // `key`/`lipKey` stand in for `selection`, whose identity changes on every
    // republish; `lipKey` is in the list so releasing a selection re-arms the
    // window even when the caret has not moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, lipKey])

  // Unmounting mid-burst must not leave a timer holding a setState.
  useEffect(
    () => () => {
      if (cursorTimer.current !== null) clearTimeout(cursorTimer.current)
      if (lipTimer.current !== null) clearTimeout(lipTimer.current)
    },
    [],
  )

  return { cursor, lip }
}
