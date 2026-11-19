import { useState, type ReactNode } from 'react'
import { failureText } from '../../lib/contextReport'
import { CONTEXT_REPORT_TIMEOUT_MS } from '@orbital/shared/contextReport'
import { useContextReport, type OpenContextReport } from '../../store/contextReport'
import { takeReport } from '../../store/takeContextReport'
import { AsText, Breakdowns, FailedBlock, Headline, Legend, UsedSplit, WaitingLayer, WindowBar } from './parts'
import type { useReport } from './useReport'

/**
 * Canvas 71c: the height kept for the split, the legend and the breakdowns
 * while a report from the read-out is taken, and the failure's block — so the
 * dialog keeps one size from the click to the arrival.
 */
const KEPT_HEIGHT_PX = 473

/** 71c: the arrival crossfades by opacity — the waiting layer out, the data in, both ease-out. */
const WAITING_OUT = 'opacity .16s ease-out'
const DATA_IN = 'opacity .24s ease-out'

/**
 * The body of an opening, the same on the Mac's dialog and the phone's sheet
 * (canvas 70c, 71a–71e): the headline and the window bar at once, from the
 * report or the read-out's preview; under them the split, the legend, the
 * breakdowns and As text once the report is there, the waiting words while it
 * is taken, or the failure. `after` follows As text inside the scroll (the
 * phone's snapshot line).
 */
export function OpeningBody({
  shown,
  r,
  phone,
  after,
}: {
  shown: OpenContextReport
  r: ReturnType<typeof useReport>
  phone: boolean
  after?: ReactNode
}) {
  // Whether this opening waited: only then is the space kept and the arrival crossfaded.
  const [waited, setWaited] = useState(shown.phase !== 'ready')
  if (shown.phase !== 'ready' && !waited) setWaited(true)
  const ready = shown.phase === 'ready' && shown.snapshot !== null
  const kept = !phone && waited ? { minHeight: KEPT_HEIGHT_PX } : undefined
  // 71c / 71e: the body's sections stand 20px apart on the Mac, 18px on the phone;
  // the failure follows the window bar by the same.
  const gap = phone ? 'gap-[18px]' : 'gap-5'
  const failedGap = phone ? 'mt-[18px]' : 'mt-5'

  return (
    <>
      {r.report && r.view && <Headline report={r.report} view={r.view} phone={phone} />}
      {shown.phase === 'failed' ? (
        <div className="flex flex-col" style={phone ? undefined : { height: KEPT_HEIGHT_PX }}>
          {r.report && r.view && <WindowBar report={r.report} view={r.view} thresholds={r.thresholds} />}
          <div className={r.report ? failedGap : undefined}>
            <FailedBlock
              text={failureText(shown.failure, Math.round(CONTEXT_REPORT_TIMEOUT_MS / 1000))}
              onRetry={() => void takeReport(shown.sessionId, { key: shown.key })}
              earlierTime={r.earlierTime}
              onEarlier={() => useContextReport.getState().showEarlier()}
              phone={phone}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          {r.report && r.view && <WindowBar report={r.report} view={r.view} thresholds={r.thresholds} />}
          <div className="relative" style={kept}>
            <div
              aria-hidden={!ready}
              className={`flex flex-col ${gap}`}
              style={{ opacity: ready ? 1 : 0, transition: waited && ready ? DATA_IN : 'none', pointerEvents: ready ? 'auto' : 'none' }}
            >
              {ready && shown.snapshot && r.view && (
                <>
                  <UsedSplit report={shown.snapshot.report} view={r.view} />
                  <Legend report={shown.snapshot.report} view={r.view} phone={phone} />
                  <div className="flex flex-col">
                    <Breakdowns sections={r.sections} phone={phone} />
                    {/* A report from the Mac's keeper or taken from the read-out has no CLI printout. */}
                    {shown.snapshot.text !== null && <AsText text={shown.snapshot.text} phone={phone} />}
                    {after}
                  </div>
                </>
              )}
            </div>
            {waited && (
              // In the flow while it waits, so it holds its place on the phone, whose
              // sheet keeps no height; over the arrived data while it fades out.
              <div
                aria-hidden={ready}
                className={`pointer-events-none ${ready ? 'absolute inset-x-0 top-0' : ''}`}
                style={{ opacity: ready ? 0 : 1, transition: ready ? WAITING_OUT : 'none' }}
              >
                <WaitingLayer counting={shown.counting === true} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
