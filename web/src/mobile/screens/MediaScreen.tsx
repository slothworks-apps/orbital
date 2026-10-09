import { useState } from 'react'
import { mediaTiles, toolMediaCount, type MediaTile } from '../../lib/media'
import type { MediaItem } from '../../lib/types'
import { GoneMark, MediaPicture, isGone } from '../../panels/MediaParts'
import { useHideTool, useSessionMedia } from '../../store/media'
import { useOrbital } from '../../store/store'
import { pushedTop, useMobile } from '../state'
import { MobileScreen } from '../ui'

/**
 * A session's media on the phone (canvas `Feature - Media` 24g gallery, 24h
 * C; spec 2026-10-09-session-media-design § Phone): pushed over the session
 * from the ⋯ sheet, newest first in an edge-to-edge grid of three, tool runs
 * stacked as on the Mac, and the same per-session Hide tool images switch.
 * A tile opens the viewer on its item, which pages on through the rest.
 */
export function MediaScreen() {
  const item = useMobile((s) => pushedTop(s, 'media'))
  return item ? <Gallery sessionId={item.sessionId} /> : null
}

/** canvas 24g: the chip's two looks, the switch off and on. */
const CHIP_OFF = 'border-[rgba(150,205,255,.14)] bg-transparent text-[rgba(200,220,245,.75)]'
const CHIP_ON = 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-[#e8eef8]'

function countLine(shown: number, tool: number, hideTool: boolean): string {
  if (hideTool && tool > 0) return `${shown} shown · ${tool} tool hidden`
  return `${shown} ${shown === 1 ? 'item' : 'items'}`
}

function Gallery({ sessionId }: { sessionId: string }) {
  // Watching: a message arriving while the gallery is open asks for the list again.
  const items = useSessionMedia(sessionId, true) ?? []
  const title = useOrbital((s) => s.sessions[sessionId]?.title) || 'Untitled session'
  const goBack = useMobile((s) => s.goBack)
  const openFile = useMobile((s) => s.openFile)
  const [hideTool, setHideTool] = useHideTool(sessionId)
  const tiles = mediaTiles(items, hideTool)
  const tool = toolMediaCount(items)
  const shown = hideTool ? items.length - tool : items.length

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
    // canvas 24g: 52px title row, then the chip row, 10px above the rule.
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
            {title} · {countLine(shown, tool, hideTool)}
          </div>
        </div>
      </div>
      {tool > 0 && (
        <div className="px-2">
          <button
            type="button"
            aria-pressed={hideTool}
            onClick={() => setHideTool(!hideTool)}
            className={['min-h-9 rounded-full border px-3.5 font-mono text-[11.5px]', hideTool ? CHIP_ON : CHIP_OFF].join(' ')}
          >
            ⚙ Hide tool images
          </button>
        </div>
      )}
    </div>
  )

  return (
    <MobileScreen header={header} divider={false} scroll={false}>
      {tiles.length === 0 && hideTool && tool > 0 ? (
        // 24h C: the one real empty state — there is media, and the switch hides all of it.
        <div className="flex flex-1 flex-col items-center justify-center gap-2 font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
          <span>Only tool images so far · {tool} hidden</span>
          <button
            type="button"
            onClick={() => setHideTool(false)}
            className="min-h-11 rounded-[5px] border border-[rgba(150,205,255,.2)] px-2.5 text-[#e8eef8]"
          >
            Show tool images
          </button>
        </div>
      ) : (
        // canvas 24g: three columns edge to edge, 3px apart, 4px from the screen's edges.
        <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-3 gap-[3px] overflow-y-auto p-1">
          {tiles.map((tile) => (
            <PhoneTile key={tile.key} sessionId={sessionId} tile={tile} onOpen={open} />
          ))}
        </div>
      )}
    </MobileScreen>
  )
}

/**
 * canvas 24g: a square crop with a hairline drawn inside it and no radius,
 * the tag bottom-left — ⚙, ⚙ ×n for a stack, PDF · pages — and NOT ON DISK
 * for a named file that is gone (24f B).
 */
function PhoneTile({ sessionId, tile, onOpen }: { sessionId: string; tile: MediaTile; onOpen: (item: MediaItem) => void }) {
  const { cover, first, count } = tile
  const [goneId, setGoneId] = useState<string | null>(null)
  const [pages, setPages] = useState<number | null>(null)
  const gone = isGone(cover) || goneId === cover.id
  const stacked = count > 1
  const tag =
    cover.source === 'tool' ? (stacked ? `⚙ ×${count}` : '⚙') : cover.kind === 'pdf' && !gone ? (pages ? `PDF · ${pages}` : 'PDF') : null
  const title = stacked ? `${count} tool images` : (cover.path ?? (cover.source === 'tool' ? 'Tool image' : 'Attached image'))
  return (
    <button
      type="button"
      aria-label={`Open ${title}`}
      onClick={() => onOpen(first)}
      className={[
        'relative aspect-square w-full overflow-hidden bg-[rgba(4,8,16,.6)] p-0',
        gone ? 'flex flex-col items-center justify-center gap-[5px]' : 'block',
      ].join(' ')}
    >
      {gone ? (
        <GoneMark size="tile" />
      ) : (
        <MediaPicture sessionId={sessionId} item={cover} onPages={setPages} onGone={() => setGoneId(cover.id)} />
      )}
      {/* Over the picture, so the hairline is not hidden under it. */}
      <span aria-hidden className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgba(150,205,255,.1)]" />
      {tag && (
        <span className="absolute bottom-[5px] left-[5px] rounded-[3px] bg-[rgba(5,7,13,.85)] px-[5px] py-px font-mono text-[10px] leading-[1.4] text-[rgba(200,220,245,.85)]">
          {tag}
        </span>
      )}
    </button>
  )
}
