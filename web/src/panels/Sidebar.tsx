import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  SIDEBAR_DEFAULT_PX,
  clampSidebarWidth,
  parseSidebarWidth,
  useOrbital,
  visibleSessions,
} from '../store/store'
import { api } from '../lib/api'
import { shortcutLabel } from '../lib/keymap'
import { useCommand } from '../lib/commands'
import { partitionSessions } from '../lib/sidebarOrder'
import { reportError } from '../lib/errors'
import { hasDesktopBridge } from '../lib/desktop'
import { TopGlint } from '../ui/TopGlint'
import { useWindowBand } from '../lib/windowChrome'
import { useWindowFocused } from '../lib/useWindowFocused'
import { useViewportWidth } from '../lib/useViewportWidth'
import { awaitedCount, awaitedWork, gateWaits, isReadOnly, sessionStateKey, tagColor } from '../lib/types'
import { compactingLabelOpacity, compactingOf, formatElapsed } from '../lib/compaction'
import { useNow } from '../lib/useNow'
import { stateColor, stateDot, stateWord } from '../lib/stateStyle'
import { StateDot } from '../ui/StateDot'
import type { ApiSession, SessionSource, Tag } from '../lib/types'
import { Panel } from '../ui/Panel'
import { Chip } from '../ui/Chip'
import { Select } from '../ui/Select'
import { Logo } from '../ui/Logo'
import { PinButton } from '../ui/PinButton'
import { DetachGlyph, StatsGlyph } from '../ui/UtilityButton'
import { STATS_PATH } from '../stats/route'
import { LIMITS_PATH } from '../limits/route'
import { limitWaitShort } from '../lib/limits'
import { claudeDirLabel } from '../lib/claudeDirs'
import { sessionViewTransitionName } from '../lib/viewTransition'
import { timeAgo, shortenPath } from '../lib/format'

/** How many sessions `loadMore` asks for per infinite-scroll page. */
const PAGE_SIZE = 20

const SEARCH_INPUT_ID = 'sidebar-search'

/**
 * Minimal shape `Sidebar` needs from an `IntersectionObserver` — lets tests
 * inject a fake, since jsdom has no real IO implementation.
 */
export interface ObserverLike {
  observe(el: Element): void
  disconnect(): void
}

export type ObserverFactory = (callback: IntersectionObserverCallback) => ObserverLike

/** Real `IntersectionObserver`, used outside tests. */
export const defaultObserverFactory: ObserverFactory = (callback) =>
  new IntersectionObserver(callback, { rootMargin: '200px' })

export interface SidebarProps {
  /** Injectable IntersectionObserver factory; defaults to the real thing. */
  observerFactory?: ObserverFactory
}

/**
 * The origin filter's vocabulary (canvas 3a). The menu spells out what the
 * option means; the trigger keeps the short form, because it sits inside a
 * heading that is already carrying a word and a number.
 */
const originOptions: Array<{ value: 'all' | SessionSource; label: string; short: string }> = [
  { value: 'all', label: 'all sessions', short: 'all' },
  { value: 'web', label: 'started in orbital', short: 'in orbital' },
  { value: 'terminal', label: 'other terminals · read-only', short: 'read-only' },
]

/** Canvas 3b: neutral, hue-free, no icon — hue on a row belongs to the tag. */
function ReadOnlyBadge() {
  return (
    <span
      title="Attached from an external terminal · read-only in Orbital"
      className="shrink-0 rounded border border-[rgba(150,205,255,.18)] bg-[rgba(150,205,255,.04)] px-[5px] py-px font-mono text-[9px] tracking-[0.1em] text-[rgba(160,190,225,.75)]"
    >
      read-only
    </span>
  )
}

/**
 * The Claude directory a session belongs to, only when two or more are
 * configured (spec 2026-10-04-multiple-claude-directories-design § 8). No
 * canvas yet: the read-only badge's neutral mono ink, so it reads as neither
 * a state, a mode nor a tag.
 */
function ClaudeDirBadge({ claudeDirId }: { claudeDirId: number | undefined }) {
  const name = useOrbital((s) => claudeDirLabel(s.claudeDirs, claudeDirId))
  if (!name) return null
  return (
    <span
      data-claude-dir-label
      title={`Runs under the  Claude directory`}
      className="shrink-0 rounded border border-[rgba(150,205,255,.18)] bg-[rgba(150,205,255,.04)] px-[5px] py-px font-mono text-[9px] tracking-[0.1em] text-[rgba(160,190,225,.75)]"
    >
      {name}
    </span>
  )
}

/** First tag's hue drives a row's dot color, matching the map (canvas 1a). */
function rowHue(session: ApiSession, tags: Tag[]): number | undefined {
  for (const id of session.tagIds) {
    const tag = tags.find((t) => t.id === id)
    if (tag) return tag.hue
  }
  return tags.find((t) => t.is_default === 1)?.hue
}

/**
 * Row lead dot: a solid, glowing tag-hue disc while the session works or
 * waits for input; a hollow hue ring while it sits idle, dimmer once it has
 * ended — so the collapsed rail tells busy from quiet at a glance. Fill alone
 * carries that: the disc does not blink, a blink beside the map distracts.
 * The export draws list dots at 7px and the collapsed rail's at 8px.
 */
function RowDot({
  hue,
  status,
  size = 7,
}: {
  hue: number | undefined
  status: ApiSession['status']
  size?: 7 | 8
}) {
  const color = hue !== undefined ? tagColor(hue) : 'rgba(160,190,225,.6)'
  const box = { width: `${size}px`, height: `${size}px` }
  if (status === 'idle' || status === 'ended') {
    return (
      <span
        aria-hidden
        className="shrink-0 rounded-full border"
        style={{ ...box, borderColor: color, opacity: status === 'ended' ? 0.6 : 0.9 }}
      />
    )
  }
  return (
    <span
      aria-hidden
      className="shrink-0 rounded-full"
      style={{ ...box, background: color, boxShadow: `0 0 8px ${color}` }}
    />
  )
}

/**
 * 28×28 square icon button used by the sidebar's collapse/expand toggles —
 * the export gives these their own chrome (7px radius, .14 hairline, 14px
 * glyph) rather than any of `Button`'s variants.
 */
/**
 * The settings affordance's glyph in canvas 1a: a dashed accent ring — an
 * orbit, not a gear. It appears twice at two sizes, 9px in the expanded
 * footer's pill and 12px in the collapsed rail's icon button.
 *
 * `block` is load-bearing: a bare `<span>` is an inline box and ignores
 * width/height (see `web/CLAUDE.md`).
 */
function SettingsRing({ size }: { size: 9 | 12 }) {
  return (
    <span
      aria-hidden
      className={[
        'block shrink-0 rounded-full border-[1.5px] border-dashed border-accent',
        size === 9 ? 'h-[9px] w-[9px]' : 'h-3 w-3',
      ].join(' ')}
    />
  )
}

/**
 * The app-level way into `/stats` (canvas `Feature - Header gauges` 11d).
 *
 * It belongs in the footer because the footer already IS the app-level strip
 * — a session count and the only global button — and stats is the second
 * app-level destination. Icon only: the pair then reads as utilities, and the
 * word SETTINGS keeps its weight.
 *
 * A real `<a>` to a real path, like every other stats link (`stats/route.ts`).
 * There is deliberately no active state: `/stats` replaces the whole app
 * (`main.tsx` branches before `App`), so this sidebar is never on screen
 * while that route is current.
 */
function StatsLink({ size }: { size: 'footer' | 'rail' }) {
  const label = 'Stats — all sessions'
  return (
    <a
      href={STATS_PATH}
      aria-label={label}
      title={`${label} · ${shortcutLabel('global.stats')}`}
      className={[
        'grid shrink-0 place-items-center bg-[rgba(150,205,255,.05)] no-underline',
        'text-[rgba(200,220,245,.8)] transition-colors duration-[180ms] hover:text-text-bright',
        // 11d draws the footer icon at the settings pill's own height and
        // chrome; both pin that height with the same class so their edges
        // line up — the pill's padding alone leaves it a pixel taller than
        // the icon. The rail's is the rail settings button, glyph and all.
        size === 'footer'
          ? 'h-6 w-[26px] rounded-[7px] border border-panel-border hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.12)]'
          : 'h-[30px] w-[30px] rounded-lg border border-panel-border hover:bg-[rgba(150,205,255,.13)]',
      ].join(' ')}
    >
      <StatsGlyph size={size === 'footer' ? 'footer' : 'header'} />
    </a>
  )
}

/**
 * The way into `/limits` (canvas `Feature - Plan limits` 31e-a): stats ·
 * limits · SETTINGS, in the stats link's own shell. The ring is drawn ¾ full
 * in neutral ink and never changes — no colour, no fill level, no dot — so
 * it cannot turn into a badge.
 */
function LimitsLink({ size }: { size: 'footer' | 'rail' }) {
  const label = 'Limits — plan usage'
  const glyph = size === 'footer' ? 10 : 11
  return (
    <a
      href={LIMITS_PATH}
      aria-label={label}
      title={label}
      className={[
        'grid shrink-0 place-items-center bg-[rgba(150,205,255,.05)] no-underline',
        'text-[rgba(200,220,245,.8)] transition-colors duration-[180ms] hover:text-text-bright',
        size === 'footer'
          ? 'h-6 w-[26px] rounded-[7px] border border-panel-border hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.12)]'
          : 'h-[30px] w-[30px] rounded-lg border border-panel-border hover:bg-[rgba(150,205,255,.13)]',
      ].join(' ')}
    >
      <span
        aria-hidden
        className="block rounded-full"
        style={{
          width: glyph,
          height: glyph,
          background: 'conic-gradient(from -90deg, currentColor 0 250deg, rgba(200,220,245,.25) 250deg 360deg)',
          mask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px))',
          WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px))',
        }}
      />
    </a>
  )
}

function IconButton({
  label,
  title,
  glyph,
  onClick,
}: {
  label: string
  /** Hover title, when it says more than the label — the shortcut, say. */
  title?: string
  glyph: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] border border-panel-border text-sm text-[rgba(200,220,245,.7)] transition-colors hover:bg-white/5 hover:text-text-bright"
    >
      <span aria-hidden>{glyph}</span>
    </button>
  )
}

/**
 * Mono uppercase state column per canvas 24c: the word in its state colour
 * (`lib/stateStyle`), with NEEDS INPUT's breathing dot and WAITING's pulsing
 * hollow one. The row has room for about eleven characters, so NEEDS INPUT
 * reads `INPUT` and WAITING carries the moon count (`WAITING · 2`).
 *
 * The row's leading tag dot keeps the tag hue — a row can wear an amber tag
 * dot and an amber INPUT, and the word's text and dot keep them apart.
 */
function RowStatus({ session }: { session: ApiSession }) {
  const compacting = compactingOf(session)
  const now = useNow(compacting !== null)
  const key = sessionStateKey(session)
  const color = stateColor(key)
  // A compaction takes the label once it has run three seconds (26e): `COMPACT
  // 0:14`, the compacting grey, no dot. Shorter ones never show here at all.
  if (compacting && compactingLabelOpacity(now - compacting.startedAt) > 0) {
    return (
      <span
        data-state="compacting"
        className="orbital-compact-label-in flex shrink-0 items-center font-mono text-[9.5px] uppercase tracking-[0.08em] text-[rgba(214,228,246,.8)]"
      >
        COMPACT {formatElapsed(now - compacting.startedAt)}
      </span>
    )
  }
  // `Feature - Plan limits` 31d: a session waiting for a reset reads
  // `LIMIT · 15:00` in neutral ink, no dot — it is idle, and nothing is asked.
  if (session.limitWait) {
    return (
      <span
        data-state="limit"
        className="flex shrink-0 items-center font-mono text-[9.5px] uppercase tracking-[0.08em] text-[rgba(214,230,248,.8)]"
      >
        {limitWaitShort(session.limitWait)}
      </span>
    )
  }
  return (
    <span
      data-state={key}
      className="flex shrink-0 items-center gap-[5px] font-mono text-[9.5px] uppercase tracking-[0.08em]"
      style={{ color }}
    >
      <StateDot dot={stateDot(key, 'label', gateWaits(session))} color={color} solidPx={5} hollowPx={6} />
      {stateWord(key, awaitedCount(awaitedWork(session)), true)}
    </span>
  )
}

function SessionRow({
  session,
  tags,
  selected,
  onSelect,
  onTogglePin,
  right,
  history = false,
  detached = false,
}: {
  session: ApiSession
  tags: Tag[]
  selected: boolean
  /** Open in a detached window (spec: 2026-09-23-detached-session-windows-design). */
  detached?: boolean
  onSelect: (id: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
  right: ReactNode
  /** History rows sit a notch tighter and lighter than active ones (1a). */
  history?: boolean
}) {
  const hue = rowHue(session, tags)
  const pinned = session.pinnedAt != null
  return (
    // Two sibling interactive elements — the pin is a button, and a button
    // inside the row button would be invalid HTML. Same shape `ToolRow` uses:
    // the row's own press is an absolute layer under a content line that
    // takes no pointer, except the pin, which takes its own (canvas 4c).
    <li
      // The row's identity to the view transition that carries it between
      // PINNED and ACTIVE/HISTORY when the pin flips (`lib/viewTransition`).
      // A style prop rather than a class: the name is per session, and
      // Tailwind cannot build a utility from a runtime value.
      style={{ viewTransitionName: sessionViewTransitionName(session.id) }}
      className={[
        'group/row relative rounded-lg transition-colors hover:bg-white/5',
        // 1a dims ended rows; per-row rather than on the list, because 4c
        // puts ended and live rows side by side inside PINNED.
        history ? 'opacity-75' : '',
        selected
          ? 'border border-[rgba(150,205,255,.12)] bg-[rgba(150,205,255,.07)]'
          : 'border border-transparent',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        aria-current={selected ? 'true' : undefined}
        aria-label={session.title}
        className="absolute inset-0 h-full w-full rounded-lg"
      />
      <div
        className={[
          'pointer-events-none relative flex w-full items-center gap-2.5 px-2.5 text-left',
          // 1a: 9px vertical on active rows, 8px on history rows.
          history ? 'py-2' : 'py-[9px]',
        ].join(' ')}
      >
        <RowDot hue={hue} status={session.status} />
        <span className="min-w-0 flex-1">
          {/* 3b: the badge shares the name's line, so it reads as a property
              of the session rather than of its status — and the name is what
              gives way when the row is too narrow for both. */}
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={[
                'min-w-0 truncate text-[13px] text-text-bright',
                history ? 'font-medium' : 'font-semibold',
              ].join(' ')}
            >
              {session.title}
            </span>
            {/* 22e: the planet's badge glyph, bare — the row's way of saying
                the session is in a window of its own. Static, neutral ink. */}
            {detached && (
              <span className="flex shrink-0 text-[rgba(160,190,225,.6)]">
                <DetachGlyph />
              </span>
            )}
            {!history && isReadOnly(session) && <ReadOnlyBadge />}
            <ClaudeDirBadge claudeDirId={session.claudeDirId} />
          </span>
          <span className="block truncate font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
            {shortenPath(session.cwd)}
          </span>
        </span>
        {/* The slot is in every row of every section, at the same size and in
            the same gap — 4c's whole point is that revealing it moves
            nothing. */}
        <span className="pointer-events-auto flex shrink-0">
          <PinButton
            size={18}
            pinned={pinned}
            onToggle={() => onTogglePin(session.id, !pinned)}
          />
        </span>
        <span className="shrink-0">{right}</span>
      </div>
    </li>
  )
}

/** ACTIVE/PINNED/HISTORY heading, per canvas 1a with 4a's accent count. */
function SectionHeading({
  label,
  count,
  first,
  children,
  headingRef,
}: {
  label: string
  count?: number
  /** The first heading in the scroller sits tighter under the chip row (1a). */
  first?: boolean
  children?: ReactNode
  headingRef?: Ref<HTMLHeadingElement>
}) {
  return (
    <h3
      ref={headingRef}
      className={[
        'flex items-center gap-2 px-[18px] pb-1.5 font-mono text-[10px] tracking-[0.18em] text-text-muted',
        first ? 'pt-3.5' : 'pt-[18px]',
      ].join(' ')}
    >
      {label}
      {count !== undefined && <span className="tracking-normal text-accent">{count}</span>}
      {children}
    </h3>
  )
}

/**
 * Left rail per artboard 1a: wordmark + collapse toggle, search (⌘K), tag
 * filter chips, ACTIVE/HISTORY session lists with infinite scroll — ACTIVE
 * carrying 3a's origin filter in its heading — and a footer session count +
 * "tags & rules" entry point.
 */
export function Sidebar({ observerFactory = defaultObserverFactory }: SidebarProps) {
  const collapsed = useOrbital((s) => s.ui.sidebarCollapsed)
  // The main desktop window's chrome: row 1 makes room for the traffic
  // lights, and the mark dims while the window is behind another (canvas
  // `Feature - Main window chrome` 24a, 24d).
  const windowBand = useWindowBand()
  const windowFocused = useWindowFocused(hasDesktopBridge())
  const historyRevealNonce = useOrbital((s) => s.ui.historyRevealNonce ?? 0)
  const filterTagId = useOrbital((s) => s.ui.filterTagId)
  const search = useOrbital((s) => s.ui.search)
  const sourceFilter = useOrbital((s) => s.ui.sourceFilter)
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const detachedIds = useOrbital((s) => s.detachedIds)

  const setFilterTag = useOrbital((s) => s.setFilterTag)
  const setSearch = useOrbital((s) => s.setSearch)
  const setSourceFilter = useOrbital((s) => s.setSourceFilter)
  const setSidebarCollapsed = useOrbital((s) => s.setSidebarCollapsed)
  const setDialog = useOrbital((s) => s.setDialog)
  const select = useOrbital((s) => s.select)
  const setSessionPinned = useOrbital((s) => s.setSessionPinned)
  const applySessionsEvent = useOrbital((s) => s.applySessionsEvent)

  const tags = useOrbital(useShallow((s) => s.tags))
  const visible = useOrbital(useShallow(visibleSessions))

  // Resizable width — the mirror of the detail panel's handle, down to the
  // optimistic save: the store value moves LIVE during the drag (the panel
  // and the map's fit/follow insets track the pointer) and the PATCH goes out
  // once, on release.
  const settings = useOrbital(useShallow((s) => s.settings))
  const viewportWidth = useViewportWidth()
  const width = parseSidebarWidth(settings, viewportWidth)
  const widthDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  // Shared with the detail panel's handle: SpaceMap's overlays drop their
  // position transition on this flag so they track a drag 1:1.
  const draggingWidth = useOrbital((s) => s.ui.resizingPanel ?? false)
  const setDraggingWidth = (resizingPanel: boolean) =>
    useOrbital.setState((state) => ({ ui: { ...state.ui, resizingPanel } }))

  const setWidthLocal = (next: number) => {
    const value = String(Math.round(clampSidebarWidth(next, viewportWidth)))
    useOrbital.setState((state) => ({ settings: { ...state.settings, sidebar_width: value } }))
    return value
  }

  const saveWidth = (value: string) => {
    api
      .patchSettings({ sidebar_width: value })
      .catch((err) => reportError(err, 'Failed to save the sidebar width'))
  }

  const handleWidthPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    widthDragRef.current = { startX: e.clientX, startWidth: width }
    setDraggingWidth(true)
    // Optional-chained: jsdom has no pointer capture.
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const handleWidthPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = widthDragRef.current
    if (!drag) return
    // Left-docked panel: the pointer moving RIGHT widens it.
    setWidthLocal(drag.startWidth + (e.clientX - drag.startX))
  }

  const handleWidthPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = widthDragRef.current
    if (!drag) return
    widthDragRef.current = null
    setDraggingWidth(false)
    saveWidth(setWidthLocal(drag.startWidth + (e.clientX - drag.startX)))
  }

  const handleWidthReset = () => {
    saveWidth(setWidthLocal(SIDEBAR_DEFAULT_PX))
  }

  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const [exhausted, setExhausted] = useState(false)
  const historyHeadingRef = useRef<HTMLHeadingElement>(null)

  // Clicking the map's hole scrolls HISTORY into view — the hole is the
  // list's spatial handle (spec 2026-09-18-tag-clusters-design § 4). The
  // nonce (never reset) makes every click land, and `revealHistory` has
  // already un-collapsed the rail by the time this runs.
  useEffect(() => {
    if (historyRevealNonce === 0) return
    historyHeadingRef.current?.scrollIntoView({ block: 'start' })
  }, [historyRevealNonce])

  // The origin filter narrows ACTIVE and the map; HISTORY ignores it. See
  // the ADR `origin-filter-scopes-to-map-and-active` — an ended terminal
  // session is not read-only, so the distinction has nothing to say there.
  const { pinned, live, active, history } = useMemo(
    () => partitionSessions(visible, sourceFilter),
    [visible, sourceFilter]
  )

  // Counts describe the list the menu sits in, so `all sessions` is always
  // the number beside the ACTIVE heading. Memoised together with the options
  // they go into: `Select` repositions its popup when `options` changes
  // identity, and this heading re-renders on every list update.
  const originItems = useMemo(
    () =>
      originOptions.map((o) => ({
        ...o,
        count: o.value === 'all' ? live.length : live.filter((s) => s.source === o.value).length,
      })),
    [live]
  )

  const handleSelect = useCallback(
    (id: string) => {
      void select(id)
    },
    [select]
  )

  const handleTogglePin = useCallback(
    (id: string, next: boolean) => {
      void setSessionPinned(id, next)
    },
    [setSessionPinned]
  )

  // `global.search` reaches past an open dialog (it is a global command), but
  // pulling focus into the sidebar behind a modal would strand the keyboard
  // there, so the handler stands down while one is up.
  const dialogOpen = useOrbital((s) => s.ui.dialog !== null)
  useCommand(
    'global.search',
    () => {
      document.getElementById(SEARCH_INPUT_ID)?.focus()
    },
    !dialogOpen
  )

  useCommand('global.sidebar', () => setSidebarCollapsed(!collapsed))

  // A filter switch invalidates whatever offset/end-of-list state the
  // previous filter combination had accumulated — the server applies the
  // tag/q filters BEFORE slicing by offset, so "offset" only means the same
  // thing while the filter combination stays the same. The origin filter is
  // not in here because it is not in the request: it never changes which
  // rows the server returns.
  useEffect(() => {
    setExhausted(false)
  }, [filterTagId, search])

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const fetched = await api.listSessions({
        offset: visible.length,
        limit: PAGE_SIZE,
        tag: filterTagId !== 'all' ? filterTagId : undefined,
        q: search || undefined,
      })
      for (const session of fetched) {
        applySessionsEvent({ event: 'upsert', session })
      }
      if (fetched.length < PAGE_SIZE) setExhausted(true)
    } finally {
      loadingRef.current = false
    }
  }, [applySessionsEvent, visible.length, filterTagId, search])

  // Infinite scroll: observe the sentinel at the bottom of the session
  // lists and fetch the next page once it enters the viewport.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || exhausted) return
    const observer = observerFactory((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [observerFactory, loadMore, exhausted])

  // Both layers stay mounted inside one width-animating Panel and cross-fade,
  // per the canvas export's collapse transition (width .42s cubic-bezier +
  // content opacity/shift, rail fading in with a .1s delay). `inert` keeps
  // the hidden layer out of the focus order and accessibility tree.
  return (
    <Panel
      side="left"
      collapsed={collapsed}
      widthPx={width}
      widthTransition={!draggingWidth}
      className="relative h-full overflow-hidden"
    >
      {/* Inner-edge drag handle: widen by dragging right, double-click resets
          to the export's 300. Hidden while collapsed — the rail has one width
          and the way back is the expand toggle. */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={width}
          title="Drag to resize · double-click to reset"
          onPointerDown={handleWidthPointerDown}
          onPointerMove={handleWidthPointerMove}
          onPointerUp={handleWidthPointerUp}
          onPointerCancel={handleWidthPointerUp}
          onDoubleClick={handleWidthReset}
          // `orbital-no-drag`: its top runs under the window's drag band (24a).
          className="orbital-no-drag absolute inset-y-0 right-0 z-20 w-2 cursor-col-resize touch-none hover:bg-[rgba(150,205,255,.08)]"
        />
      )}
      {/* The detail panel's top glint (1b), in the accent: the sidebar has
          no session to take a hue from. */}
      <TopGlint focused={windowFocused} />
      {/* Collapsed rail per canvas 1b: logo, expand toggle, divider, one hue
          dot per active session (solid while busy, hollow while idle). */}
      <div
        inert={!collapsed || undefined}
        className={[
          'absolute inset-y-0 left-0 flex w-14 flex-col items-center gap-3.5 py-[18px]',
          'transition-opacity duration-300',
          collapsed ? 'opacity-100 delay-100' : 'pointer-events-none opacity-0',
          // Only the layer on show opts its controls out of the drag band: the
          // faded one's boxes are still there, and would punch holes in it.
          collapsed ? 'orbital-band-controls' : '',
        ].join(' ')}
      >
        <Logo dimmed={!windowFocused} />
        <IconButton
          label="Expand sidebar"
          title={`Expand sidebar · ${shortcutLabel('global.sidebar')}`}
          glyph="»"
          onClick={() => setSidebarCollapsed(false)}
        />
        <span aria-hidden className="h-px w-5 bg-panel-border" />
        {active.slice(0, 8).map((s) => (
          <RowDot key={s.id} hue={rowHue(s, tags)} status={s.status} size={8} />
        ))}
        {/* Rail settings button (1a): 30px, and the only icon button here that
            is not one of `IconButton`'s 28px text glyphs. 11d's stats glyph
            sits with it at the foot of the rail, mirroring the footer order. */}
        <span className="flex-1" />
        <StatsLink size="rail" />
        <LimitsLink size="rail" />
        <button
          type="button"
          aria-label="Open settings"
          title={`Settings · ${shortcutLabel('global.settings')}`}
          onClick={() => setDialog('settings')}
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg border border-panel-border bg-[rgba(150,205,255,.05)] transition-colors duration-[180ms] hover:bg-[rgba(150,205,255,.13)]"
        >
          <SettingsRing size={12} />
        </button>
      </div>

      <div
        inert={collapsed || undefined}
        // Inline, not `w-[300px]`: the content layer is absolutely positioned
        // so it can cross-fade against the rail, which means it does not
        // inherit the Panel's live width and has to be given it. It keeps that
        // width while collapsed — the shell clips it, and that clipping IS the
        // collapse transition.
        style={{ width }}
        className={[
          'absolute inset-y-0 left-0 flex flex-col',
          'transition-[opacity,transform] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]',
          // Export shifts the fading layer 24px, not 12 — the extra travel is
          // what makes the crossfade read as the panel sliding away.
          collapsed ? 'pointer-events-none -translate-x-6 opacity-0' : 'translate-x-0 opacity-100',
        ].join(' ')}
      >
      {/* Every padding below is the export's own rhythm (1a), not a uniform
          grid: 18px gutters for headers/footer, 14px for the search and
          chips, 8px for the row lists so selected rows bleed toward the edge. */}
      {/* In the windowed desktop app the traffic lights sit on this row
          (canvas `Feature - Main window chrome` 24a): it trades top padding
          for left, so the mark and the wordmark move right of the lights and
          the row keeps its height and centre line. Full screen has no lights
          and gets 1a's padding back (24c). */}
      <div
        className={[
          'flex items-center gap-2.5 pb-3.5',
          windowBand ? 'pt-2 pr-[18px] pl-20' : 'px-[18px] pt-[18px]',
          collapsed ? '' : 'orbital-band-controls',
        ].join(' ')}
      >
        <Logo dimmed={!windowFocused} />
        <span className="text-[13px] font-bold tracking-[0.22em] text-text-bright">ORBITAL</span>
        <span className="flex-1" />
        <IconButton
          label="Collapse sidebar"
          title={`Collapse sidebar · ${shortcutLabel('global.sidebar')}`}
          glyph="«"
          onClick={() => setSidebarCollapsed(true)}
        />
      </div>

      {/* Search field verbatim from canvas 1a: dark inset container with a ⌕ glyph and a ⌘K keycap. */}
      <label className="mx-3.5 flex items-center gap-2 rounded-[9px] border border-panel-border bg-[rgba(4,8,16,.6)] px-3 py-[9px] text-[13px] text-[rgba(160,190,225,.6)]">
        <span aria-hidden className="text-sm">⌕</span>
        <input
          id={SEARCH_INPUT_ID}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sessions"
          aria-label="Search sessions"
          className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-text-bright outline-none placeholder:text-[rgba(160,190,225,.6)]"
        />
        <span className="rounded border border-[rgba(150,205,255,.18)] px-[5px] py-0.5 font-mono text-[10px] text-text-muted">
          {shortcutLabel('global.search')}
        </span>
      </label>

      <div
        className="flex flex-wrap gap-1.5 px-3.5 pt-3 pb-1.5"
        role="group"
        aria-label="Filter by tag"
      >
        <Chip label="All" active={filterTagId === 'all'} onClick={() => setFilterTag('all')} />
        {tags.map((tag) => (
          <Chip
            key={tag.id}
            label={tag.name}
            hue={tag.hue}
            active={filterTagId === tag.id}
            onClick={() => setFilterTag(tag.id)}
          />
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* PINNED above ACTIVE (4a). Absent entirely while nothing is
            pinned — an empty section would be a standing reminder of a
            feature you are not using. A live pinned row keeps its blinking
            dot, weight and WORKING/IDLE label: only its section changed. */}
        {pinned.length > 0 && (
          <>
            <SectionHeading label="PINNED" count={pinned.length} first />
            <ul className="flex flex-col gap-0.5 px-2" aria-label="Pinned sessions">
              {pinned.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  tags={tags}
                  selected={s.id === selectedId}
                  detached={detachedIds.includes(s.id)}
                  onSelect={handleSelect}
                  onTogglePin={handleTogglePin}
                  history={s.status === 'ended'}
                  right={
                    s.status === 'ended' ? (
                      <span className="font-mono text-[10px] text-text-muted">
                        {timeAgo(s.lastAt ?? Date.now())}
                      </span>
                    ) : (
                      <RowStatus session={s} />
                    )
                  }
                />
              ))}
            </ul>
          </>
        )}

        {/* 3a puts the origin filter in this heading rather than in a chip
            row of its own: it narrows the list the heading counts. */}
        <SectionHeading label="ACTIVE" count={active.length} first={pinned.length === 0}>
          <span className="flex-1" />
          <Select
            variant="ghost"
            active={sourceFilter !== 'all'}
            aria-label="Filter sessions by origin"
            options={originItems}
            value={sourceFilter}
            onChange={setSourceFilter}
          />
        </SectionHeading>
        <ul className="flex flex-col gap-0.5 px-2" aria-label="Active sessions">
          {active.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              tags={tags}
              selected={s.id === selectedId}
              detached={detachedIds.includes(s.id)}
              onSelect={handleSelect}
              onTogglePin={handleTogglePin}
              right={<RowStatus session={s} />}
            />
          ))}
        </ul>

        <SectionHeading label="HISTORY" headingRef={historyHeadingRef}>
          <span className="flex-1" />
          <span className="tracking-[0.04em]" title="sorted by most recent">
            recent ▾
          </span>
        </SectionHeading>
        <ul className="flex flex-col gap-0.5 px-2" aria-label="Session history">
          {history.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              tags={tags}
              selected={s.id === selectedId}
              detached={detachedIds.includes(s.id)}
              onSelect={handleSelect}
              onTogglePin={handleTogglePin}
              history
              right={
                <span className="font-mono text-[10px] text-text-muted">
                  {timeAgo(s.lastAt ?? Date.now())}
                </span>
              }
            />
          ))}
        </ul>

        <div ref={sentinelRef} data-testid="sidebar-sentinel" aria-hidden className="h-px" />
      </div>

      <div className="flex items-center gap-2 border-t border-[rgba(150,205,255,.1)] px-[18px] py-3 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.55)]">
        {/* 4a's footer carries the pin count beside the session count, and
            only while there is one to carry. */}
        <span>
          {visible.length} sessions
          {pinned.length > 0 && ` · ${pinned.length} pinned`}
        </span>
        {/* 11d groups the footer's two app-level destinations at the
            trailing edge: the count stays left, then a spacer, then stats
            immediately before SETTINGS, in the order the canvas draws them.
            The pair has to touch to read as one — `justify-between` spread
            all three and stranded stats mid-footer. */}
        <span className="flex-1" />
        <StatsLink size="footer" />
        <LimitsLink size="footer" />
        {/* Settings keeps the word; tags & rules moved inside the dialog as a
            section, so the link that used to sit here would land on the same
            screen. */}
        <button
          type="button"
          aria-label="Open settings"
          title={`Settings · ${shortcutLabel('global.settings')}`}
          onClick={() => setDialog('settings')}
          className="flex h-6 items-center gap-[7px] rounded-[7px] border border-panel-border bg-[rgba(150,205,255,.05)] px-[9px] tracking-[0.14em] text-[rgba(200,220,245,.8)] transition-colors duration-[180ms] hover:bg-[rgba(150,205,255,.12)] hover:text-text-bright"
        >
          <SettingsRing size={9} />
          SETTINGS
        </button>
      </div>
      </div>
    </Panel>
  )
}
