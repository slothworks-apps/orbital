import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { allMediaOrder, allMediaSections, keyedMedia, pickTag } from '../lib/allMedia'
import { shortcutLabel } from '../lib/keymap'
import type { AllMediaItem, MediaItem } from '../lib/types'
import { useAllMedia } from '../store/allMedia'
import { ALL_SESSIONS_MEDIA, useHideTool, useMedia } from '../store/media'
import { useOrbital } from '../store/store'
import { Chip } from '../ui/Chip'
import { EscapeBoundary, useEscapeLayer } from '../ui/escapeLayer'
import { HideToolChip, MediaTileButton } from './MediaParts'
import { MediaViewer, type MediaPool } from './MediaViewer'

/**
 * The gallery of every session (spec 2026-10-13-all-sessions-gallery-design):
 * a full-window layer over the map, opened from the sidebar's ▦ or ⌘⇧A. The
 * grid is the session gallery's tiles, grouped under the session they belong
 * to, newest activity first; it loads a page at a time as it scrolls. A tile
 * opens the maximised view, which pages across everything loaded and can
 * open the item's session.
 *
 * Calm (`docs/why-orbital.md`): no counts, no "new" marker, and nothing
 * arrives while it is open — what loaded stays put until the next open.
 */
export function AllMediaGallery() {
  const open = useMedia((s) => s.allOpen)
  return open ? createPortal(<Body />, document.body) : null
}

function Body() {
  const close = () => useMedia.getState().setAllOpen(false)
  useEscapeLayer(true, close)
  return (
    <EscapeBoundary>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Media of every session"
        className="orbital-no-drag fixed inset-0 z-40 flex flex-col bg-[rgba(2,4,9,.92)] backdrop-blur-[6px]"
      >
        <Gallery onClose={close} />
      </div>
    </EscapeBoundary>
  )
}

function Gallery({ onClose }: { onClose: () => void }) {
  const tags = useOrbital(useShallow((s) => s.tags))
  const select = useOrbital((s) => s.select)
  const [tagIds, setTagIds] = useState<number[]>([])
  const [hideTool, setHideTool] = useHideTool(ALL_SESSIONS_MEDIA)
  const list = useAllMedia(tagIds)
  const keyed = useMemo(() => keyedMedia(list.items), [list.items])
  const sections = useMemo(() => allMediaSections(keyed, hideTool), [keyed, hideTool])
  const order = useMemo(() => allMediaOrder(keyed), [keyed])
  const byKey = useMemo(() => new Map(keyed.map((item) => [item.id, item])), [keyed])
  const anyTool = keyed.some((item) => item.source === 'tool')
  const [viewing, setViewing] = useState<string | null>(null)

  const pool: MediaPool = {
    items: order,
    sessionOf: (item) => byKey.get(item.id)?.sessionId ?? '',
    titleOf: (item) => shortTitle(byKey.get(item.id)?.sessionTitle || 'Untitled session'),
    hideTool,
    setHideTool,
    onOpenSession: (item) => {
      const sessionId = byKey.get(item.id)?.sessionId
      if (!sessionId) return
      void select(sessionId)
      onClose()
    },
  }

  // Infinite scroll: ask for the next page while the foot of the grid is in
  // view — again after a page that came back short, since the foot is then
  // still in view and the observer will not fire a second time.
  const scroller = useRef<HTMLDivElement>(null)
  const foot = useRef<HTMLDivElement>(null)
  const footSeen = useRef(false)
  const { more, done, failed, pages } = list
  useEffect(() => {
    const el = foot.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        footSeen.current = entries.some((e) => e.isIntersecting)
        if (footSeen.current) more()
      },
      { root: scroller.current, rootMargin: '400px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [more])
  useEffect(() => {
    if (footSeen.current && !done && !failed && pages > 0) more()
  }, [pages, done, failed, more])

  return (
    <>
      {/* The header: title, the tag filter, the switch and ×. */}
      <div className="flex flex-none items-center gap-3 border-b border-[rgba(150,205,255,.08)] px-7 pb-3 pt-7">
        <h2 className="flex-none font-mono text-[10.5px] tracking-[0.14em] text-[rgba(160,190,225,.75)]">
          MEDIA · ALL SESSIONS
        </h2>
        <div role="group" aria-label="Filter by tag" className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          <Chip label="All" active={tagIds.length === 0} onClick={() => setTagIds([])} />
          {tags.map((tag) => (
            <Chip
              key={tag.id}
              label={tag.name}
              hue={tag.hue}
              active={tagIds.includes(tag.id)}
              title="⌘-click to add or remove"
              onClick={(e) => setTagIds(pickTag(tagIds, tag.id, e.metaKey || e.ctrlKey))}
            />
          ))}
        </div>
        {anyTool && <HideToolChip on={hideTool} onToggle={() => setHideTool(!hideTool)} />}
        <button
          type="button"
          aria-label="Close"
          title={`Close · ${shortcutLabel('global.media')}`}
          onClick={onClose}
          className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] border border-[rgba(150,205,255,.2)] bg-[rgba(10,14,24,.7)] text-base text-text-bright transition-colors hover:border-[rgba(150,205,255,.45)]"
        >
          ×
        </button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-7 py-4">
        <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))' }}>
          {sections.map((section, i) => (
            <Section
              key={`${section.sessionId}:${i}`}
              section={section}
              first={i === 0}
              onOpen={(item) => setViewing(item.id)}
            />
          ))}
        </div>
        <div ref={foot} className="py-6 text-center font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">
          {failed ? (
            <button
              type="button"
              onClick={more}
              className="rounded-[5px] border border-[rgba(150,205,255,.2)] px-2.5 py-1 text-[#e8eef8] transition-colors duration-[160ms] hover:border-[rgba(150,205,255,.45)]"
            >
              Couldn’t load more · Try again
            </button>
          ) : done && sections.length === 0 && hideTool && anyTool ? (
            <button
              type="button"
              onClick={() => setHideTool(false)}
              className="rounded-[5px] border border-[rgba(150,205,255,.2)] px-2.5 py-1 text-[#e8eef8] transition-colors duration-[160ms] hover:border-[rgba(150,205,255,.45)]"
            >
              Only tool images · Show tool images
            </button>
          ) : done && sections.length === 0 ? (
            tagIds.length ? 'No media in sessions with these tags.' : 'No media in any session yet.'
          ) : null}
        </div>
      </div>

      <MediaViewer
        open={viewing !== null}
        sessionId={null}
        target={viewing ? { kind: 'item', id: viewing } : null}
        pool={pool}
        onClose={() => setViewing(null)}
      />
    </>
  )
}

/** One session's run of tiles: its name across the grid, then its tiles. */
function Section({
  section,
  first,
  onOpen,
}: {
  section: ReturnType<typeof allMediaSections>[number]
  first: boolean
  onOpen: (item: MediaItem) => void
}) {
  const title = section.title || 'Untitled session'
  return (
    <>
      <div
        className={[
          'col-span-full truncate font-mono text-[10.5px] tracking-[0.04em] text-[rgba(200,220,245,.75)]',
          first ? 'pb-1' : 'pb-1 pt-4',
        ].join(' ')}
      >
        {title}
      </div>
      {section.tiles.map((tile) => (
        <MediaTileButton
          key={tile.key}
          sessionId={section.sessionId}
          tile={tile}
          variant="gallery"
          onOpen={onOpen}
          title={`${title} · ${tileTitle(tile.cover as AllMediaItem, tile.count)}`}
        />
      ))}
    </>
  )
}

function tileTitle(cover: AllMediaItem, count: number): string {
  if (count > 1) return `${count} tool images`
  return cover.path ?? (cover.source === 'tool' ? 'Tool image' : 'Attached image')
}

/** The caption's session name: a first prompt can run to a paragraph, and the caption is one line. */
function shortTitle(title: string): string {
  return title.length > 60 ? `${title.slice(0, 59)}…` : title
}
