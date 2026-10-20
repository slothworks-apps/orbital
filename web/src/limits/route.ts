/**
 * `/limits` — the plan's usage windows (spec 2026-10-03-usage-limits-design
 * § 2; canvas `Feature - Plan limits` 31a). A real path, branched on in
 * `main.tsx` the way `/stats` is, for the same reasons.
 *
 * `/limits/<account key>` is the same page opened from that account's sun
 * (spec 2026-10-20-limit-suns-design § 4; canvas 60c): scrolled to the
 * account, its head lit for a moment.
 */
export const LIMITS_PATH = '/limits'

/** The page opened at one account (`limitsAccountKey`). */
export function limitsPathFor(accountKey: string): string {
  return `${LIMITS_PATH}/${encodeURIComponent(accountKey)}`
}

/** The limits page and the account it opens at, or null for any other path; a trailing slash still is. */
export function parseLimitsRoute(pathname: string): { account: string | null } | null {
  const path = pathname.replace(/\/+$/, '')
  if (path === LIMITS_PATH) return { account: null }
  const rest = path.startsWith(`${LIMITS_PATH}/`) ? path.slice(LIMITS_PATH.length + 1) : null
  if (!rest || rest.includes('/')) return null
  try {
    return { account: decodeURIComponent(rest) }
  } catch {
    return null
  }
}

/** Whether a pathname is the limits page. */
export function isLimitsRoute(pathname: string): boolean {
  return parseLimitsRoute(pathname) !== null
}
