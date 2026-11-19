import { useEffect, useRef, useState, type TouchEvent } from 'react'
import { AsText, Breakdowns, Headline, Legend, WindowChart, snapshotLine } from '../../panels/contextReport/parts'
import { useReport } from '../../panels/contextReport/useReport'
import { useContextReport, type OpenContextReport } from '../../store/contextReport'
import { isGated, useMobile } from '../state'
import { BottomSheet, SecondaryButton, SheetPresence } from '../ui'

/**
 * 70f's two detents: medium shows the name, the fill, the two bars and the
 * legend; pulled up, the sheet stands 52px under the top of the screen and
 * its middle scrolls to the breakdowns and As text.
 */
const DETENT_HEIGHT = { medium: 'min(600px, calc(100% - 52px))', full: 'calc(100% - 52px)' } as const
type Detent = keyof typeof DETENT_HEIGHT

/** How far a drag must travel before the sheet changes detent, or goes. */
const DETENT_DRAG_PX = 40
const DISMISS_DRAG_PX = 60

/**
 * The open `/context` report on the phone, for the session on screen (spec
 * 2026-11-19-context-report-dialog-design § Phone). Leaving the session
 * closes it.
 *
 * Mounted with the session screen, which a pushed subagent, task or file
 * screen unmounts; while it is mounted and no lock stands in front of it,
 * the session is on screen, and only then does its answer open by itself.
 */
export function ContextReportSheetHost({ sessionId }: { sessionId: string }) {
  const open = useContextReport((s) => s.open)
  const close = useContextReport((s) => s.close)
  const gated = useMobile(isGated)
  useEffect(() => (gated ? undefined : useContextReport.getState().view(sessionId)), [sessionId, gated])
  useEffect(() => () => {
    if (useContextReport.getState().open?.sessionId === sessionId) useContextReport.getState().close()
  }, [sessionId])
  const shown = open?.sessionId === sessionId ? open : null
  return (
    <SheetPresence>
      {shown && <ContextReportSheet key={shown.key} shown={shown} onClose={close} />}
    </SheetPresence>
  )
}

function ContextReportSheet({ shown, onClose }: { shown: OpenContextReport; onClose: () => void }) {
  const { report, text } = shown
  const { title, thresholds, view, sections, time } = useReport(shown.sessionId, shown.takenAt, report)
  const [detent, setDetent] = useState<Detent>('medium')
  const full = detent === 'full'

  // The drag that moves between detents: up opens the sheet to full, down
  // brings it back to medium, and down from medium dismisses. A drag that
  // starts inside the middle while it is scrolled away from its top scrolls
  // it instead.
  const drag = useRef<number | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const onTouchStart = (event: TouchEvent) => {
    const inBody = body.current?.contains(event.target as Node) ?? false
    drag.current = inBody && full && (body.current?.scrollTop ?? 0) > 0 ? null : event.touches[0].clientY
  }
  const onTouchMove = (event: TouchEvent) => {
    if (drag.current === null) return
    const moved = event.touches[0].clientY - drag.current
    if (moved < -DETENT_DRAG_PX && !full) {
      drag.current = null
      setDetent('full')
    } else if (moved > DISMISS_DRAG_PX) {
      drag.current = null
      if (full) setDetent('medium')
      else onClose()
    }
  }

  return (
    <BottomSheet label="Context report" onDismiss={onClose} variant="report" height={DETENT_HEIGHT[detent]}>
      <div
        className="flex min-h-0 flex-1 flex-col"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={() => (drag.current = null)}
      >
        {/* 70f header: under the handle, ruled once the sheet is pulled up. */}
        <div className={`shrink-0 border-b px-4 pb-3 pt-1.5 ${full ? 'border-line/8' : 'border-transparent'}`}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="font-mono fs-10 tracking-[0.2em] text-ink-900/65">/context</div>
              <div className="mt-[5px] truncate fs-18 font-bold">{title}</div>
              <div className="mt-1 truncate font-mono fs-10.5 text-ink-900/55">
                {[time ? `taken ${time}` : null, report.model].filter(Boolean).join(' · ')}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-2 -mt-1.5 grid h-11 w-11 flex-none place-items-center fs-20 text-ink-900/75"
            >
              ×
            </button>
          </div>
        </div>

        <div
          ref={body}
          data-sheet-scroll
          className={`flex min-h-0 flex-1 flex-col gap-[18px] px-4 pb-4 pt-4 ${full ? 'overflow-y-auto' : 'overflow-hidden'}`}
        >
          <Headline report={report} view={view} phone />
          <WindowChart report={report} view={view} thresholds={thresholds} />
          <Legend report={report} view={view} phone />
          <div className="flex flex-col">
            <Breakdowns sections={sections} phone />
            {/* A report taken on demand has no CLI printout (no /context ran). */}
            {text !== null && <AsText text={text} phone />}
            <div className="px-1 pt-3.5 font-mono fs-10 leading-[1.6] text-ink-900/50">{snapshotLine(time)}</div>
          </div>
        </div>
      </div>

      <div className="shrink-0 px-4 pt-2.5">
        <SecondaryButton onClick={onClose}>Close</SecondaryButton>
      </div>
    </BottomSheet>
  )
}
