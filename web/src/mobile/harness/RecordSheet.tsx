import type { HarnessEvent, SessionHarness } from '../../lib/types'
import { isGateShape, pad2 } from '../../panels/harness/model'
import { Kicker, Marker } from '../../panels/harness/parts'
import { RecordBody, useStepRecord } from '../../panels/harness/RecordView'
import { BottomSheet } from '../ui'
import { commitRange } from './gate'

/**
 * A done step's record, pushed over the steps sheet (spec 2026-10-05-mobile-next
 * § 1): the desktop's `RecordBody` in its narrow form — summary, decisions,
 * open questions, reviews, earlier runs. Read-only: "Go back here" is the
 * gate card's, and the step's diff is not the phone's (too large for a frame).
 * The back button and the backdrop return to the steps sheet underneath.
 */
export function RecordSheet({
  harness,
  events,
  index,
  onDismiss,
}: {
  sessionId: string
  harness: SessionHarness
  events: readonly HarnessEvent[]
  index: number
  onDismiss: () => void
}) {
  const { step, state, kind, meta } = useStepRecord(harness, events, index)
  const range = commitRange(state)
  return (
    <BottomSheet label={`Record of step ${index + 1}`} onDismiss={onDismiss}>
      {/* No artboard draws it; the desktop record's header (canvas 30e) at the steps sheet's height and inset. */}
      <div className="-mx-2.5 flex h-[calc(100dvh-194px)] flex-col">
        <div className="border-b border-[rgba(150,205,255,.08)] px-5 pb-3.5 pt-1">
          <div className="flex items-center">
            <button type="button" onClick={onDismiss} className="-ml-2 h-11 px-2 font-mono text-[10.5px] text-[oklch(85%_.12_205)]">
              ‹ steps
            </button>
            <span aria-hidden className="flex-1" />
            <Kicker>
              RECORD · STEP {pad2(index + 1)} OF {pad2(harness.steps.length)}
            </Kicker>
          </div>
          <div className="mt-1 flex gap-2.5">
            <span className="mt-[5px]">
              <Marker kind={kind} gate={isGateShape(kind, step)} />
            </span>
            <div className="text-pretty text-[14px] font-semibold leading-[1.38] text-text-bright">{step.title}</div>
          </div>
          <div className="ml-[19px] mt-1.5 font-mono text-[10px] text-[rgba(160,190,225,.6)]">
            {[meta, range].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-3">
          <RecordBody harness={harness} events={events} index={index} wide={false} />
        </div>
      </div>
    </BottomSheet>
  )
}
