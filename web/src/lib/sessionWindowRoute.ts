/**
 * `/session/<id>` — a detached session window (spec:
 * 2026-09-23-detached-session-windows-design). A real path, branched on in
 * `main.tsx` the way `/stats` is, and for the same reason: vite's SPA
 * fallback and the server's both serve `index.html` for it, so a reload of
 * the window survives.
 */

export const SESSION_WINDOW_PATH = '/session'

/**
 * The session id a pathname names, or null when it is not a session window.
 *
 * Stricter than `parseStatsRoute`: that one falls back to the dashboard on a
 * shape it does not know, but a session window has nothing sensible to show
 * for a malformed id, so anything but exactly one non-empty segment is not
 * this route. A trailing slash is tolerated.
 */
export function parseSessionWindowRoute(pathname: string): string | null {
  if (!pathname.startsWith(`${SESSION_WINDOW_PATH}/`)) return null

  const rest = pathname.slice(SESSION_WINDOW_PATH.length + 1).replace(/\/$/, '')
  if (rest === '' || rest.includes('/')) return null

  try {
    const id = decodeURIComponent(rest)
    return id === '' ? null : id
  } catch {
    // A malformed escape (`%E0%A4%A`) names no session.
    return null
  }
}
