import { useState } from 'react'
import { mediaCountLine, mediaTiles, toolMediaCount } from '../lib/media'
import { useHideTool, useMedia } from '../store/media'
import { useEscapeLayer } from '../ui/escapeLayer'
import { HideToolChip, MediaTileButton, OnlyToolHidden } from './MediaParts'
import { MediaViewer } from './MediaViewer'

/**
 * The gallery (canvas `Feature - Media` 24d): the panel body switched from
 * Transcript to Media, with the header and the composer staying where they
 * are. Newest first, square crops, tool runs stacked. ← Transcript, Escape
 * or ▦ again go back, to the transcript as it was left — the panel keeps it
 * mounted underneath.
 *
 * `columns`: 3 in the docked panel, 5 in a detached window's wider body (24i).
 * The list is kept current by the header readout, which is watching while
 * the gallery is open.
 */
export function MediaGallery({ sessionId, columns }: { sessionId: string; columns: 3 | 5 }) {
  const items = useMedia((s) => s.lists[sessionId])
  const [hideTool, setHideTool] = useHideTool(sessionId)
  const [viewing, setViewing] = useState<string | null>(null)
  const close = () => useMedia.getState().setGallery(null)
  useEscapeLayer(true, close)

  const all = items ?? []
  const tiles = mediaTiles(all, hideTool)
  const tool = toolMediaCount(all)

  return (
    <div data-media-gallery className="flex h-full flex-col">
      {/* 24d: the switch row — ← Transcript · the count · the chip. */}
      <div className="flex items-center gap-2.5 border-b border-[rgba(150,205,255,.08)] px-[22px] py-2.5 font-mono text-[10.5px]">
        <button type="button" onClick={close} className="flex-none whitespace-nowrap text-[#e8eef8]">
          ← Transcript
        </button>
        <span aria-hidden className="text-[rgba(150,205,255,.25)]">
          ·
        </span>
        <span className="min-w-0 flex-1 truncate text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.6)]">
          {mediaCountLine(all, hideTool)}
        </span>
        {tool > 0 && <HideToolChip on={hideTool} onToggle={() => setHideTool(!hideTool)} />}
      </div>
      {tiles.length > 0 || !hideTool || tool === 0 ? (
        <div
          className="grid min-h-0 flex-1 auto-rows-max gap-1.5 overflow-y-auto px-[22px] py-3.5"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {tiles.map((tile) => (
            <MediaTileButton
              key={tile.key}
              sessionId={sessionId}
              tile={tile}
              variant="gallery"
              onOpen={(item) => setViewing(item.id)}
            />
          ))}
        </div>
      ) : (
        <OnlyToolHidden hidden={tool} onShow={() => setHideTool(false)} className="min-h-0 flex-1" />
      )}
      <MediaViewer
        open={viewing !== null}
        sessionId={sessionId}
        target={viewing ? { kind: 'item', id: viewing } : null}
        onClose={() => setViewing(null)}
      />
    </div>
  )
}
