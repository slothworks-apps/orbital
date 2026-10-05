import { useMemo } from 'react'
import { basename } from '../format'
import { useObjectUrl } from '../files/objectUrl'
import { useFile, type FileSource } from '../files/useFile'
import { useMobile } from '../state'

/**
 * The gate card's thumbnails (spec 2026-10-05-mobile-next Decision 4): the
 * image paths the step's summary or evidence names, read over `file_get`
 * through the phone's file cache like any path the viewer opens. A press
 * opens the viewer at that path.
 *
 * Online the card's box shows the image once its bytes are in, and canvas
 * 10b's striped box with the file name until then (or when the Mac cannot
 * show it — the viewer says why). Asleep (10c second phone) a cached copy
 * shows at the "cached" box's quieter border, and one the phone never held
 * is the dashed "not cached" box.
 */
export function GateThumbs({ sessionId, paths, offline }: { sessionId: string; paths: string[]; offline: boolean }) {
  if (paths.length === 0) return null
  return (
    <div className="flex gap-2 px-3.5 pt-2.5">
      {paths.map((path) => (
        <GateThumb key={path} sessionId={sessionId} path={path} offline={offline} />
      ))}
    </div>
  )
}

function GateThumb({ sessionId, path, offline }: { sessionId: string; path: string; offline: boolean }) {
  const openFile = useMobile((s) => s.openFile)
  const source = useMemo<FileSource>(() => ({ kind: 'path', sessionId, path, as: 'image' }), [sessionId, path])
  const { view } = useFile(source)
  const outcome = view.phase === 'done' ? view.outcome : null
  const shown = outcome?.kind === 'ready' ? outcome : outcome?.kind === 'gone' ? outcome.copy : null
  const url = useObjectUrl(shown)
  const notCached = offline && outcome?.kind === 'waits'

  if (notCached) {
    // canvas 10c second phone: nothing to show until the Mac wakes.
    return (
      <span className="grid h-[54px] min-w-0 flex-1 place-items-center rounded-[8px] border border-dashed border-[rgba(150,205,255,.14)] px-1.5 font-mono text-[9.5px] text-[rgba(160,190,225,.5)]">
        <span className="block max-w-full truncate">not cached</span>
      </span>
    )
  }
  return (
    <button
      type="button"
      aria-label={`Open ${basename(path)}`}
      onClick={() => openFile({ sessionId, path, line: null })}
      className={[
        // canvas 10b: the thumbnail box; 10c's cached one sits on a quieter border.
        'relative grid h-[54px] min-w-0 flex-1 place-items-center overflow-hidden rounded-[8px] border px-1.5 font-mono text-[9.5px] text-[rgba(200,220,245,.7)]',
        offline ? 'border-[rgba(150,205,255,.14)]' : 'border-[rgba(150,205,255,.16)]',
        url ? '' : 'bg-[repeating-linear-gradient(135deg,rgba(150,205,255,.07)_0_6px,rgba(150,205,255,.02)_6px_12px)]',
      ].join(' ')}
    >
      {url ? (
        <img src={url} alt="" className="absolute inset-0 block h-full w-full object-cover" />
      ) : (
        <span className="block max-w-full truncate">{basename(path)}</span>
      )}
    </button>
  )
}
