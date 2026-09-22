import { describe, it, expect } from 'vitest'
import {
  DEFAULT_STATS_FILTERS,
  readStatsFilters,
  statsFiltersSearch,
  statsUrl,
  type StatsFilters,
} from '../stats/filters'
import { parseStatsRoute, sessionStatsPath } from '../stats/route'

describe('readStatsFilters', () => {
  it('falls back to the default window when the query names none', () => {
    expect(readStatsFilters('')).toEqual(DEFAULT_STATS_FILTERS)
    expect(readStatsFilters('?project=/w/orbital')).toEqual({
      ...DEFAULT_STATS_FILTERS,
      project: '/w/orbital',
    })
  })

  it('reads the three filters the overview endpoint takes', () => {
    expect(readStatsFilters('?window=30d&project=/w/api&model=claude-opus-5')).toEqual({
      window: '30d',
      project: '/w/api',
      model: 'claude-opus-5',
    })
  })

  it('drops a window the endpoint would refuse, and an empty value', () => {
    expect(readStatsFilters('?window=90d').window).toBe(DEFAULT_STATS_FILTERS.window)
    expect(readStatsFilters('?project=&model=').project).toBeNull()
    expect(readStatsFilters('?project=&model=').model).toBeNull()
  })
})

describe('statsFiltersSearch', () => {
  const cases: StatsFilters[] = [
    { window: '24h', project: null, model: null },
    { window: 'all', project: '/w/orbital', model: null },
    { window: '7d', project: null, model: 'claude-opus-5' },
    { window: '30d', project: '/Users/t/w/a b', model: 'claude-haiku-4-5' },
  ]

  it('round-trips every filter combination through the URL', () => {
    for (const filters of cases) {
      expect(readStatsFilters(statsFiltersSearch(filters))).toEqual(filters)
    }
  })

  it('names only the filters that are set', () => {
    expect(statsFiltersSearch({ window: '24h', project: null, model: null })).toBe('?window=24h')
    expect(statsFiltersSearch({ window: '7d', project: '/w/a', model: null })).toBe(
      '?window=7d&project=%2Fw%2Fa'
    )
  })

  it('builds the dashboard URL the address bar carries', () => {
    expect(statsUrl({ window: 'all', project: null, model: null })).toBe('/stats?window=all')
  })
})

describe('parseStatsRoute', () => {
  it('matches the dashboard, with or without a trailing slash', () => {
    expect(parseStatsRoute('/stats')).toEqual({ kind: 'dashboard' })
    expect(parseStatsRoute('/stats/')).toEqual({ kind: 'dashboard' })
  })

  it('matches the drilldown and decodes its id', () => {
    expect(parseStatsRoute('/stats/session/abc-123')).toEqual({ kind: 'session', id: 'abc-123' })
    expect(parseStatsRoute(sessionStatsPath('a b'))).toEqual({ kind: 'session', id: 'a b' })
  })

  it('claims no path outside /stats', () => {
    expect(parseStatsRoute('/')).toBeNull()
    expect(parseStatsRoute('/sandbox')).toBeNull()
    expect(parseStatsRoute('/statsomething')).toBeNull()
  })

  it('treats an unknown /stats path as the dashboard rather than a dead end', () => {
    expect(parseStatsRoute('/stats/session')).toEqual({ kind: 'dashboard' })
    expect(parseStatsRoute('/stats/nope/deeper')).toEqual({ kind: 'dashboard' })
  })
})
