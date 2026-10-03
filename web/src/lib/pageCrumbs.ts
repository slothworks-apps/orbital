import { STATS_PATH } from '../stats/route'
import { mapHref, walkthroughPath } from '../walkthrough/route'

/**
 * Where a sub-page of the main window sits, as its bar spells it out (spec:
 * 2026-09-24-page-headers-design § Breadcrumbs; canvas `Feature - Page
 * headers` 25b–25f). The crumbs, the `global.up` target and the document title are all
 * read off the same list, so the key cannot go somewhere the bar does not
 * show.
 */

/** The map: where esc, the esc button and the ORBITAL crumb all go. */
export const MAP_PATH = '/'

/** The walkthrough screen the bar is drawn over; the screen itself lives in page state, not in the URL. */
export type WalkthroughCrumbScreen =
  | { kind: 'cover' }
  | { kind: 'step'; n: number; total: number }
  | { kind: 'close' }

export type PageBarRoute =
  | { page: 'stats' }
  | { page: 'limits' }
  | { page: 'drilldown'; title: string }
  | { page: 'walkthrough'; id: string; title: string; screen: WalkthroughCrumbScreen }

/** What a crumb names, so a page can take over a crumb's navigation (the walkthrough's cover is page state). */
export type CrumbKey = 'map' | 'stats' | 'session' | 'walkthrough' | 'here'

/**
 * How a crumb is set (25g): the mark and wordmark, a caps section, a session
 * name with its tag dot, or a lowercase item such as a step.
 */
export type CrumbKind = 'root' | 'section' | 'session' | 'item'

export interface PageCrumb {
  key: CrumbKey
  label: string
  kind: CrumbKind
  /** Null for the last crumb: it is where the page is, not a link. */
  href: string | null
}

export function pageCrumbs(route: PageBarRoute): PageCrumb[] {
  const root: PageCrumb = { key: 'map', label: 'ORBITAL', kind: 'root', href: MAP_PATH }
  if (route.page === 'stats') {
    return [root, { key: 'here', label: 'STATS', kind: 'section', href: null }]
  }
  if (route.page === 'limits') {
    return [root, { key: 'here', label: 'LIMITS', kind: 'section', href: null }]
  }
  if (route.page === 'drilldown') {
    return [
      root,
      { key: 'stats', label: 'STATS', kind: 'section', href: STATS_PATH },
      { key: 'here', label: route.title, kind: 'session', href: null },
    ]
  }
  const session: PageCrumb = { key: 'session', label: route.title, kind: 'session', href: mapHref(route.id) }
  if (route.screen.kind === 'cover') {
    return [root, session, { key: 'here', label: 'WALKTHROUGH', kind: 'section', href: null }]
  }
  return [
    root,
    session,
    { key: 'walkthrough', label: 'WALKTHROUGH', kind: 'section', href: walkthroughPath(route.id) },
    { key: 'here', label: walkthroughScreenLabel(route.screen), kind: 'item', href: null },
  ]
}

/**
 * Where `global.up` goes: the parent crumb, never history (25h — "you can read where
 * it goes before you press it"). Every page has at least ORBITAL above it.
 */
export function upCrumb(route: PageBarRoute): PageCrumb {
  const crumbs = pageCrumbs(route)
  return crumbs[crumbs.length - 2]
}

/**
 * `document.title`, deepest crumb first (spec § Window titles; 25f). A step
 * says only its number: "of N" changes while a live session grows, and the
 * title is what Mission Control and the tab strip show.
 */
export function pageTitle(route: PageBarRoute): string {
  if (route.page === 'stats') return 'Stats · Orbital'
  if (route.page === 'limits') return 'Limits · Orbital'
  if (route.page === 'drilldown') return `${route.title} · Stats · Orbital`
  if (route.screen.kind === 'cover') return `${route.title} · Walkthrough · Orbital`
  const here = route.screen.kind === 'step' ? `step ${route.screen.n}` : 'close'
  return `${here} · ${route.title} · Orbital`
}

function walkthroughScreenLabel(screen: Exclude<WalkthroughCrumbScreen, { kind: 'cover' }>): string {
  return screen.kind === 'step' ? `step ${screen.n} of ${screen.total}` : 'close'
}
