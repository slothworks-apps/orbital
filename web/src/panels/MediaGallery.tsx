import { useState } from 'react'
import { mediaCountLine, mediaTiles } from '../lib/media'
import { useHiddenSources, useMedia } from '../store/media'
import { useEscapeLayer } from '../ui/escapeLayer'
import { MediaTileButton, NothingShown, SourcesButton } from './MediaParts'
import { MediaViewer } from './MediaViewer'

/**
 * The gallery (canvas `Feature - Media` 24d, `Feature - Media tiles` 26a):
 * the panel body switched from Transcript to Media, with the header and the
 * composer staying where they are. Newest first, whole images with a
 * caption under each, tool runs stacked, narrowed by Sources. ← Transcript, Escape
 * or ▦ again go back, to the transcript as it was left — the panel keeps it
 * mounted underneath.
 *
 * `columns`: 3 in the docked panel, 5 in a detached window's wider body (24i).
 * The list is kept current by the header readout, which is watching while
 * the gallery is open.
 */
export function MediaGallery({ sessionId, columns }: { sessionId: string; columns: 3 | 5 }) {
  const items = useMedia((s) => s.lists[sessionId])
  const [hidden, setHidden] = useHiddenSources(sessionId)
  const [viewing, setViewing] = useState<string | null>(null)
  const close = () => useMedia.getState().setGallery(null)
  useEscapeLayer(true, close)

  const all = items ?? []
  const tiles = mediaTiles(all, hidden)

  return (
    <div data-media-gallery className="flex h-full flex-col">
      {/* 26a: the switch row — ← Transcript · the count · Sources. */}
      <div className="flex items-center gap-2.5 border-b border-line/8 px-[22px] py-2.5 font-mono fs-10.5">
        <button type="button" onClick={close} className="flex-none whitespace-nowrap text-ink-100">
          ← Transcript
        </button>
        <span aria-hidden className="text-line/25">
          ·
        </span>
        <span className="min-w-0 flex-1 truncate fs-9.5 tracking-[0.14em] text-ink-900/60">
          {mediaCountLine(all, hidden)}
        </span>
        {all.length > 0 && <SourcesButton items={all} hidden={hidden} onChange={setHidden} />}
      </div>
      {tiles.length > 0 || all.length === 0 ? (
        <div
          className="grid min-h-0 flex-1 auto-rows-max gap-x-1.5 gap-y-2.5 overflow-y-auto px-[22px] py-3.5"
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
        <NothingShown hidden={all.length} onShowAll={() => setHidden([])} className="min-h-0 flex-1" />
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
