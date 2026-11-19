import { useMemo } from 'react'
import { breakdownSections, contextReportView, previewReport } from '../../lib/contextReport'
import { mediaClock } from '../../lib/media'
import type { OpenContextReport } from '../../store/contextReport'
import { parseContextThresholds, useOrbital } from '../../store/store'

const clock = (iso: string | null | undefined): string | null => (iso && mediaClock(iso)) || null

/**
 * What the Mac's dialog and the phone's sheet both work out before drawing an
 * opening: the session's name, the gauge's thresholds, the report the
 * headline and window bar draw — the arrived one, else the read-out's
 * preview (canvas 71c) — its view, the breakdowns, when it was taken
 * (`14:20`, or null when nothing says), and the failed opening's earlier
 * report's time (undefined when there is none to offer).
 */
export function useReport(shown: OpenContextReport) {
  const title = useOrbital((s) => s.sessions[shown.sessionId]?.title) || 'Context'
  const settings = useOrbital((s) => s.settings)
  const thresholds = useMemo(() => parseContextThresholds(settings), [settings])
  const arrived = shown.snapshot?.report ?? null
  const preview = shown.preview
  const report = useMemo(() => arrived ?? (preview ? previewReport(preview) : null), [arrived, preview])
  const view = useMemo(() => (report ? contextReportView(report, thresholds) : null), [report, thresholds])
  const sections = useMemo(() => (arrived ? breakdownSections(arrived) : []), [arrived])
  const time = clock(shown.snapshot?.takenAt)
  const earlierTime = shown.earlier ? clock(shown.earlier.takenAt) : undefined
  return { title, thresholds, report, view, sections, time, earlierTime }
}
