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

/** A window's frame, or a display's work area, in screen points. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `session-window-subagent` as main reads it: the subagent panel opened or
 * closed inside a detached window (spec:
 * 2026-09-23-detached-session-windows-design § The subagent panel in the
 * window). The renderer owns the panel widths, so it says how much room the
 * panel wants (`widthPx`) and how wide the window must be to hold both
 * panels at their minimums without growing (`pairMinPx`).
 */
export type SubagentPanelMessage =
  | { open: true; widthPx: number; pairMinPx: number }
  | { open: false };

/**
 * Main's answer to a `session-window-subagent` message: the width the window
 * will have once its resize lands (spec: 2026-09-24-subagent-list-design § 4).
 */
export interface SubagentPanelAnswer {
  widthPx: number;
}

function isWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The payload as it arrives over IPC. Whatever it carries ends up in
 * `setBounds`, so a width that is not a positive finite number drops the
 * whole message rather than being coerced.
 */
export function parseSubagentPanelMessage(payload: unknown): SubagentPanelMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { open, widthPx, pairMinPx } = payload as Record<string, unknown>;
  if (open === false) return { open: false };
  if (open !== true || !isWidth(widthPx) || !isWidth(pairMinPx)) return null;
  return { open: true, widthPx, pairMinPx };
}

/** What a grow did, kept per window so the close can undo exactly that. */
export interface SubagentGrowth {
  /** The frame before the grow. */
  before: Bounds;
  /** The frame the grow set. */
  after: Bounds;
}

/**
 * The frame a detached window takes when its subagent panel opens, or null
 * when it stays as it is.
 *
 * It stays when it already holds both panels at their minimums. Otherwise it
 * widens to the right by the panel's width; if that would leave the work area
 * on the right it shifts left to stay inside, and it is never wider than the
 * work area. A shift stops at the work area's left edge, and a window that
 * does not need to shift keeps its x even if it sits partly off screen.
 */
export function growForSubagent(
  bounds: Bounds,
  workArea: Bounds,
  widthPx: number,
  pairMinPx: number,
): SubagentGrowth | null {
  if (bounds.width >= pairMinPx) return null;
  const width = Math.min(bounds.width + widthPx, workArea.width);
  if (width <= bounds.width) return null;
  const right = workArea.x + workArea.width;
  const x = bounds.x + width > right ? Math.max(workArea.x, right - width) : bounds.x;
  return { before: bounds, after: { ...bounds, x, width } };
}

/**
 * The frame a detached window takes when its subagent panel closes, or null
 * when it is left alone.
 *
 * It narrows by exactly what the grow added and moves back by whatever the
 * grow shifted it, never below `minWidth`. A window whose width is no longer
 * the one the grow set was resized by hand while the agent was open, and the
 * user's size wins. Height and y stay as they are now, and a move made in the
 * meantime is kept: the shift is undone relative to where the window sits.
 */
export function shrinkAfterSubagent(
  current: Bounds,
  growth: SubagentGrowth,
  minWidth: number,
): Bounds | null {
  if (current.width !== growth.after.width) return null;
  const width = Math.max(minWidth, current.width - (growth.after.width - growth.before.width));
  const x = current.x + (growth.before.x - growth.after.x);
  return { ...current, x, width };
}
