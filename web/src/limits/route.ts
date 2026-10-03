/**
 * `/limits` — the plan's usage windows (spec 2026-10-03-usage-limits-design
 * § 2; canvas `Feature - Plan limits` 31a). A real path, branched on in
 * `main.tsx` the way `/stats` is, for the same reasons.
 */
export const LIMITS_PATH = '/limits'

/** Whether a pathname is the limits page; a trailing slash still is. */
export function isLimitsRoute(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === LIMITS_PATH
}
