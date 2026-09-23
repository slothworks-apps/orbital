import { describe, expect, it } from 'vitest'
import { MAP_PATH, pageCrumbs, pageTitle, upCrumb, type PageBarRoute } from '../lib/pageCrumbs'
import { STATS_PATH } from '../stats/route'
import { walkthroughPath } from '../walkthrough/route'

const walk = (screen: Extract<PageBarRoute, { page: 'walkthrough' }>['screen']): PageBarRoute => ({
  page: 'walkthrough',
  id: 'w 1',
  title: 'auth-refactor',
  screen,
})

const labels = (route: PageBarRoute) => pageCrumbs(route).map((c) => c.label)

describe('pageCrumbs', () => {
  it('spells out each page, and only the last crumb is not a link', () => {
    const routes: PageBarRoute[] = [
      { page: 'stats' },
      { page: 'drilldown', title: 'refactor map layer' },
      walk({ kind: 'cover' }),
      walk({ kind: 'step', n: 4, total: 9 }),
      walk({ kind: 'close' }),
    ]
    expect(routes.map(labels)).toEqual([
      ['ORBITAL', 'STATS'],
      ['ORBITAL', 'STATS', 'refactor map layer'],
      ['ORBITAL', 'auth-refactor', 'WALKTHROUGH'],
      ['ORBITAL', 'auth-refactor', 'WALKTHROUGH', 'step 4 of 9'],
      ['ORBITAL', 'auth-refactor', 'WALKTHROUGH', 'close'],
    ])
    for (const route of routes) {
      const crumbs = pageCrumbs(route)
      expect(crumbs.at(-1)?.href).toBeNull()
      expect(crumbs.slice(0, -1).every((c) => c.href !== null)).toBe(true)
    }
  })

  it('sends the session crumb to the map with its panel open, and WALKTHROUGH to the cover', () => {
    const [root, session, section] = pageCrumbs(walk({ kind: 'step', n: 1, total: 2 }))
    expect(root.href).toBe(MAP_PATH)
    expect(session.href).toBe('/?session=w+1')
    expect(section.href).toBe(walkthroughPath('w 1'))
  })
})

describe('upCrumb', () => {
  it('goes up one crumb from every page', () => {
    expect(upCrumb({ page: 'stats' }).href).toBe(MAP_PATH)
    expect(upCrumb({ page: 'drilldown', title: 'x' }).href).toBe(STATS_PATH)
    expect(upCrumb(walk({ kind: 'cover' })).key).toBe('session')
    expect(upCrumb(walk({ kind: 'step', n: 3, total: 9 })).key).toBe('walkthrough')
    expect(upCrumb(walk({ kind: 'close' })).key).toBe('walkthrough')
  })
})

describe('pageTitle', () => {
  it('puts the deepest crumb first', () => {
    expect(pageTitle({ page: 'stats' })).toBe('Stats · Orbital')
    expect(pageTitle({ page: 'drilldown', title: 'refactor map layer' })).toBe('refactor map layer · Stats · Orbital')
    expect(pageTitle(walk({ kind: 'cover' }))).toBe('auth-refactor · Walkthrough · Orbital')
    expect(pageTitle(walk({ kind: 'step', n: 4, total: 9 }))).toBe('step 4 · auth-refactor · Orbital')
    expect(pageTitle(walk({ kind: 'close' }))).toBe('close · auth-refactor · Orbital')
  })
})
