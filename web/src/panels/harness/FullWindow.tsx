import { useState } from 'react'
import { WINDOW_STRIP_INSET_PX } from '../../ui/Panel'
import type { HarnessEvent, SessionHarness } from '../../lib/types'
import { MARKER, clock, isDone, isGateShape, runSpan, scopeChip, stepMeta, stepWho, toLookAt } from './model'
import { Kicker, Marker, ScopeChip } from './parts'
import { WideRecord } from './RecordView'
import { Segments, useSteps } from './RunningView'
import { WideStepDiff } from './StepDiffView'

/** The step the full window opens on: the one in progress, else the last one. */
export function defaultPick(harness: SessionHarness): number {
  const current = harness.state.findIndex((s) => s.status !== 'done')
  return current === -1 ? Math.max(0, harness.steps.length - 1) : current
}

/**
 * The full window (canvas 30h, "the morning after"): steps 340 · record flex
 * · diff 520, under a header with the run's span — a fixed fact, not a timer.
 */
export function FullWindow({
  sessionId,
  harness,
  events,
  sessionTitle,
  initialPick,
  onExit,
  onGoBack,
  inWindow = false,
}: {
  sessionId: string
  harness: SessionHarness
  events: readonly HarnessEvent[]
  sessionTitle: string
  initialPick: number | null
  onExit: () => void
  /** Null for a read-only record. */
  onGoBack: ((index: number) => void) | null
  /** In a detached window: the header is its title bar, clear of the traffic lights. */
  inWindow?: boolean
}) {
  const [pick, setPick] = useState(initialPick ?? defaultPick(harness))
  const steps = useSteps(harness, events)
  const kinds = steps.map((s) => s.kind)
  const done = kinds.filter(isDone).length
  const chip = scopeChip(harness, events)
  const look = toLookAt(harness)
  const firstInput = Object.values(harness.inputs).find((v) => v.trim() !== '')
  const index = Math.min(pick, harness.steps.length - 1)
  const state = harness.state[index]
  const readout = [
    `${done} of ${harness.steps.length} done`,
    runSpan(harness, events),
    harness.options.lucky ? 'feeling lucky' : harness.paused ? 'paused' : null,
    look > 0 ? `${look} to look at` : null,
  ].filter(Boolean)

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div
        className={`flex items-center gap-4 border-b border-[rgba(150,205,255,.1)] px-6 py-4 ${inWindow ? 'orbital-drag-region' : 'orbital-band-controls'}`}
        style={inWindow ? { paddingLeft: WINDOW_STRIP_INSET_PX } : undefined}
      >
        <button
          type="button"
          onClick={onExit}
          className="min-w-0 max-w-[220px] truncate font-mono text-[10.5px] text-[oklch(85%_.12_205)] hover:brightness-110"
        >
          ↖ {sessionTitle}
        </button>
        <span aria-hidden className="block h-[18px] w-px shrink-0 bg-[rgba(150,205,255,.14)]" />
        <div className="flex min-w-0 flex-col gap-[3px]">
          <div className="flex items-center gap-2">
            <Kicker>HARNESS</Kicker>
            {chip && <ScopeChip text={chip} />}
            {harness.removedAt !== null && <ScopeChip text="removed" />}
          </div>
          <div className="truncate text-[17px] font-bold text-text-bright">
            {harness.name}
            {firstInput ? ` · ${firstInput}` : ''}
          </div>
        </div>
        <span aria-hidden className="flex-1" />
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Segments kinds={kinds} className="w-[220px]" />
          <div className="font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
            <span className="text-[#e8eef8]">{readout[0]}</span>
            {readout.slice(1).map((r) => ` · ${r}`)}
          </div>
        </div>
        <button
          type="button"
          aria-label="Back to the panel"
          title="Back to the panel"
          onClick={onExit}
          className="grid size-[22px] shrink-0 place-items-center rounded-[6px] font-mono text-[12px] text-[rgba(200,220,245,.7)] hover:bg-[rgba(150,205,255,.09)] hover:text-[#e8eef8]"
        >
          ⎋
        </button>
      </div>
      {/* 30h's 340 · flex · 520 assumes the 56 px rail; as shares, an open sidebar narrows all three instead of crushing the record. */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,340fr)_minmax(320px,480fr)_minmax(300px,520fr)]">
        <div className="flex min-h-0 flex-col gap-1 overflow-y-auto border-r border-[rgba(150,205,255,.08)] px-3.5 py-4">
          {harness.steps.map((step, i) => {
            const s = steps[i]
            const on = i === index
            return (
              <button
                type="button"
                key={step.id}
                onClick={() => setPick(i)}
                aria-current={on || undefined}
                className="flex gap-2.5 rounded-lg border px-2.5 py-[9px] text-left hover:bg-[rgba(150,205,255,.06)]"
                style={{ borderColor: on ? 'rgba(150,205,255,.22)' : 'transparent', background: on ? 'rgba(150,205,255,.08)' : undefined }}
              >
                <span className="mt-[5px]">
                  <Marker kind={s.kind} gate={isGateShape(s.kind, step)} />
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-pretty text-[12.5px] font-semibold leading-[1.4]" style={{ color: MARKER[s.kind].titleInk }}>
                    {step.title}
                  </span>
                  <span className="font-mono text-[10px] text-[rgba(160,190,225,.6)]">
                    {stepMeta(i, step, stepWho(s.kind, step, s.state, harness, s.own))}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        {harness.steps.length > 0 ? (
          <WideRecord
            key={index}
            sessionId={sessionId}
            harness={harness}
            events={events}
            index={index}
            onGoBack={onGoBack && state?.startMessageUuid && state.status !== 'pending' ? () => onGoBack(index) : null}
          />
        ) : (
          <div />
        )}
        {harness.steps.length > 0 ? <WideStepDiff key={`d${index}`} sessionId={sessionId} harness={harness} index={index} /> : <div />}
      </div>
      {harness.removedAt !== null && (
        <div className="border-t border-[rgba(150,205,255,.1)] px-6 py-2 font-mono text-[10px] text-[rgba(160,190,225,.5)]">
          removed {clock(harness.removedAt)} · the record is kept
        </div>
      )}
    </div>
  )
}
