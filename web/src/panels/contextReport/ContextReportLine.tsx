import { useMemo } from 'react'
import { contextReportView, formatTokens } from '../../lib/contextReport'
import type { ChatMessage, ContextReport } from '../../lib/types'
import { useContextReport } from '../../store/contextReport'
import { parseContextThresholds, useOrbital } from '../../store/store'
import { figureInk, gaugeColour } from './parts'

/**
 * The `/context` row's one line under the notice header (canvas `Feature -
 * Context report` 70b; 70f on the phone): the fill as a 64 × 3 bar, used /
 * window · percent, any over-limit, and `report ›`. The whole line is the
 * button that opens the report; the row stays one line however big the
 * report is.
 */
export function ContextReportLine({
  message,
  report,
  sessionId,
  phone,
}: {
  message: ChatMessage
  report: ContextReport
  sessionId: string
  phone: boolean
}) {
  const settings = useOrbital((s) => s.settings)
  const view = useMemo(() => contextReportView(report, parseContextThresholds(settings)), [report, settings])
  const show = useContextReport((s) => s.show)
  return (
    <button
      type="button"
      onClick={() => show(sessionId, message)}
      className={`flex w-full cursor-pointer items-center gap-2.5 whitespace-nowrap text-left font-mono fs-11 text-ink-100 hover:text-ink-50 ${phone ? 'min-h-[30px]' : 'min-h-5'}`}
    >
      <span className="block h-[3px] w-16 flex-none overflow-hidden rounded-[2px] bg-line/14">
        {/* 70b: never narrower than a sliver, so an empty window still shows a fill. */}
        <span
          className="block h-full rounded-[2px]"
          style={{ width: `${Math.max(view.fill * 100, 1.5)}%`, background: gaugeColour(view.level) }}
        />
      </span>
      <span>
        {formatTokens(report.totalTokens)} / {formatTokens(report.rawMaxTokens)} ·{' '}
        <span style={{ color: figureInk(view.level) }}>{report.percentage} %</span>
      </span>
      {view.overLine && <span className="min-w-0 truncate text-ink-600/75">· {view.overLine}</span>}
      <span className="flex-1" />
      <span className="flex-none fs-10.5 text-sky">report ›</span>
    </button>
  )
}
