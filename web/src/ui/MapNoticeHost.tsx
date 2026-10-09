import { useMapInsets } from '../map/shell/MapShell'
import { useMapNotices } from '../store/mapNotices'
import { useOrbital } from '../store/store'
import { EXITING, NOTICE_FADE_TRANSITION } from './motion'
import { NoticeDots } from './NoticeDots'
import { useNoticeSwap } from './useNoticeSwap'

/** 1a: the column's top edge, 14 px below the top of the map. */
const NOTICE_TOP_PX = 14
/** 1a: the toast's width; it narrows with a narrower strip. */
const NOTICE_WIDTH_PX = 540
/** A session window has no map: its strip is the whole window. */
const NO_INSETS = { left: 0, right: 0 }

/**
 * Where the Mac's messages show (canvas `Feature - Notice toast` 1a): the top
 * centre of the visible strip of map — between the sidebar and any open
 * right-hand panel, so it never covers a composer — one at a time, the head
 * of `useMapNotices`, with the dots for the rest above it. The strip lets
 * clicks through; only the card takes them. Mounted once by `App`, over every
 * map theme: the toast is app chrome, not part of the map. A session window
 * (`inWindow`) mounts it too, across the whole window, for its replies.
 */
export function MapNoticeHost({ inWindow = false }: { inWindow?: boolean }) {
  const head = useMapNotices((s) => s.queue[0] ?? null)
  const count = useMapNotices((s) => s.queue.length)
  const dismiss = useMapNotices((s) => s.dismiss)
  const { insets: mapInsets } = useMapInsets()
  const insets = inWindow ? NO_INSETS : mapInsets
  const resizingPanel = useOrbital((s) => s.ui.resizingPanel ?? false)
  const { shown, visible } = useNoticeSwap(head)

  if (!shown) return null
  const { Body, id } = shown
  return (
    <div
      data-overlay="map-notice"
      className={[
        'pointer-events-none absolute flex justify-center px-4',
        // A notice sits under the docked panels (z-10), over the map's HUD and
        // the window's drag band, which would otherwise take the clicks in the
        // top 48 px. A reply sits over the dialogs (z-50) too: it often
        // answers something done inside one.
        shown.kind === 'feedback' ? 'z-[55]' : 'z-[8]',
        resizingPanel ? '' : 'transition-[left,right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]',
      ].join(' ')}
      style={{ left: insets.left, right: insets.right, top: NOTICE_TOP_PX }}
    >
      <div
        inert={!visible}
        className={[
          // Only the dots and the card take clicks: a reply is narrower than the column.
          'orbital-no-drag pointer-events-none flex max-w-full flex-col items-center gap-2 [&>*]:pointer-events-auto',
          NOTICE_FADE_TRANSITION,
          visible ? 'opacity-100' : `opacity-0 ${EXITING}`,
        ].join(' ')}
        style={{ width: NOTICE_WIDTH_PX }}
      >
        <NoticeDots count={count} size="map" />
        <Body key={id} close={() => dismiss(id)} />
      </div>
    </div>
  )
}
