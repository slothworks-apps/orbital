import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A bare file name pressed in a code span (spec
 * 2026-11-02-bare-file-names-and-path-menu-design § The bare name): the
 * server looks it up, one match opens, several open a chooser, none says so
 * in the same popup. What the answer means and how long the press waits for
 * it live here; the popups draw it (`PathMenu`, the phone's sheet).
 */

/** One file `GET /api/files/find` found: `path` absolute, `relative` to the tree it was found in. */
export interface FoundFile {
  path: string
  relative: string
  /** The session's transcripts name its absolute path — it worked on this one. */
  touched: boolean
}

export interface FindFilesAnswer {
  matches: FoundFile[]
  /** Matches past the ones the server listed. */
  more: number
}

/** How long a press shows nothing but its pressed pill (canvas `Feature - Path menu glyphs` 1e, "300 ms + · STILL WAITING"). */
export const FIND_PENDING_MS = 300
/** How long a press waits before the chooser opens anyway, saying no answer came (1e, "4 s · NO ANSWER"). */
export const FIND_GIVE_UP_MS = 4000
/**
 * The rows the chooser shows before its `+N more` row is picked (1c CAPPED,
 * the canvas's acceptance), and the rows its full list scrolls by.
 */
export const CHOOSER_ROWS = 6

/** What a bare name's chooser shows, when the answer is not one file to open. */
export type NameChoice =
  | { kind: 'matches'; name: string; matches: FoundFile[]; more: number }
  /** Nothing by that name under `under`, the session's directory as the user knows it (`web/`). */
  | { kind: 'none'; name: string; under: string }
  /** No answer within `FIND_GIVE_UP_MS` from `device`. */
  | { kind: 'silent'; name: string; device: string }

/**
 * The rows a chooser draws for `choice.matches`, in the server's order (it
 * sorts them: spec § What a press does), and the count its last row says.
 * Capped at `CHOOSER_ROWS`, the last row counts every match left out and
 * `expands`: picking it shows them `all`. In full, it is only the server's
 * own `more` — the matches past the ones it listed — and nothing to pick.
 */
export function shownMatches(
  choice: Extract<NameChoice, { kind: 'matches' }>,
  all: boolean,
): { rows: FoundFile[]; more: number; expands: boolean } {
  const rows = all ? choice.matches : choice.matches.slice(0, CHOOSER_ROWS)
  const hidden = choice.matches.length - rows.length
  return { rows, more: hidden + choice.more, expands: hidden > 0 }
}

/** The total a chooser's caption counts: what was listed and what was not. */
export function matchCount(choice: Extract<NameChoice, { kind: 'matches' }>): number {
  return choice.matches.length + choice.more
}

/** A relative path cut where the chooser dims it: the folder, then the name in full ink (1c). */
export function splitDir(relative: string): { dir: string; name: string } {
  const cut = relative.lastIndexOf('/') + 1
  return { dir: relative.slice(0, cut), name: relative.slice(cut) }
}

/** The server's word that what was asked is not a bare name: nothing can be called that (`GET /api/files/find`'s 400). */
export const NOT_A_NAME = 'not-a-name'

/** What the lookup's answer comes to: a file to open, a chooser, or no answer worth acting on. */
export type FindOutcome =
  | { kind: 'open'; file: FoundFile }
  | { kind: 'choose'; choice: NameChoice }
  /** Not served (a Mac older than the route): open the name as written instead. */
  | { kind: 'as-written' }

/**
 * The answer to a press, read (spec § What a press does): one match opens,
 * none or several open the chooser, and so does a name the server would not
 * take (no file can be called that); a Mac without the route falls back to
 * the name as written, and no answer at all says so.
 */
export function outcomeOf(
  answer: FindFilesAnswer | typeof NOT_A_NAME | null | typeof GAVE_UP,
  name: string,
  facts: { under: string; device: string },
): FindOutcome {
  if (answer === GAVE_UP) return { kind: 'choose', choice: { kind: 'silent', name, device: facts.device } }
  if (answer === null) return { kind: 'as-written' }
  if (answer === NOT_A_NAME) return { kind: 'choose', choice: { kind: 'none', name, under: facts.under } }
  if (answer.matches.length === 1 && answer.more === 0) return { kind: 'open', file: answer.matches[0] }
  if (answer.matches.length === 0) return { kind: 'choose', choice: { kind: 'none', name, under: facts.under } }
  return { kind: 'choose', choice: { kind: 'matches', name, matches: answer.matches, more: answer.more } }
}

/** A wait that ran out: `usePendingPress` hands it over in place of an answer. */
export const GAVE_UP = Symbol('gave-up')

/** Where a press that waits stands: nothing yet, the pressed pill alone, or the pill and the ellipsis. */
export type PendingPhase = 'idle' | 'pending' | 'slow'

/**
 * A press that waits for the server (canvas 1e): `pending` from the press,
 * `slow` once `FIND_PENDING_MS` has passed, and `GAVE_UP` handed to `done`
 * at `FIND_GIVE_UP_MS`. A press anywhere outside `element` while it waits
 * drops it silently, as does the next `run` and the component unmounting; a
 * dropped wait never calls `done`.
 */
export function usePendingPress(): {
  phase: PendingPhase
  run<T>(element: Element | null, task: () => Promise<T>, done: (result: T | typeof GAVE_UP) => void): void
  cancel(): void
} {
  const [phase, setPhase] = useState<PendingPhase>('idle')
  const generation = useRef(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const element = useRef<Element | null>(null)

  const clear = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer)
    timers.current = []
  }, [])

  const cancel = useCallback(() => {
    generation.current += 1
    clear()
    element.current = null
    setPhase('idle')
  }, [clear])

  const run = useCallback(
    <T,>(from: Element | null, task: () => Promise<T>, done: (result: T | typeof GAVE_UP) => void) => {
      clear()
      const mine = ++generation.current
      element.current = from
      setPhase('pending')
      const finish = (result: T | typeof GAVE_UP) => {
        if (generation.current !== mine) return
        generation.current += 1
        clear()
        element.current = null
        setPhase('idle')
        done(result)
      }
      timers.current.push(
        setTimeout(() => {
          if (generation.current === mine) setPhase('slow')
        }, FIND_PENDING_MS),
        setTimeout(() => finish(GAVE_UP), FIND_GIVE_UP_MS),
      )
      void task().then(finish, () => finish(GAVE_UP))
    },
    [clear],
  )

  useEffect(() => {
    if (phase === 'idle') return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && element.current?.contains(target)) return
      cancel()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [phase, cancel])

  useEffect(
    () => () => {
      generation.current += 1
      for (const timer of timers.current) clearTimeout(timer)
    },
    [],
  )

  return { phase, run, cancel }
}
