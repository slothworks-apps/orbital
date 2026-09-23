/**
 * Detached session windows: a session's detail panel in a window of its own
 * (spec: 2026-09-23-detached-session-windows-design).
 *
 * Main owns the `sessionId → window` map (ADR:
 * the-main-process-owns-the-detached-windows); these are the decisions it
 * makes about it. Nothing here may import electron
 * (spec 2026-09-16-electron-wrapper-design § 4 "Testing").
 */

/**
 * An id as it arrives over IPC. The renderer is ours, but whatever it sends
 * ends up in a URL path and a map key, so anything that is not a non-empty
 * string is dropped rather than coerced.
 */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * The payload of `detached-changed` as the preload reads it: the ids that are
 * strings, and nothing else. A malformed message costs the renderer its
 * redirects, never a throw inside its store.
 */
export function parseDetachedIds(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(isSessionId);
}

/**
 * The URL a session's window loads: the `/session/<id>` route on the same
 * origin the main window was sent to, whichever one startup chose.
 *
 * Only the origin is kept — the main window's own path and query are the
 * map's, not the session's. The id is encoded as one path segment, so an id
 * carrying `/`, `?` or `#` cannot turn into another route.
 */
export function sessionWindowUrl(windowTargetUrl: string, sessionId: string): string {
  const origin = new URL(windowTargetUrl).origin;
  return `${origin}/session/${encodeURIComponent(sessionId)}`;
}

export type DetachDecision =
  | 'open' // no window for this session yet
  | 'focus'; // it already has one: at most one window per session

export function decideDetach(sessionId: string, detached: { has(id: string): boolean }): DetachDecision {
  return detached.has(sessionId) ? 'focus' : 'open';
}

export type NotificationClickTarget =
  | { kind: 'session-window'; sessionId: string } // focus its window, select nothing
  | { kind: 'main'; select: string | null }; // show the map, and select the session if there is one

/**
 * Where a clicked notification lands. Decided at click time, not when the
 * notification was shown: the session may have been detached, or its window
 * closed, in between.
 *
 * A detached session is not shown in the docked panel, so selecting it in the
 * main window would be wrong — its own window is where it lives.
 */
export function decideNotificationClick(
  sessionId: string | null | undefined,
  detached: { has(id: string): boolean },
): NotificationClickTarget {
  if (sessionId && detached.has(sessionId)) return { kind: 'session-window', sessionId };
  return { kind: 'main', select: sessionId || null };
}
