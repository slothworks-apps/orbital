import { useEffect, useState } from 'react'
import { useMapInsets } from '../map/shell/MapShell'
import { useMapNotices, type MapNoticeEntry } from '../store/mapNotices'
import { useOrbital } from '../store/store'
import { EXITING, NOTICE_EXIT_MS, NOTICE_EXIT_TRANSITION } from './motion'
import { prefersReducedMotion } from './usePresence'

/** 1a: the notice's top edge, 22 px below the top of the map. */
const NOTICE_TOP_PX = 22

/**
 * Where `MapNotice`s appear (canvas `Feature - Notifications off` 1a): the top
 * centre of the visible strip of map — between the sidebar and any open
 * right-hand panel, so it never covers a composer — and one at a time, the
 * head of `useMapNotices`' queue. The strip lets clicks through; only the
 * card takes them. Mounted once by `App`, over every map theme.
 *
 * A notice appears with no motion and leaves on a 150 ms fade; the next one
 * waits for the fade.
 */
export function MapNoticeHost() {
  const head = useMapNotices((s) => s.queue[0] ?? null)
  const dismiss = useMapNotices((s) => s.dismiss)
  const { insets } = useMapInsets()
  const resizingPanel = useOrbital((s) => s.ui.resizingPanel ?? false)
  const [shown, setShown] = useState<MapNoticeEntry | null>(head)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (head?.id === shown?.id) {
      setLeaving(false)
      return
    }
    if (!shown || prefersReducedMotion()) {
      setShown(head)
      setLeaving(false)
      return
    }
    setLeaving(true)
    const t = setTimeout(() => {
      setLeaving(false)
      setShown(head)
    }, NOTICE_EXIT_MS)
    return () => clearTimeout(t)
  }, [head, shown])

  if (!shown) return null
  const { Body, id } = shown
  return (
    <div
      data-overlay="map-notice"
      // Under the docked panels (z-10), over the map's HUD and the window's
      // drag band, which would otherwise take the clicks in the top 48 px.
      className={[
        'pointer-events-none absolute z-[8] flex justify-center px-4',
        resizingPanel ? '' : 'transition-[left,right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]',
      ].join(' ')}
      style={{ left: insets.left, right: insets.right, top: NOTICE_TOP_PX }}
    >
      <div
        inert={leaving}
        className={[
          'orbital-no-drag pointer-events-auto max-w-full',
          NOTICE_EXIT_TRANSITION,
          leaving ? `opacity-0 ${EXITING}` : 'opacity-100',
        ].join(' ')}
      >
        <Body key={id} close={() => dismiss(id)} />
      </div>
    </div>
  )
}
