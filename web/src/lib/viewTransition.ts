import { flushSync } from 'react-dom'

/**
 * Runs a state change inside a view transition, so the DOM the change
 * produces animates from the DOM it replaced instead of appearing in place.
 *
 * Orbital uses this for the one move a user makes and then looks for: pinning
 * a session sends its sidebar row from ACTIVE (or HISTORY) up into PINNED, and
 * unpinning sends it back. React re-renders both lists in the same commit, so
 * without a transition the row is simply gone from one place and present in
 * another — the reader has to re-find it.
 *
 * `flushSync` is what makes the callback worth anything: `startViewTransition`
 * snapshots the page, calls back, and diffs against the DOM as it stands when
 * the callback returns. A React `set` only schedules work, so without the
 * flush the callback returns before anything has changed and the browser
 * animates a frame against itself. Flushing synchronously is safe here because
 * every caller is an event handler — never a render, a layout effect, or a
 * `useEffect` body, where React warns and defers.
 *
 * Two ways out, both landing on a plain synchronous `apply()`:
 *
 * - no `startViewTransition` — Firefox at the time of writing, and jsdom,
 *   which is why the test suite exercises this path without knowing it;
 * - `prefers-reduced-motion: reduce` — a row sliding across the rail is
 *   exactly the kind of large positional travel that setting asks us to drop.
 *   `theme.css` disables the row animation under the same query, but the
 *   media query there only silences the animation, while this skips the whole
 *   snapshot-and-diff machinery.
 */
export function withViewTransition(apply: () => void): void {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  if (reduced || typeof document.startViewTransition !== 'function') {
    apply()
    return
  }
  document.startViewTransition(() => flushSync(apply))
}

/**
 * A session's `view-transition-name`. The browser pairs an old snapshot with a
 * new one by this name, so it has to be stable across the re-render and unique
 * within the document — two rows sharing a name makes the transition abort and
 * log.
 *
 * Session ids are v4 UUIDs when Orbital starts them, but an attached terminal
 * session brings whatever id its transcript carries, and a `view-transition-name`
 * has to be a CSS custom ident: letters, digits, hyphens, underscores and
 * escapes only, and not starting with a digit. So every character outside that
 * set is escaped as `_<hex codepoint>_` rather than dropped or replaced by a
 * fixed character — a lossy mapping would let two different sessions collide
 * on one name, and a collision is the one failure mode that matters here. The
 * underscore is escaped along with the rest, which keeps the encoding
 * unambiguous: an underscore in the output can only be an escape delimiter.
 *
 * The prefix does double duty: it namespaces the name against any other
 * transition on the page, and it keeps a numeric id from starting the ident.
 */
export function sessionViewTransitionName(id: string): string {
  let name = 'orbital-session-'
  for (const char of id) {
    name += /[A-Za-z0-9-]/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`
  }
  return name
}
