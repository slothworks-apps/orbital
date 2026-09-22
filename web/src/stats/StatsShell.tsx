import type { ReactNode } from 'react'
import { Logo } from '../ui/Logo'

/**
 * The chrome both `/stats` screens sit in: the sky, and the wordmark row.
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

export function StatsShell({ sky, children }: { sky: StatsSky; children: ReactNode }) {
  return (
    <div className="relative min-h-screen w-full overflow-x-hidden bg-space">
      <div aria-hidden className={`pointer-events-none fixed inset-0 ${WASH[sky]}`} />
      <div aria-hidden className={`pointer-events-none fixed inset-0 ${STARS[sky]}`} />
      <div className="relative flex min-h-screen flex-col gap-4 px-10 pb-10 pt-[26px]">
        {children}
      </div>
    </div>
  )
}

/**
 * The wordmark row. `crumb` is the mono path after it (`/ STATS`, `/ STATS /
 * SESSION`) and `actions` whatever the screen offers on the right — the
 * MAP | STATS pair on the dashboard, the way back on the drilldown.
 */
export function StatsHeader({ crumb, actions }: { crumb: ReactNode; actions: ReactNode }) {
  return (
    <header className="flex items-center gap-[14px]">
      <Logo />
      <span className="text-[13px] font-bold tracking-[0.22em]">ORBITAL</span>
      <span className="font-mono text-[11px] tracking-[0.1em] text-[rgba(160,190,225,.6)]">
        {crumb}
      </span>
      <span className="flex-1" />
      {actions}
    </header>
  )
}
