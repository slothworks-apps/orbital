import { useEffect, useState } from 'react'
import { useContextReport, type OpenContextReport } from '../../store/contextReport'
import { useOrbital } from '../../store/store'
import { Button } from '../../ui/Button'
import { Dialog, REVIEW_SCROLLBAR, ReviewHeader } from '../../ui/Dialog'
import { openingFoot, openingMeta } from '../../lib/contextReport'
import { OpeningBody } from './OpeningBody'
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
  const r = useReport(shown)
  const words = { phase: shown.phase, origin: shown.origin, failure: shown.failure, counting: shown.counting }

  return (
    <>
      {/* 70c/71c header: Report Dialog's, with the report's eyebrow, name and when it was taken. */}
      <ReviewHeader onClose={onClose}>
        <div className="font-mono fs-10 tracking-[0.2em] text-ink-900/65">/context</div>
        <h2 className="mt-1.5 truncate fs-20 leading-(--text-xl--line-height) font-bold tracking-[-0.01em]">{r.title}</h2>
        <div className="mt-[5px] font-mono fs-10.5 tracking-[0.04em] text-ink-900/55">{openingMeta(words, r.time)}</div>
      </ReviewHeader>

      <div className={`flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overflow-x-hidden px-[26px] pb-[18px] pt-5 ${REVIEW_SCROLLBAR}`}>
        <OpeningBody shown={shown} r={r} phone={false} />
      </div>

      <div className="flex shrink-0 items-center gap-2.5 border-t border-line/10 pb-4 pl-[26px] pr-5 pt-3.5">
        <span className="min-w-0 flex-1 font-mono fs-10.5 leading-normal tracking-[0.03em] text-pretty text-ink-900/55">
          {openingFoot(words, r.time, r.earlierTime ?? null)}
        </span>
        <span className="rounded border border-line/20 px-[7px] py-[3px] font-mono fs-10 text-ink-500/70">esc</span>
        <Button variant="ghost" size="lg" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  )
}
