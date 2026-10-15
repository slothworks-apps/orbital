import { useState } from 'react'
import {
  MEDIA_SOURCES,
  SOURCE_LABELS,
  mediaClock,
  mediaCount,
  mediaTileCaption,
  mediaTiles,
  sourceCounts,
  sourceDetail,
  sourceShown,
  sourcesSummary,
  type MediaSourceKey,
  type MediaTile,
} from '../../lib/media'
import type { MediaItem } from '../../lib/types'
import { GoneMark, MediaPicture, NothingShown, TileCaption, isGone, tileTag, tileTitle } from '../../panels/MediaParts'
import { useHiddenSources, useSessionMedia } from '../../store/media'
import { useOrbital } from '../../store/store'
import { pushedTop, useMobile } from '../state'
import { BottomSheet, MobileScreen } from '../ui'

/**
 * A session's media on the phone (canvas `Feature - Media` 24g gallery;
 * `Feature - Media tiles` 26c; spec 2026-10-09-session-media-design §
 * Phone): pushed over the session from the ⋯ sheet, newest first in an
 * edge-to-edge grid of three, whole images with a caption under each, tool
 * runs stacked as on the Mac, and the same per-session Sources filter in a
 * sheet. A tile opens the viewer on its item, which pages on through the rest.
 */
export function MediaScreen() {
  const item = useMobile((s) => pushedTop(s, 'media'))
  return item ? <Gallery sessionId={item.sessionId} /> : null
}

/** canvas 26c: the Sources button's two looks, everything and narrowed. */
const CHIP_REST = 'border-[rgba(150,205,255,.14)] bg-transparent text-[rgba(200,220,245,.75)]'
const CHIP_ACTIVE = 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-[#e8eef8]'

function Gallery({ sessionId }: { sessionId: string }) {
  // Watching: a message arriving while the gallery is open asks for the list again.
  const items = useSessionMedia(sessionId, true) ?? []
  const title = useOrbital((s) => s.sessions[sessionId]?.title) || 'Untitled session'
  const goBack = useMobile((s) => s.goBack)
  const openFile = useMobile((s) => s.openFile)
  const [hidden, setHidden] = useHiddenSources(sessionId)
  const [sheet, setSheet] = useState(false)
  const tiles = mediaTiles(items, hidden)
  const summary = sourcesSummary(items, hidden)

  const open = (m: MediaItem) =>
    openFile({
      sessionId,
      path: m.path ?? null,
      line: null,
      messageId: m.messageId,
      mediaId: m.id,
      ...(m.ref ? { ref: m.ref } : {}),
      ...(m.cwd ? { cwd: m.cwd } : {}),
    })

  const header = (
    // canvas 26c: 52px title row, then the Sources row, 10px above the rule.
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
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
            {title} · {mediaCount(summary)}
          </div>
        </div>
      </div>
      {items.length > 0 && (
        <div className="px-2">
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setSheet(true)}
            className={[
              'inline-flex min-h-9 items-center gap-2 rounded-full border px-3.5 font-mono text-[11.5px]',
              summary.filtered ? CHIP_ACTIVE : CHIP_REST,
            ].join(' ')}
          >
            {summary.label}
            <span aria-hidden className="text-[9px] opacity-80">
              ▾
            </span>
          </button>
        </div>
      )}
    </div>
  )

  return (
    <MobileScreen header={header} divider={false} scroll={false}>
      {tiles.length === 0 && items.length > 0 ? (
        <NothingShown hidden={items.length} onShowAll={() => setHidden([])} className="flex-1" />
      ) : (
        // canvas 26c: three columns edge to edge, 3px apart across, 10px down for the captions.
        <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-3 gap-x-[3px] gap-y-2.5 overflow-y-auto px-1 py-2">
          {tiles.map((tile) => (
            <PhoneTile key={tile.key} sessionId={sessionId} tile={tile} onOpen={open} />
          ))}
        </div>
      )}
      {sheet && <SourcesSheet items={items} hidden={hidden} onChange={setHidden} onClose={() => setSheet(false)} />}
    </MobileScreen>
  )
}

/**
 * canvas 26c: the Sources sheet. It stays open while you toggle and the
 * grid updates behind it; Show all is the reset — no `only` on the phone.
 */
function SourcesSheet({
  items,
  hidden,
  onChange,
  onClose,
}: {
  items: readonly MediaItem[]
  hidden: readonly MediaSourceKey[]
  onChange: (hidden: MediaSourceKey[]) => void
  onClose: () => void
}) {
  const counts = sourceCounts(items)
  const summary = sourcesSummary(items, hidden)
  const toggle = (key: MediaSourceKey) =>
    onChange(hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key])
  return (
    <BottomSheet label="Show images from" onDismiss={onClose}>
      <div className="pb-[26px]">
        <div className="flex items-center px-2.5 pb-2 pt-0.5 font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">
          <span className="flex-1">SHOW IMAGES FROM</span>
          <span className="tracking-[0.04em]">{mediaCount(summary)}</span>
        </div>
        {MEDIA_SOURCES.map((key) => {
          const empty = counts[key] === 0
          const on = sourceShown(key, hidden, counts) && !empty
          const detail = sourceDetail(key, items)
          return (
            <button
              key={key}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={empty}
              onClick={() => toggle(key)}
              className={[
                'flex min-h-13 w-full items-center gap-3 rounded-[10px] px-2.5 text-left text-[15px]',
                on ? 'text-[#e8eef8]' : 'text-[rgba(160,190,225,.6)]',
              ].join(' ')}
            >
              {key === 'subagent' && (
                <span aria-hidden className="h-2 w-2 flex-none rounded-full border-[1.4px] border-current" />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span>{SOURCE_LABELS[key]}</span>
                {detail && <span className="truncate font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">{detail}</span>}
              </span>
              <span className="font-mono text-[11px] text-[rgba(160,190,225,.6)]">{counts[key]}</span>
              <span
                aria-hidden
                className={[
                  'grid h-[22px] w-[22px] flex-none place-items-center rounded-[6px] border text-[13px] text-[oklch(85%_.12_205)]',
                  on
                    ? 'border-[oklch(85%_.12_205_/_.6)] bg-[oklch(85%_.12_205_/_.12)]'
                    : 'border-[rgba(150,205,255,.2)] bg-transparent',
                ].join(' ')}
              >
                {on ? '✓' : ''}
              </span>
            </button>
          )
        })}
        <div className="mx-2.5 my-1.5 h-px bg-[rgba(150,205,255,.1)]" />
        <button
          type="button"
          disabled={!summary.filtered}
          onClick={() => onChange([])}
          className={[
            'flex min-h-13 w-full items-center rounded-[10px] px-2.5 text-left text-[15px]',
            summary.filtered ? 'text-[#e8eef8]' : 'text-[rgba(160,190,225,.4)]',
          ].join(' ')}
        >
          Show all
        </button>
      </div>
    </BottomSheet>
  )
}

/**
 * canvas 26c: the Mac's tile at the phone's size — the whole image in a
 * square with a hairline and a small radius, the tag bottom-left, the time
 * top-right, NOT ON DISK for a named file that is gone (24f B), and the
 * caption under it.
 */
function PhoneTile({ sessionId, tile, onOpen }: { sessionId: string; tile: MediaTile; onOpen: (item: MediaItem) => void }) {
  const { cover, first, count } = tile
  const [goneId, setGoneId] = useState<string | null>(null)
  const [pages, setPages] = useState<number | null>(null)
  const gone = isGone(cover) || goneId === cover.id
  const tag = tileTag(cover, count, gone, pages)
  return (
    <button
      type="button"
      aria-label={`Open ${tileTitle(tile)}`}
      onClick={() => onOpen(first)}
      className="flex w-full min-w-0 flex-col gap-[5px] p-0 text-left"
    >
      <span
        className={[
          'relative aspect-square w-full overflow-hidden rounded-[3px] border border-[rgba(150,205,255,.1)] bg-[#070b14]',
          gone ? 'flex flex-col items-center justify-center gap-[5px]' : 'block',
        ].join(' ')}
      >
        {gone ? (
          <GoneMark size="tile" />
        ) : (
          <MediaPicture sessionId={sessionId} item={cover} fit="contain" onPages={setPages} onGone={() => setGoneId(cover.id)} />
        )}
        {tag && (
          <span className="absolute bottom-[5px] left-[5px] rounded-[3px] bg-[rgba(5,7,13,.85)] px-[5px] py-px font-mono text-[10px] leading-[1.4] text-[rgba(200,220,245,.85)]">
            {tag}
          </span>
        )}
        {!gone && (
          <span className="absolute right-[5px] top-1 font-mono text-[9.5px] text-[rgba(200,220,245,.6)]">
            {mediaClock(cover.ts)}
          </span>
        )}
      </span>
      <TileCaption caption={mediaTileCaption(tile)} className="text-[10.5px]" dot="h-[7px] w-[7px] border-[1.3px]" />
    </button>
  )
}
