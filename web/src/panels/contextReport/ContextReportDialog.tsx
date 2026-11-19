import { useEffect, useState } from 'react'
import { useContextReport, type OpenContextReport } from '../../store/contextReport'
import { useOrbital } from '../../store/store'
import { Button } from '../../ui/Button'
import { Dialog, REVIEW_SCROLLBAR, ReviewHeader } from '../../ui/Dialog'
import { AsText, Breakdowns, Headline, Legend, WindowChart, snapshotLine } from './parts'
import { useReport } from './useReport'

const DIALOG_LABEL = 'Context report'

/**
 * The open `/context` report on the Mac (canvas `Feature - Context report`
 * 70a/70c/70d): the Report Dialog at 760px over the map or the desk.
 * Mounted once per window; what is open lives in `useContextReport`, opened
 * from the transcript row, by the answer to a `/context` sent from here, or
 * taken on demand from the context read-out (`takeReport`).
 */
export function ContextReportDialogHost() {
  const open = useContextReport((s) => s.open)
  const close = useContextReport((s) => s.close)
  // The session on screen in this window: the main window's detail panel,
  // or a detached window's one session. Only its answer opens by itself.
  const selectedId = useOrbital((s) => s.ui.selectedId)
  useEffect(() => (selectedId ? useContextReport.getState().view(selectedId) : undefined), [selectedId])
  // The last report opened stays drawn while the dialog closes, so its exit
  // shows the report rather than an empty frame.
  const [shown, setShown] = useState(open)
  if (open && open !== shown) setShown(open)
  return (
    <Dialog open={open !== null} variant="review" size="xl" maxHeight={820} title={DIALOG_LABEL} onClose={close}>
      {shown && (
        // Keyed per opening, so its sections and Copied start fresh each time.
        <ReportContent key={shown.key} shown={shown} onClose={close} />
      )}
    </Dialog>
  )
}

function ReportContent({ shown, onClose }: { shown: OpenContextReport; onClose: () => void }) {
  const { report, text } = shown
  const { title, thresholds, view, sections, time } = useReport(shown.sessionId, shown.takenAt, report)

  return (
    <>
      {/* 70c header: Report Dialog's, with the report's eyebrow, name and when it was taken. */}
      <ReviewHeader onClose={onClose}>
        <div className="font-mono fs-10 tracking-[0.2em] text-ink-900/65">/context</div>
        <h2 className="mt-1.5 truncate fs-20 leading-(--text-xl--line-height) font-bold tracking-[-0.01em]">{title}</h2>
        <div className="mt-[5px] font-mono fs-10.5 tracking-[0.04em] text-ink-900/55">
          {time ? `taken ${time} · a snapshot` : 'a snapshot'}
        </div>
      </ReviewHeader>

      <div className={`flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overflow-x-hidden px-[26px] pb-[18px] pt-5 ${REVIEW_SCROLLBAR}`}>
        <Headline report={report} view={view} phone={false} />
        <WindowChart report={report} view={view} thresholds={thresholds} />
        <Legend report={report} view={view} phone={false} />
        <div className="flex flex-col">
          <Breakdowns sections={sections} phone={false} />
          {/* A report taken on demand has no CLI printout (no /context ran). */}
          {text !== null && <AsText text={text} phone={false} />}
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
