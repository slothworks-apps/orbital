import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react'
import { api } from '../lib/api'
import { hasDesktopBridge } from '../lib/desktop'
import { shortenPath } from '../lib/format'
import {
  MAP_PATH,
  pageCrumbs,
  pageTitle,
  upCrumb,
  type CrumbKey,
  type PageBarRoute,
  type PageCrumb,
} from '../lib/pageCrumbs'
import { tagColor, type ApiSession, type Tag } from '../lib/types'
import { useWindowBand } from '../lib/windowChrome'
import { useWindowFocused } from '../lib/useWindowFocused'
import { useCommand } from '../lib/commands'
import { statusWord } from '../walkthrough/derive'
import { STATS_PATH } from '../stats/route'
import { Logo } from './Logo'

/**
 * The bar across the top of every sub-page of the main window — `/stats`, the
 * drilldown, and the walkthrough's cover, steps and close screen (spec:
 * 2026-09-24-page-headers-design; canvas `Feature - Page headers` 25a–25j).
 * Left, the breadcrumb; right, in this order, the session's path, its status
 * chip and the esc button. It owns the page's keys as well: esc to the map,
 * `global.up` (the keymap's) up one crumb, and `global.map` / `global.stats`.
 */

/**
 * The two geometries (25g). Windowed, the bar is as tall as the traffic
 * lights need, its row sits on their line, and the mark lands where the map's
 * sidebar puts it; full screen and in a browser there are no lights and the
 * bar is the old walkthrough bar's height.
 */
export const PAGE_BAR_WINDOWED = { heightPx: 64, padding: '24px 24px 12px 96px', markXPx: 96 } as const
export const PAGE_BAR_FLAT = { heightPx: 56, padding: '14px 24px 14px 34px', markXPx: 34 } as const

export function pageBarGeometry(windowed: boolean) {
  return windowed ? PAGE_BAR_WINDOWED : PAGE_BAR_FLAT
}

/**
 * What the bar lies over. `sky`: the stats pages, which scroll under it and
 * wear the map's band gradient until they do (25b). `columns`: the
 * walkthrough, whose columns start at its edge, so its fill and hairline are
 * always on (25d).
 */
export type PageBarSurface = 'sky' | 'columns'

/** The map's band hint (canvas `Feature - Main window chrome` 24g), which the stats bar wears at rest. */
const BAND_GRADIENT = 'linear-gradient(180deg,rgba(2,3,8,.55),rgba(2,3,8,0) 48px)'
const HAIRLINE = 'rgba(150,205,255,.1)'
const SCROLLED_FILL = 'rgba(5,7,13,.86)'
const SCROLLED_BLUR = 'blur(18px)'
const COLUMNS_FILL = 'rgba(5,7,13,.6)'

interface PageBarProps {
  route: PageBarRoute
  surface: PageBarSurface
  /** The session a drilldown or walkthrough is about; its tag, path and status. Null while it loads, or when unknown. */
  session?: ApiSession | null
  /** A line of plain text ahead of the path — the walkthrough's "steps may be added". */
  notice?: string | null
  /**
   * Crumbs whose navigation the page does itself, by the crumb's key: the
   * walkthrough's cover is page state, and the drilldown goes back through
   * history to keep the findings' scroll. Taken for a plain click and for `global.up`;
   * a modified click still follows the href.
   */
  onCrumb?: Partial<Record<CrumbKey, () => void>>
}

export function PageBar({ route, surface, session = null, notice = null, onCrumb }: PageBarProps) {
  const windowed = useWindowBand()
  const geometry = pageBarGeometry(windowed)
  const focused = useWindowFocused(hasDesktopBridge())
  const scrolled = useScrolled(surface === 'sky')
  const hue = useSessionHue(route.page === 'stats' || route.page === 'limits' ? null : session)
  const crumbs = pageCrumbs(route)
  const title = pageTitle(route)

  useEffect(() => {
    document.title = title
  }, [title])

  const follow = (crumb: PageCrumb) => {
    const own = onCrumb?.[crumb.key]
    if (own) own()
    else if (crumb.href !== null) window.location.assign(crumb.href)
  }

  // esc: the map, in one press, from anywhere on the page (25h). An overlay
  // registered with the escape-layer stack takes the key first, in the
  // capture phase, and it never reaches here; a focused field only lets go of
  // the focus. It is on `window` in the bubble phase, so a control that
  // handled the key itself keeps it. The way up one crumb is the keymap's
  // `global.up`, which every page bar route has a parent crumb for.
  const up = upCrumb(route)
  useCommand('global.up', () => follow(up))
  // The bar is on every page that is not the map, so it is where ⌘1 and ⌘2
  // are served away from `App`. Each stays put on the page it names.
  useCommand('global.map', () => {
    if (window.location.pathname !== MAP_PATH) window.location.assign(MAP_PATH)
  })
  useCommand('global.stats', () => {
    if (window.location.pathname !== STATS_PATH) window.location.assign(STATS_PATH)
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const target = e.target as HTMLElement | null
        if (target?.closest('input, textarea, [contenteditable="true"]')) target.blur()
        else window.location.assign(MAP_PATH)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const background =
    surface === 'columns'
      ? { background: COLUMNS_FILL, hairline: HAIRLINE, blur: 'none' }
      : scrolled
        ? { background: SCROLLED_FILL, hairline: HAIRLINE, blur: SCROLLED_BLUR }
        : { background: windowed ? BAND_GRADIENT : 'transparent', hairline: 'transparent', blur: 'none' }

  const style: CSSProperties = {
    height: geometry.heightPx,
    padding: geometry.padding,
    background: background.background,
    borderBottomColor: background.hairline,
    backdropFilter: background.blur,
    WebkitBackdropFilter: background.blur,
  }

  const path = session ? [shortenPath(session.cwd), session.git?.ref].filter(Boolean).join(' · ') : null

  return (
    <header
      style={style}
      className={[
        // The whole bar drags the window (25b); `.orbital-drag-region` makes
        // its links, buttons and `[data-no-drag]` pieces no-drag.
        windowed ? 'orbital-drag-region' : '',
        'sticky top-0 z-20 box-border flex w-full shrink-0 items-center gap-[2px] border-b border-solid',
      ].join(' ')}
    >
      {crumbs.map((crumb, i) => (
        <Crumb
          key={crumb.key}
          crumb={crumb}
          first={i === 0}
          hue={crumb.kind === 'session' ? hue : undefined}
          dimmed={!focused}
          onFollow={onCrumb?.[crumb.key] ? () => follow(crumb) : undefined}
        />
      ))}
      <span className="flex-1" />
      {notice && (
        <span className={`${RIGHT_ITEM} min-w-0 truncate text-[11px] tracking-[.02em] text-[rgba(160,190,225,.5)]`} style={{ flex: '0 10 auto' }}>
          {notice}
        </span>
      )}
      {path && (
        <span
          title={session?.cwd}
          className={`${RIGHT_ITEM} block max-w-[380px] truncate px-[2px] text-[11px] leading-[26px] tracking-[.02em] text-[rgba(160,190,225,.6)]`}
          // Shrinks second, after the session crumb (25g truncation).
          style={{ flex: '0 1 auto', minWidth: 60 }}
        >
          {path}
        </span>
      )}
      {session && <StatusChip session={session} />}
      <button
        type="button"
        title="Back to the map · esc"
        aria-label="Back to the map"
        onClick={() => window.location.assign(MAP_PATH)}
        className={[
          RIGHT_ITEM,
          'flex shrink-0 cursor-default items-center gap-1.5 border border-[rgba(150,205,255,.14)] pl-2 pr-1 text-[13px] text-[rgba(200,220,245,.75)]',
          'transition-[background-color,border-color,color] duration-150',
          'hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.14)] hover:text-text-bright',
          FOCUS_RING,
        ].join(' ')}
      >
        <span className="leading-none">×</span>
        <span className="rounded-[4px] border border-[rgba(150,205,255,.18)] bg-[rgba(150,205,255,.06)] px-[5px] py-[2px] text-[9.5px] leading-[1.3] tracking-[.1em]">
          ESC
        </span>
      </button>
    </header>
  )
}

/** Every item on the right (25b): 26 tall, rounded, mono, a little way off its neighbour. */
const RIGHT_ITEM = 'ml-2 box-border h-[26px] rounded-[7px] font-mono whitespace-nowrap'

/** The esc button's keyboard focus (25g FOCUS); the crumbs share it. */
const FOCUS_RING =
  'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-[oklch(85%_.12_205/.8)]'

/** A crumb's hover, for links only; the page's own crumb is not one (25g). */
const CRUMB_HOVER = 'hover:bg-[rgba(150,205,255,.08)] hover:text-text-bright'

const CRUMB_TYPE = {
  root: 'font-sans text-[13px] font-bold tracking-[.22em]',
  section: 'font-mono text-[11px] tracking-[.1em]',
  session: 'font-mono text-[11px] tracking-[.02em]',
  item: 'font-mono text-[11px] tracking-[.02em]',
}

function Crumb({
  crumb,
  first,
  hue,
  dimmed,
  onFollow,
}: {
  crumb: PageCrumb
  first: boolean
  hue: number | null | undefined
  dimmed: boolean
  onFollow?: () => void
}) {
  const isSession = crumb.kind === 'session'
  const className = [
    'flex h-[26px] items-center gap-2 overflow-hidden whitespace-nowrap rounded-[7px] px-2 no-underline',
    'transition-[background-color,color] duration-150',
    CRUMB_TYPE[crumb.kind],
    // The wordmark and the page's own crumb are bright; the way up is not.
    crumb.kind === 'root' || crumb.href === null ? 'text-text-bright' : 'text-[rgba(160,190,225,.7)]',
    crumb.href === null ? 'cursor-default' : CRUMB_HOVER,
    // The root's padding hangs outside the bar's, so the mark itself sits on
    // the bar's left edge (25g).
    first ? '-ml-2' : '',
    FOCUS_RING,
  ].join(' ')
  // The session crumb gives way first when the bar runs short (25g), down to
  // its dot and a few letters.
  const style: CSSProperties = isSession ? { flex: '0 100 auto', minWidth: 56 } : { flex: 'none' }

  const body = (
    <>
      {crumb.kind === 'root' && <Logo dimmed={dimmed} />}
      {isSession && (
        <span
          aria-hidden
          className="block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: hue == null ? 'rgba(160,190,225,.5)' : tagColor(hue) }}
        />
      )}
      <span className="min-w-0 overflow-hidden text-ellipsis">{crumb.label}</span>
    </>
  )

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!onFollow || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    onFollow()
  }

  return (
    <>
      {!first && <span className="shrink-0 px-1 font-mono text-[11px] text-[rgba(150,205,255,.25)]">/</span>}
      {crumb.href === null ? (
        <span data-no-drag aria-current="page" className={className} style={style}>
          {body}
        </span>
      ) : (
        <a href={crumb.href} onClick={onClick} title={first ? 'Map' : `Go to ${crumb.label}`} className={className} style={style}>
          {body}
        </a>
      )}
    </>
  )
}

/** The resting chip (25g): a neutral dot, the status word, no hover. The dot blinks while the session works. */
function StatusChip({ session }: { session: ApiSession }) {
  return (
    <span
      data-no-drag
      className={`${RIGHT_ITEM} flex shrink-0 items-center gap-1.5 border border-[rgba(150,205,255,.14)] px-[9px] text-[10.5px] tracking-[.08em] text-[rgba(200,220,245,.75)]`}
    >
      <span
        aria-hidden
        className={[
          'block h-1.5 w-1.5 shrink-0 rounded-full bg-[rgba(160,190,225,.5)]',
          session.status === 'working' ? 'animate-pulse' : '',
        ].join(' ')}
      />
      <span className="leading-none">{statusWord(session)}</span>
    </span>
  )
}

/**
 * Whether content has scrolled under the bar — the document's own scroll,
 * since the stats pages scroll the window. Tracked only for the `sky`
 * surface; the walkthrough's fill does not depend on it.
 */
function useScrolled(enabled: boolean): boolean {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const measure = () => setScrolled(window.scrollY > 0)
    measure()
    window.addEventListener('scroll', measure, { passive: true })
    return () => window.removeEventListener('scroll', measure)
  }, [enabled])
  return scrolled
}

/**
 * The hue of the tag the session wears, for its crumb's dot — the same pick
 * as the sidebar, the map and the detail panel (first resolvable tag, else
 * the default one; see `primaryTag` there). The sub-pages load no store, so
 * the tags are read here, once.
 */
function useSessionHue(session: ApiSession | null): number | null {
  const [tags, setTags] = useState<Tag[]>([])
  const wanted = session !== null
  useEffect(() => {
    if (!wanted) return
    let live = true
    api.listTags().then(
      (list) => {
        if (live) setTags(list ?? [])
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [wanted])
  if (!session) return null
  for (const tagId of session.tagIds ?? []) {
    const tag = tags.find((t) => t.id === tagId)
    if (tag) return tag.hue
  }
  return tags.find((t) => t.is_default === 1)?.hue ?? null
}
