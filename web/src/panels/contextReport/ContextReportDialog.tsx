import { useMemo, useState } from 'react'
import { breakdownSections, contextReportView } from '../../lib/contextReport'
import type { ChatMessage, ContextReport } from '../../lib/types'
import { useContextReport } from '../../store/contextReport'
import { parseContextThresholds, useOrbital } from '../../store/store'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { AsText, Breakdowns, Headline, Legend, WindowChart, reportTime, snapshotLine } from './parts'

const DIALOG_LABEL = 'Context report'

/**
 * The open `/context` report on the Mac (canvas `Feature - Context report`
 * 70a/70c/70d): the Report Dialog at 760px over the map or the desk.
 * Mounted once per window; what is open lives in `useContextReport`, opened
 * from the transcript row or by the answer to a `/context` sent from here.
 */
export function ContextReportDialogHost() {
  const open = useContextReport((s) => s.open)
  const close = useContextReport((s) => s.close)
  // The last report opened stays drawn while the dialog closes, so its exit
  // shows the report rather than an empty frame.
  const [shown, setShown] = useState(open)
  if (open && open !== shown) setShown(open)
  const report = shown?.message.notice?.contextReport
  return (
    <Dialog open={Boolean(open?.message.notice?.contextReport)} variant="review" size="xl" maxHeight={820} title={DIALOG_LABEL} onClose={close}>
      {shown && report && (
        // Keyed per opening, so its sections and Copied start fresh each time.
        <ReportContent key={shown.message.id} sessionId={shown.sessionId} message={shown.message} report={report} onClose={close} />
      )}
    </Dialog>
  )
}

function ReportContent({
  sessionId,
  message,
  report,
  onClose,
}: {
  sessionId: string
  message: ChatMessage
  report: ContextReport
  onClose: () => void
}) {
  const title = useOrbital((s) => s.sessions[sessionId]?.title) || 'Context'
  const settings = useOrbital((s) => s.settings)
  const thresholds = useMemo(() => parseContextThresholds(settings), [settings])
  const view = useMemo(() => contextReportView(report, thresholds), [report, thresholds])
  const sections = useMemo(() => breakdownSections(report), [report])
  const time = reportTime(message.timestamp)

  return (
    <>
      {/* 70c header: Report Dialog's, with the report's eyebrow, name and when it was taken. */}
      <div className="flex shrink-0 items-start gap-3 border-b border-line/10 pb-4 pl-[26px] pr-[18px] pt-[22px]">
        <div className="min-w-0 flex-1">
          <div className="font-mono fs-10 tracking-[0.2em] text-ink-900/65">/context</div>
          <h2 className="mt-1.5 truncate fs-20 leading-(--text-xl--line-height) font-bold tracking-[-0.01em]">{title}</h2>
          <div className="mt-[5px] font-mono fs-10.5 tracking-[0.04em] text-ink-900/55">
            {time ? `taken ${time} · a snapshot` : 'a snapshot'}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-[30px] w-[30px] shrink-0 cursor-pointer place-items-center rounded-[7px] fs-16 leading-(--text-base--line-height) text-ink-900/70 transition-colors hover:bg-line/8 hover:text-ink-100"
        >
          ×
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overflow-x-hidden px-[26px] pb-[18px] pt-5 [scrollbar-color:color-mix(in_oklab,_var(--color-line)_25%,_transparent)_transparent] [scrollbar-width:thin]">
        <Headline report={report} view={view} phone={false} />
        <WindowChart report={report} view={view} thresholds={thresholds} />
        <Legend report={report} view={view} phone={false} />
        <div className="flex flex-col">
          <Breakdowns sections={sections} phone={false} />
          <AsText text={message.text ?? ''} phone={false} />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2.5 border-t border-line/10 pb-4 pl-[26px] pr-5 pt-3.5">
        <span className="min-w-0 flex-1 font-mono fs-10.5 leading-normal tracking-[0.03em] text-pretty text-ink-900/55">
          {snapshotLine(time)}
        </span>
        <span className="rounded border border-line/20 px-[7px] py-[3px] font-mono fs-10 text-ink-500/70">esc</span>
        <Button variant="ghost" size="lg" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  )
}
