import { useMemo } from 'react'
import { breakdownSections, contextReportView } from '../../lib/contextReport'
import { mediaClock } from '../../lib/media'
import type { ChatMessage, ContextReport } from '../../lib/types'
import { parseContextThresholds, useOrbital } from '../../store/store'

/**
 * What the Mac's dialog and the phone's sheet both work out before drawing a
 * `/context` report: the session's name, the gauge's thresholds, the view,
 * the breakdowns and when the report was taken (`14:20`, or null when the
 * row carries no time).
 */
export function useReport(sessionId: string, message: ChatMessage, report: ContextReport) {
  const title = useOrbital((s) => s.sessions[sessionId]?.title) || 'Context'
  const settings = useOrbital((s) => s.settings)
  const thresholds = useMemo(() => parseContextThresholds(settings), [settings])
  const view = useMemo(() => contextReportView(report, thresholds), [report, thresholds])
  const sections = useMemo(() => breakdownSections(report), [report])
  const time = (message.timestamp && mediaClock(message.timestamp)) || null
  return { title, thresholds, view, sections, time }
}
