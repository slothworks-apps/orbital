import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital, visibleSessions } from '../store/store'
import { api } from '../lib/api'
import { isReadOnly, tagColor } from '../lib/types'
import type { ApiSession, SessionSource, Tag } from '../lib/types'
import { Panel } from '../ui/Panel'
import { Chip } from '../ui/Chip'
import { Select } from '../ui/Select'
import { Logo } from '../ui/Logo'
import { timeAgo, shortenPath } from '../lib/format'

/** How many sessions `loadMore` asks for per infinite-scroll page. */
const PAGE_SIZE = 20

const SEARCH_INPUT_ID = 'sidebar-search'

/** True while focus sits in a text input/textarea/contenteditable — global
 * shortcuts should not fire there. Duplicated (not imported) from
 * `map/SpaceMap.tsx`, which doesn't export it — see task-10 report. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

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

/** First tag's hue drives a row's dot color, matching the map (canvas 1a). */
function rowHue(session: ApiSession, tags: Tag[]): number | undefined {
  for (const id of session.tagIds) {
    const tag = tags.find((t) => t.id === id)
    if (tag) return tag.hue
  }
  return tags.find((t) => t.is_default === 1)?.hue
}

/**
 * Row lead dot per canvas 1a: solid tag-hue disc for active sessions
 * (blinking + glowing while working), hollow hue ring for history rows.
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
  if (status === 'ended') {
    return (
      <span
        aria-hidden
        className="shrink-0 rounded-full border"
        style={{ ...box, borderColor: color, opacity: 0.6 }}
      />
    )
  }
  const busy = status === 'working' || status === 'needs_input'
  return (
    <span
      aria-hidden
      className={['shrink-0 rounded-full', busy ? 'orbital-pulse' : ''].filter(Boolean).join(' ')}
      style={{
        ...box,
        background: color,
        boxShadow: busy ? `0 0 8px ${color}` : undefined,
        opacity: busy ? 1 : 0.8,
      }}
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

function IconButton({
  label,
  glyph,
  onClick,
}: {
  label: string
  glyph: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] border border-panel-border text-sm text-[rgba(200,220,245,.7)] transition-colors hover:bg-white/5 hover:text-text-bright"
    >
      <span aria-hidden>{glyph}</span>
    </button>
  )
}

/** Mono uppercase status column per canvas 1a: hue-colored while working, muted otherwise. */
function RowStatus({ status, hue }: { status: ApiSession['status']; hue: number | undefined }) {
  const busy = status === 'working' || status === 'needs_input'
  const color = busy && hue !== undefined ? tagColor(hue) : undefined
  return (
    <span
      className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.08em]"
      style={{ color: color ?? 'rgba(160,190,225,.6)' }}
    >
      {status === 'needs_input' ? 'NEEDS INPUT' : status.toUpperCase()}
    </span>
  )
}

function SessionRow({
  session,
  tags,
  selected,
  onSelect,
  right,
  history = false,
}: {
  session: ApiSession
  tags: Tag[]
  selected: boolean
  onSelect: (id: string) => void
  right: ReactNode
  /** History rows sit a notch tighter and lighter than active ones (1a). */
  history?: boolean
}) {
  const hue = rowHue(session, tags)
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        aria-current={selected ? 'true' : undefined}
        className={[
          'flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors hover:bg-white/5',
          // 1a: 9px vertical on active rows, 8px on history rows.
          history ? 'py-2' : 'py-[9px]',
          selected
            ? 'border border-[rgba(150,205,255,.12)] bg-[rgba(150,205,255,.07)]'
            : 'border border-transparent',
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
            {!history && isReadOnly(session) && <ReadOnlyBadge />}
          </span>
          <span className="block truncate font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
            {shortenPath(session.cwd)}
          </span>
        </span>
        <span className="shrink-0">{right}</span>
      </button>
    </li>
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
  const filterTagId = useOrbital((s) => s.ui.filterTagId)
  const search = useOrbital((s) => s.ui.search)
  const sourceFilter = useOrbital((s) => s.ui.sourceFilter)
  const selectedId = useOrbital((s) => s.ui.selectedId)

  const setFilterTag = useOrbital((s) => s.setFilterTag)
  const setSearch = useOrbital((s) => s.setSearch)
  const setSourceFilter = useOrbital((s) => s.setSourceFilter)
  const setSidebarCollapsed = useOrbital((s) => s.setSidebarCollapsed)
  const setDialog = useOrbital((s) => s.setDialog)
  const select = useOrbital((s) => s.select)
  const applySessionsEvent = useOrbital((s) => s.applySessionsEvent)

  const tags = useOrbital(useShallow((s) => s.tags))
  const visible = useOrbital(useShallow(visibleSessions))

  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const [exhausted, setExhausted] = useState(false)

  // The origin filter narrows ACTIVE and the map; HISTORY ignores it. See
  // the ADR `origin-filter-scopes-to-map-and-active` — an ended terminal
  // session is not read-only, so the distinction has nothing to say there.
  const live = useMemo(() => visible.filter((s) => s.status !== 'ended'), [visible])
  const active = useMemo(
    () => (sourceFilter === 'all' ? live : live.filter((s) => s.source === sourceFilter)),
    [live, sourceFilter]
  )
  const history = useMemo(() => visible.filter((s) => s.status === 'ended'), [visible])

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

  // ⌘K focuses search — unless the user is already typing somewhere else
  // (a dialog field, say), in which case it's just a letter.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return
      const input = document.getElementById(SEARCH_INPUT_ID)
      if (isTypingTarget(e.target) && e.target !== input) return
      e.preventDefault()
      ;(input as HTMLInputElement | null)?.focus()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

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
    <Panel side="left" collapsed={collapsed} className="relative h-full overflow-hidden">
      {/* Collapsed rail per canvas 1b: logo, expand toggle, divider, one hue
          dot per active session (blinking while working). */}
      <div
        inert={!collapsed || undefined}
        className={[
          'absolute inset-y-0 left-0 flex w-14 flex-col items-center gap-3.5 py-[18px]',
          'transition-opacity duration-300',
          collapsed ? 'opacity-100 delay-100' : 'pointer-events-none opacity-0',
        ].join(' ')}
      >
        <Logo />
        <IconButton label="Expand sidebar" glyph="»" onClick={() => setSidebarCollapsed(false)} />
        <span aria-hidden className="h-px w-5 bg-panel-border" />
        {active.slice(0, 8).map((s) => (
          <RowDot key={s.id} hue={rowHue(s, tags)} status={s.status} size={8} />
        ))}
        {/* Rail settings button (1a): 30px, and the only icon button here that
            is not one of `IconButton`'s 28px text glyphs. */}
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Open settings"
          onClick={() => setDialog('settings')}
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg border border-panel-border bg-[rgba(150,205,255,.05)] transition-colors duration-[180ms] hover:bg-[rgba(150,205,255,.13)]"
        >
          <SettingsRing size={12} />
        </button>
      </div>

      <div
        inert={collapsed || undefined}
        className={[
          'absolute inset-y-0 left-0 flex w-[300px] flex-col',
          'transition-[opacity,transform] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]',
          // Export shifts the fading layer 24px, not 12 — the extra travel is
          // what makes the crossfade read as the panel sliding away.
          collapsed ? 'pointer-events-none -translate-x-6 opacity-0' : 'translate-x-0 opacity-100',
        ].join(' ')}
      >
      {/* Every padding below is the export's own rhythm (1a), not a uniform
          grid: 18px gutters for headers/footer, 14px for the search and
          chips, 8px for the row lists so selected rows bleed toward the edge. */}
      <div className="flex items-center gap-2.5 px-[18px] pt-[18px] pb-3.5">
        <Logo />
        <span className="text-[13px] font-bold tracking-[0.22em] text-text-bright">ORBITAL</span>
        <span className="flex-1" />
        <IconButton label="Collapse sidebar" glyph="«" onClick={() => setSidebarCollapsed(true)} />
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
          ⌘K
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
        {/* 3a puts the origin filter in this heading rather than in a chip
            row of its own: it narrows the list the heading counts. */}
        <h3 className="flex items-center gap-2 px-[18px] pt-3.5 pb-1.5 font-mono text-[10px] tracking-[0.18em] text-text-muted">
          ACTIVE <span className="tracking-normal text-accent">{active.length}</span>
          <span className="flex-1" />
          <Select
            variant="ghost"
            active={sourceFilter !== 'all'}
            aria-label="Filter sessions by origin"
            options={originItems}
            value={sourceFilter}
            onChange={setSourceFilter}
          />
        </h3>
        <ul className="flex flex-col gap-0.5 px-2" aria-label="Active sessions">
          {active.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              tags={tags}
              selected={s.id === selectedId}
              onSelect={handleSelect}
              right={<RowStatus status={s.status} hue={rowHue(s, tags)} />}
            />
          ))}
        </ul>

        <h3 className="flex items-center justify-between px-[18px] pt-[18px] pb-1.5 font-mono text-[10px] tracking-[0.18em] text-text-muted">
          HISTORY
          <span className="tracking-[0.04em]" title="sorted by most recent">
            recent ▾
          </span>
        </h3>
        <ul className="flex flex-col gap-0.5 px-2 opacity-75" aria-label="Session history">
          {history.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              tags={tags}
              selected={s.id === selectedId}
              onSelect={handleSelect}
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

      <div className="flex items-center justify-between gap-2 border-t border-[rgba(150,205,255,.1)] px-[18px] py-3 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.55)]">
        <span>{visible.length} sessions</span>
        {/* Settings is the footer's only entry point now — the canvas moved
            tags & rules inside the dialog as a section, so the link that used
            to sit here would land on the same screen. */}
        <button
          type="button"
          aria-label="Open settings"
          onClick={() => setDialog('settings')}
          className="flex items-center gap-[7px] rounded-[7px] border border-panel-border bg-[rgba(150,205,255,.05)] px-[9px] py-[5px] tracking-[0.14em] text-[rgba(200,220,245,.8)] transition-colors duration-[180ms] hover:bg-[rgba(150,205,255,.12)] hover:text-text-bright"
        >
          <SettingsRing size={9} />
          SETTINGS
        </button>
      </div>
      </div>
    </Panel>
  )
}
