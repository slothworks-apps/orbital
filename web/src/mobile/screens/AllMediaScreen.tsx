import { useEffect, useMemo, useRef, useState } from 'react'
import { allMediaOrder, allMediaSections, keyedMedia } from '../../lib/allMedia'
import { tagColor, type MediaItem } from '../../lib/types'
import { useAllMedia } from '../../store/allMedia'
import { ALL_SESSIONS_MEDIA, useHideTool } from '../../store/media'
import { useOrbital } from '../../store/store'
import { MediaPager, type PhoneMediaPool } from '../files/MediaPager'
import { useMobile } from '../state'
import { MobileScreen } from '../ui'
import { PhoneTile } from './MediaScreen'

/** canvas 24g: the chip's two looks, the switch off and on. */
const CHIP_OFF = 'border-[rgba(150,205,255,.14)] bg-transparent text-[rgba(200,220,245,.75)]'
const CHIP_ON = 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-[#e8eef8]'

/**
 * The gallery of every session on the phone (spec
 * 2026-10-13-all-sessions-gallery-design § Phone): reached from the list's
 * header, the session gallery's tiles grouped under their session, newest
 * activity first, a page at a time as it scrolls. A tap opens the viewer,
 * which pages across everything loaded and can open the item's session.
 * No counts and nothing arriving on its own (`docs/why-orbital.md`).
 */
export function AllMediaScreen() {
  const goBack = useMobile((s) => s.goBack)
  const openSession = useMobile((s) => s.openSession)
  const viewing = useMobile((s) => s.galleryItem)
  const view = useMobile((s) => s.viewGalleryItem)
  const tags = useOrbital((s) => s.tags)
  const [tagIds, setTagIds] = useState<number[]>([])
  const [hideTool, setHideTool] = useHideTool(ALL_SESSIONS_MEDIA)
  const list = useAllMedia(tagIds)
  const keyed = useMemo(() => keyedMedia(list.items), [list.items])
  const sections = useMemo(() => allMediaSections(keyed, hideTool), [keyed, hideTool])
  const order = useMemo(() => allMediaOrder(keyed), [keyed])
  const byKey = useMemo(() => new Map(keyed.map((item) => [item.id, item])), [keyed])
  const anyTool = keyed.some((item) => item.source === 'tool')

  const pool: PhoneMediaPool = {
    sessionOf: (item) => byKey.get(item.id)?.sessionId ?? '',
    titleOf: (item) => byKey.get(item.id)?.sessionTitle || 'Untitled session',
    hideTool,
    onOpenSession: (item) => {
      const sessionId = byKey.get(item.id)?.sessionId
      if (sessionId) openSession(sessionId)
    },
  }

  // Infinite scroll, as on the Mac: the foot in view asks for the next page,
  // and asks again after a short page while it is still in view.
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
      { root: scroller.current, rootMargin: '600px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [more])
  useEffect(() => {
    if (footSeen.current && !done && !failed && pages > 0) more()
  }, [pages, done, failed, more])

  const current = viewing !== null ? byKey.get(viewing) : undefined

  const header = (
    <div className="border-b border-[rgba(150,205,255,.1)] bg-[rgba(8,12,22,.9)] px-1.5 pb-2.5">
      <div className="flex h-13 items-center gap-1">
        <button
          type="button"
          aria-label="Back"
          onClick={() => goBack()}
          className="grid h-11 w-11 shrink-0 place-items-center text-[28px] leading-none text-[rgba(220,235,255,.85)]"
        >
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-[16px] font-bold">Media</h1>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">All sessions</div>
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto px-2">
        <FilterChip active={tagIds.length === 0} onClick={() => setTagIds([])} label="All" />
        {tags.map((tag) => (
          <FilterChip
            key={tag.id}
            active={tagIds.includes(tag.id)}
            // One tag at a time; tapping the one shown goes back to All.
            onClick={() => setTagIds(tagIds.length === 1 && tagIds[0] === tag.id ? [] : [tag.id])}
            label={tag.name}
            hue={tag.hue}
          />
        ))}
        {anyTool && (
          <button
            type="button"
            aria-pressed={hideTool}
            onClick={() => setHideTool(!hideTool)}
            className={['min-h-9 shrink-0 rounded-full border px-3.5 font-mono text-[11.5px]', hideTool ? CHIP_ON : CHIP_OFF].join(' ')}
          >
            ⚙ Hide tool images
          </button>
        )}
      </div>
    </div>
  )

  const open = (item: MediaItem) => view(item.id)

  return (
    <div className="relative h-full">
    <MobileScreen header={header} divider={false} scroll={false}>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-1">
        <div className="grid auto-rows-max grid-cols-3 gap-[3px]">
          {sections.map((section, i) => (
            <SectionTiles key={`${section.sessionId}:${i}`} section={section} first={i === 0} onOpen={open} />
          ))}
        </div>
        <div ref={foot} className="py-6 text-center font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
          {failed ? (
            <button
              type="button"
              onClick={more}
              className="min-h-11 rounded-[5px] border border-[rgba(150,205,255,.2)] px-2.5 text-[#e8eef8]"
            >
              Couldn’t load more · Try again
            </button>
          ) : done && sections.length === 0 && hideTool && anyTool ? (
            <button
              type="button"
              onClick={() => setHideTool(false)}
              className="min-h-11 rounded-[5px] border border-[rgba(150,205,255,.2)] px-2.5 text-[#e8eef8]"
            >
              Only tool images · Show tool images
            </button>
          ) : done && sections.length === 0 ? (
            tagIds.length ? 'No media in sessions with this tag.' : 'No media in any session yet.'
          ) : null}
        </div>
      </div>
    </MobileScreen>
    {/* The viewer over the grid, which stays mounted underneath so back finds it scrolled where it was. */}
    {current && (
      <div className="absolute inset-0 z-[5]">
        <MediaPager
          key={current.id}
          sessionId={current.sessionId}
          items={order}
          startId={current.id}
          onBack={() => view(null)}
          pool={pool}
        />
      </div>
    )}
    </div>
  )
}

function SectionTiles({
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
      <div className={['col-span-3 truncate px-1.5 font-mono text-[11px] text-[rgba(200,220,245,.75)]', first ? 'pb-1.5 pt-1' : 'pb-1.5 pt-4'].join(' ')}>
        {title}
      </div>
      {section.tiles.map((tile) => (
        <PhoneTile key={tile.key} sessionId={section.sessionId} tile={tile} onOpen={onOpen} session={title} />
      ))}
    </>
  )
}

function FilterChip({ active, onClick, label, hue }: { active: boolean; onClick: () => void; label: string; hue?: number }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'flex min-h-9 shrink-0 items-center gap-[7px] rounded-full border px-3.5 text-[13px] font-semibold',
        active ? CHIP_ON : CHIP_OFF,
      ].join(' ')}
    >
      {hue !== undefined && <span aria-hidden className="block h-2 w-2 rounded-full" style={{ background: tagColor(hue) }} />}
      {label}
    </button>
  )
}
