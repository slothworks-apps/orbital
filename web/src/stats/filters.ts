import type { StatsWindow } from '../lib/types'

/**
 * The dashboard's three filters live in the URL query (canvas 10a, spec §Web
 * UI), so a filtered view survives a reload and can be pasted to someone
 * else. Parsing and printing are pure functions over a query string — the
 * page holds them in state and mirrors them with `history.replaceState`.
 */

/** Offered in this order by the window toggle (10a). */
export const STATS_WINDOWS: readonly StatsWindow[] = ['24h', '7d', '30d', 'all']

export interface StatsFilters {
  window: StatsWindow
  /** `sessions.projectDir`, or null for every project. */
  project: string | null
  /** `sessions.resolvedModel`, or null for every model. */
  model: string | null
}

/** The window 10a is drawn in, and the one the endpoint itself defaults to. */
export const DEFAULT_STATS_FILTERS: StatsFilters = { window: '7d', project: null, model: null }

const WINDOW_PARAM = 'window'
const PROJECT_PARAM = 'project'
const MODEL_PARAM = 'model'

function isStatsWindow(value: string | null): value is StatsWindow {
  return value !== null && (STATS_WINDOWS as readonly string[]).includes(value)
}

/**
 * A URL query as filters. Anything the overview endpoint would refuse — an
 * unknown window, an empty project — is dropped rather than carried into a
 * request that would 400.
 */
export function readStatsFilters(search: string = window.location.search): StatsFilters {
  const params = new URLSearchParams(search)
  const windowValue = params.get(WINDOW_PARAM)
  return {
    window: isStatsWindow(windowValue) ? windowValue : DEFAULT_STATS_FILTERS.window,
    project: params.get(PROJECT_PARAM) || null,
    model: params.get(MODEL_PARAM) || null,
  }
}

/**
 * Filters as a query string, `?` included. The window is always named even
 * at its default, because the address bar is also the thing being shared:
 * `/stats?window=7d` says which week it is, `/stats` does not.
 */
export function statsFiltersSearch(filters: StatsFilters): string {
  const params = new URLSearchParams()
  params.set(WINDOW_PARAM, filters.window)
  if (filters.project) params.set(PROJECT_PARAM, filters.project)
  if (filters.model) params.set(MODEL_PARAM, filters.model)
  return `?${params.toString()}`
}

export function statsUrl(filters: StatsFilters, pathname = '/stats'): string {
  return `${pathname}${statsFiltersSearch(filters)}`
}
