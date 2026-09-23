import type { ReactNode } from 'react'
import { useWindowBand } from '../lib/windowChrome'
import { pageBarGeometry } from '../ui/PageBar'

/**
 * The chrome both `/stats` screens sit in: the sky, and the page bar.
 *
 * Each artboard lights its own sky — 10a washes behind the two panel corners,
 * 10c puts one soft glow behind the middle where the unmeasured planet sits,
 * and 10b moves both washes to the corners its panels do not occupy — so the
 * variant is a prop rather than a single background reused three times.
 */
export type StatsSky = 'dashboard' | 'empty' | 'session'

const WASH: Record<StatsSky, string> = {
  dashboard:
    'bg-[radial-gradient(ellipse_620px_420px_at_22%_18%,rgba(110,80,220,.12),transparent),radial-gradient(ellipse_760px_520px_at_82%_78%,rgba(40,170,220,.07),transparent)]',
  empty: 'bg-[radial-gradient(ellipse_700px_460px_at_50%_46%,rgba(70,90,220,.09),transparent)]',
  session:
    'bg-[radial-gradient(ellipse_620px_420px_at_78%_14%,rgba(110,80,220,.1),transparent),radial-gradient(ellipse_700px_500px_at_18%_86%,rgba(40,170,220,.06),transparent)]',
}

const STARS: Record<StatsSky, string> = {
  dashboard: 'orbital-stats-stars',
  empty: 'orbital-stats-stars-empty',
  session: 'orbital-stats-stars-session',
}

/**
 * `bar` is the page's `PageBar`, sticky over the content that scrolls under
 * it. The content's left edge follows the bar's mark, which moves with the
 * window's mode (canvas `Feature - Page headers` 25b, 25f).
 */
export function StatsShell({ sky, bar, children }: { sky: StatsSky; bar: ReactNode; children: ReactNode }) {
  const geometry = pageBarGeometry(useWindowBand())
  return (
    // `overflow-x: clip`, not `hidden`: a hidden overflow makes this box the
    // bar's scroll container, and the bar would stop sticking to the window.
    <div className="relative min-h-screen w-full overflow-x-clip bg-space">
      <div aria-hidden className={`pointer-events-none fixed inset-0 ${WASH[sky]}`} />
      <div aria-hidden className={`pointer-events-none fixed inset-0 ${STARS[sky]}`} />
      {bar}
      <div
        className="relative flex flex-col gap-4 pb-10 pr-10 pt-7"
        style={{ paddingLeft: geometry.markXPx, minHeight: `calc(100vh - ${geometry.heightPx}px)` }}
      >
        {children}
      </div>
    </div>
  )
}
