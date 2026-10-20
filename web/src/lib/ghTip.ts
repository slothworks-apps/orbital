import type { GhAvailability } from './types'

/**
 * The one-time `gh` tip, as decisions (spec 2026-10-20-report-to-github-design
 * § Telling people about `gh`, canvas `Feature - Feedback` 61e).
 */

/** Settings key: absent until the tip ends, then `GH_TIP_DONE` for good. */
export const GH_TIP_KEY = 'gh_tip'
export const GH_TIP_DONE = 'done'

/** What ends the tip: × or Install. */
export const END_GH_TIP_PATCH: Record<string, string> = { [GH_TIP_KEY]: GH_TIP_DONE }

/** `GET /api/gh-status`. `brew` is absent from a Mac older than this feature. */
export interface GhStatusAnswer {
  status: GhAvailability
  brew?: boolean
}

/**
 * Whether a Mac without Homebrew can run Install. An older Mac does not say,
 * and is taken to have it — the line it shows is the one it showed before.
 */
export const hasBrew = (answer: GhStatusAnswer): boolean => answer.brew !== false

/**
 * Offered while it has not ended and `gh` is not installed — not when it is
 * only logged out: the tip is about what installing it adds. Not without
 * Homebrew either, since Install is `brew install gh` and the tip has no other
 * way to offer; such a Mac still learns it in Settings, where the PR switch
 * names cli.github.com. Nothing is decided before both the server's settings
 * and its answer about `gh` are in.
 */
export function shouldOfferGhTip(
  settings: Record<string, string | undefined>,
  settingsLoaded: boolean,
  gh: GhStatusAnswer | null,
): boolean {
  if (!settingsLoaded || settings[GH_TIP_KEY] === GH_TIP_DONE) return false
  if (gh === null || gh.status !== 'missing') return false
  return hasBrew(gh)
}
