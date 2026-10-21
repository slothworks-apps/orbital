/**
 * What a `needs_input` session wants from the human, read off what the server
 * publishes for it. One predicate for the map's NEEDS INPUT / DONE split and
 * for the notifications that say the same (ADRs
 * what-a-session-waits-for-is-a-label, a-finished-turn-is-done-not-needs-input),
 * so the planet's ring and what the user is told cannot disagree.
 *
 * Typed on the two fields alone and on `unknown`, so both the web's
 * `ApiSession` and an upsert straight off the wire fit.
 */

/** The fields a session is judged on; anything else it carries is ignored. */
export type ParkedSession = { pendingDecision?: unknown; harnessGate?: unknown; loginWait?: unknown };

/**
 * A harness gate waits for the user's OK (spec 2026-10-02-harness-redesign-design
 * § 2, canvas 30a-d / 30i): the session is NEEDS INPUT, worded NEEDS YOUR OK,
 * with a steady dot — a gate can wait all night. A gate the reviewer is
 * reading is not: the reviewer is quiet, and the session keeps its own state.
 */
export function gateWaits(session: Pick<ParkedSession, 'harnessGate'>): boolean {
  return session.harnessGate === 'waiting';
}

/**
 * The session stopped on its profile's lost login, and no login of it runs
 * yet (spec 2026-10-21-log-in-from-orbital-design § 3): the human's to
 * restore. While the login runs it waits on the browser, not on them.
 */
export function loginLost(session: Pick<ParkedSession, 'loginWait'>): boolean {
  const wait = session.loginWait as { running?: unknown } | null | undefined;
  return Boolean(wait && typeof wait === 'object' && wait.running !== true);
}

/**
 * Whether a parked session is actually blocked on the human: a decision
 * parked on them (a permission request or an `AskUserQuestion`), a harness
 * gate waiting for their OK, or a lost login. A session that is none of
 * these merely finished its turn.
 */
export function asksForHuman(session: ParkedSession): boolean {
  return Boolean(session.pendingDecision) || gateWaits(session) || loginLost(session);
}
