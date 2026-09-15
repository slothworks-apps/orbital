import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital, visibleSessions } from '../store/store'
import { api } from '../lib/api'
import { tagColor } from '../lib/types'
import type { ApiSession, SessionSource, Tag } from '../lib/types'
import { Panel } from '../ui/Panel'
import { Chip } from '../ui/Chip'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { StatusDot } from '../ui/StatusDot'
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

const sourceOptions: Array<{ value: 'all' | SessionSource; label: string }> = [
  { value: 'all', label: 'all' },
  { value: 'terminal', label: 'terminal' },
  { value: 'web', label: 'web' },
]

/** Small color swatches for a row's tags — not a Chip (no label/interaction), so kept inline rather than stretching Chip to a dot-only mode. */
function TagDots({ tagIds, tags }: { tagIds: number[]; tags: Tag[] }) {
  const hues = tagIds
    .map((id) => tags.find((t) => t.id === id)?.hue)
    .filter((h): h is number => h !== undefined)

  if (hues.length === 0) return null

  return (
    <span className="flex shrink-0 items-center gap-1">
      {hues.map((hue, i) => (
        <span key={i} aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: tagColor(hue) }} />
      ))}
    </span>
  )
}

function SessionRow({
  session,
  tags,
  selected,
  onSelect,
  right,
}: {
  session: ApiSession
  tags: Tag[]
  selected: boolean
  onSelect: (id: string) => void
  right: ReactNode
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        aria-current={selected ? 'true' : undefined}
        className={[
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5',
          selected ? 'bg-white/10' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <StatusDot status={session.status} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-text-bright">{session.title}</span>
          <span className="block truncate font-mono text-[11px] text-text-muted">
            {shortenPath(session.cwd)}
          </span>
        </span>
        <TagDots tagIds={session.tagIds} tags={tags} />
        <span className="shrink-0">{right}</span>
      </button>
    </li>
  )
}

/**
 * Left rail per artboard 1a: wordmark + collapse toggle, search (⌘K),
 * tag/source filter chips, ACTIVE/HISTORY session lists with infinite
 * scroll, and a footer session count + "tags & rules" entry point.
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
  const totalLoaded = useOrbital((s) => s.order.length)

  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const [exhausted, setExhausted] = useState(false)

  const tagCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const s of visible) {
      for (const id of s.tagIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }, [visible])

  const active = useMemo(() => visible.filter((s) => s.status !== 'ended'), [visible])
  const history = useMemo(() => visible.filter((s) => s.status === 'ended'), [visible])

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

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const fetched = await api.listSessions({ offset: totalLoaded, limit: PAGE_SIZE })
      for (const session of fetched) {
        applySessionsEvent({ event: 'upsert', session })
      }
      if (fetched.length < PAGE_SIZE) setExhausted(true)
    } finally {
      loadingRef.current = false
    }
  }, [applySessionsEvent, totalLoaded])

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

  if (collapsed) {
    return (
      <Panel side="left" collapsed>
        <div className="flex h-full flex-col items-center gap-3 py-4">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Expand sidebar"
            onClick={() => setSidebarCollapsed(false)}
          >
            »
          </Button>
        </div>
      </Panel>
    )
  }

  return (
    <Panel side="left" className="flex h-full flex-col gap-4 overflow-hidden p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm font-bold tracking-[0.2em] text-text-bright">ORBITAL</span>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Collapse sidebar"
          onClick={() => setSidebarCollapsed(true)}
        >
          «
        </Button>
      </div>

      <div className="relative">
        <Input
          id={SEARCH_INPUT_ID}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search"
          aria-label="Search sessions"
          className="pr-9"
        />
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-text-muted">
          ⌘K
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by tag">
        <Chip label="All" active={filterTagId === 'all'} onClick={() => setFilterTag('all')} />
        {tags.map((tag) => (
          <Chip
            key={tag.id}
            label={`${tag.name} ${tagCounts.get(tag.id) ?? 0}`}
            hue={tag.hue}
            active={filterTagId === tag.id}
            onClick={() => setFilterTag(tag.id)}
          />
        ))}
      </div>

      <div className="flex gap-1.5" role="group" aria-label="Filter by source">
        {sourceOptions.map((opt) => (
          <Chip
            key={opt.value}
            label={opt.label}
            active={sourceFilter === opt.value}
            onClick={() => setSourceFilter(opt.value)}
          />
        ))}
      </div>

      <div className="-mx-1 flex-1 overflow-y-auto px-1">
        <h3 className="mb-1.5 font-mono text-[10px] tracking-[0.15em] text-text-muted">ACTIVE</h3>
        <ul className="flex flex-col gap-0.5" aria-label="Active sessions">
          {active.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              tags={tags}
              selected={s.id === selectedId}
              onSelect={handleSelect}
              right={<Badge variant="status" value={s.status} />}
            />
          ))}
        </ul>

        <h3 className="mb-1.5 mt-4 font-mono text-[10px] tracking-[0.15em] text-text-muted">HISTORY</h3>
        <ul className="flex flex-col gap-0.5" aria-label="Session history">
          {history.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              tags={tags}
              selected={s.id === selectedId}
              onSelect={handleSelect}
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

      <div className="flex items-center justify-between border-t border-panel-border pt-3 font-mono text-xs text-text-muted">
        <span>{visible.length} sessions</span>
        <button type="button" className="hover:text-text-bright" onClick={() => setDialog('tags')}>
          tags &amp; rules ›
        </button>
      </div>
    </Panel>
  )
}
