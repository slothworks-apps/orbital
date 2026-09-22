/**
 * `/stats` and `/stats/session/<id>` — real paths, branched on
 * `window.location.pathname` in `main.tsx` exactly the way `/sandbox` is (and
 * for the same reason: vite's SPA fallback already rewrites unknown paths to
 * `index.html`, so a refresh on either survives).
 *
 * The parser lives here rather than in `main.tsx` so the two screens share one
 * definition of what a stats URL is — `main.tsx` only has to ask whether the
 * path is one, and the page decides which of the two it is.
 */

export const STATS_PATH = '/stats'

export type StatsRoute = { kind: 'dashboard' } | { kind: 'session'; id: string }

/**
 * The stats route a pathname names, or null when it names none.
 *
 * A `/stats/…` path that matches no known shape resolves to the dashboard
 * rather than to null: the app has one screen per branch and no 404 page, so
 * a mistyped stats URL should land on the stats the user was after.
 */
export function parseStatsRoute(pathname: string): StatsRoute | null {
  if (pathname !== STATS_PATH && !pathname.startsWith(`${STATS_PATH}/`)) return null

  const rest = pathname.slice(STATS_PATH.length).replace(/^\/+|\/+$/g, '')
  if (rest === '') return { kind: 'dashboard' }

  const segments = rest.split('/')
  if (segments.length === 2 && segments[0] === 'session' && segments[1] !== '') {
    return { kind: 'session', id: decodeURIComponent(segments[1]) }
  }
  return { kind: 'dashboard' }
}

/**
 * Which turn the drilldown opens on, as the uuid of its transcript entry
 * (10e "click finding": the offending turn is pre-highlighted). In the URL so
 * the highlight survives a reload and can be linked to from anywhere.
 */
export const TURN_PARAM = 'turn'

/**
 * The drilldown's path for one session — what a finding card navigates to,
 * carrying the turn the finding blames when it names one.
 */
export function sessionStatsPath(id: string, turnUuid?: string | null): string {
  const path = `${STATS_PATH}/session/${encodeURIComponent(id)}`
  return turnUuid ? `${path}?${TURN_PARAM}=${encodeURIComponent(turnUuid)}` : path
}

export function readTurnParam(href: string = window.location.href): string | null {
  const turn = new URL(href).searchParams.get(TURN_PARAM)
  return turn && turn.length > 0 ? turn : null
}
