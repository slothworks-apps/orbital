import { withSessionParam } from '../lib/sessionUrl'

/**
 * `/walkthrough/<sessionId>` — the walkthrough page (spec:
 * 2026-09-23-walkthrough-design § The page). A real path, branched on in
 * `main.tsx` the way `/stats` and `/session/<id>` are; vite's SPA fallback
 * and the server's static route both serve `index.html` for it.
 */
export const WALKTHROUGH_PATH = '/walkthrough'

export function parseWalkthroughRoute(pathname: string): string | null {
  if (!pathname.startsWith(`${WALKTHROUGH_PATH}/`)) return null
  const rest = pathname.slice(WALKTHROUGH_PATH.length + 1).replace(/\/$/, '')
  if (rest === '' || rest.includes('/')) return null
  try {
    const id = decodeURIComponent(rest)
    return id === '' ? null : id
  } catch {
    return null
  }
}

export function walkthroughPath(id: string): string {
  return `${WALKTHROUGH_PATH}/${encodeURIComponent(id)}`
}

/**
 * The map with this session's detail panel open: where the page bar's session
 * crumb and the close screen's "Open the transcript" go. Lives here rather
 * than in `WalkthroughPage` so the screens and the bar's crumbs
 * (`lib/pageCrumbs`) can link to it without importing the page.
 */
export function mapHref(id: string): string {
  return withSessionParam(id, `${window.location.origin}/`)
}
