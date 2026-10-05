import { useState } from 'react'
import type { HarnessEvent, SessionHarness } from '../../lib/types'
import { MARKER, type StepKind } from '../../panels/harness/model'
import { BottomSheet } from '../ui'
import { segmentTone, stepsSheet, type SegmentTone } from './gate'
import { RecordSheet } from './RecordSheet'

/**
 * Each segment tone's ink: canvas 10b `segC` for the five it draws; the
 * reviewer reading and a pause, which it does not, as the desktop pill's
 * segments (`lib/harnessSession.ts`).
 */
export const SEGMENT_INK: Record<SegmentTone, string> = {
  done: '#7fe3b0',
  waiting: '#ffbb7b',
  active: '#59e4f3',
  reopened: 'rgba(220,235,255,.7)',
  pending: 'rgba(150,205,255,.18)',
  reviewing: 'rgba(220,235,255,.5)',
  paused: 'rgba(89,228,243,.45)',
}

/**
 * A rail marker (canvas 10b `hSteps`: 9 px, ◆ gate, ● auto, 1.4 px border).
 * The desktop's `MARKER` decides fill and stroke per kind — the rail the
 * canvas says it reuses — except the pending border, which 10b draws its own.
 */
function RailMarker({ kind, gate }: { kind: StepKind; gate: boolean }) {
  const m = MARKER[kind]
  const pending = kind === 'pending' || kind === 'pendingGate'
  return (
    <span
      aria-hidden
      className={['mt-1 box-border block h-[9px] w-[9px] shrink-0', gate ? 'rotate-45 rounded-[1.5px]' : 'rounded-full'].join(' ')}
      style={{ border: `1.4px ${m.stroke} ${pending ? 'rgba(200,215,235,.45)' : m.border}`, background: m.fill }}
    />
  )
}

/** Canvas 10b `hSteps`: pending titles dim, the rest bright; the waiting step's meta amber. */
function inks(kind: StepKind): { title: string; meta: string } {
  if (kind === 'pending' || kind === 'pendingGate') return { title: 'rgba(220,232,248,.7)', meta: 'rgba(160,190,225,.6)' }
  if (kind === 'waiting') return { title: '#e8eef8', meta: '#ffbb7b' }
  if (kind.startsWith('done')) return { title: '#e8eef8', meta: 'rgba(160,190,225,.6)' }
  // States 10b does not draw take the desktop rail's meta ink.
  return { title: '#e8eef8', meta: MARKER[kind].metaInk }
}

/**
 * The harness as a sheet (canvas 10b fourth phone): scope, name, the
 * segments and where it stands, then the rail — done steps open their
 * record — and the auto-continue legend. Read-only; nothing in it moves.
 */
export function StepsSheet({
  sessionId,
  harness,
  events,
  onDismiss,
}: {
  sessionId: string
  harness: SessionHarness
  events: readonly HarnessEvent[]
  onDismiss: () => void
}) {
  const [record, setRecord] = useState<number | null>(null)
  const sheet = stepsSheet(harness, events)
  const tones = sheet.items.flatMap((item) => (item.type === 'step' ? [item.kind] : []))
  const steps = sheet.items.filter((item) => item.type === 'step')
  const lastStep = steps.at(-1)

  return (
    <>
      <BottomSheet label={`Harness ${sheet.name}`} onDismiss={onDismiss}>
        {/* Canvas 10b: the sheet stands 150 px from the top; the handle and the home row are the shell's. */}
        <div className="-mx-2.5 flex h-[calc(100dvh-194px)] flex-col">
          <div className="border-b border-[rgba(150,205,255,.08)] px-5 pb-3.5 pt-1">
            <div className="font-mono text-[10px] tracking-[0.2em] text-[rgba(160,190,225,.6)]">{sheet.eyebrow}</div>
            <div className="mt-1.5 text-[18px] font-bold">{sheet.name}</div>
            <div className="mt-3 flex gap-[3px]">
              {tones.map((kind, i) => (
                <span key={i} className="block h-1 flex-1 rounded-[2px]" style={{ background: SEGMENT_INK[segmentTone(kind)] }} />
              ))}
            </div>
            <div className="mt-2 font-mono text-[10.5px] text-text-bright">
              {sheet.status.step} <span className="text-[rgba(150,205,255,.3)]">·</span>{' '}
              <span style={{ color: sheet.status.ink }}>{sheet.status.status}</span>{' '}
              <span className="text-[rgba(150,205,255,.3)]">·</span>{' '}
              <span className="text-[rgba(160,190,225,.6)]">{sheet.status.started}</span>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-3.5">
            {sheet.items.map((item) => {
              if (item.type === 'event') {
                // The harness's own events between the steps, as the desktop's rail draws them.
                return (
                  <div key={`e${item.id}`} className="-mt-1 mb-3.5 flex items-center gap-2 font-mono text-[9.5px] tracking-[0.06em] text-[rgba(160,190,225,.6)]">
                    <span className="flex w-[14px] shrink-0 justify-center">
                      <span aria-hidden className="block h-[1.4px] w-[7px] bg-[rgba(160,190,225,.6)]" />
                    </span>
                    <span className="min-w-0 truncate">{item.text}</span>
                  </div>
                )
              }
              const ink = inks(item.kind)
              const body = (
                <>
                  <span className="text-pretty text-[13.5px] font-semibold leading-[1.38]" style={{ color: ink.title }}>
                    {item.title}
                  </span>
                  <span className="flex gap-2 font-mono text-[10px]" style={{ color: ink.meta }}>
                    {item.meta}
                    {item.record && <span className="text-[oklch(85%_.12_205)]">record ›</span>}
                  </span>
                </>
              )
              return (
                <div key={`s${item.index}`} className="flex min-h-14 gap-3">
                  <div className="flex w-3.5 shrink-0 flex-col items-center">
                    <RailMarker kind={item.kind} gate={item.gate} />
                    {item !== lastStep && <span aria-hidden className="mt-1.5 block w-px flex-1 bg-[rgba(150,205,255,.12)]" />}
                  </div>
                  {item.record ? (
                    <button
                      type="button"
                      onClick={() => setRecord(item.index)}
                      className="flex min-w-0 flex-1 flex-col gap-[3px] pb-3 text-left"
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="flex min-w-0 flex-1 flex-col gap-[3px] pb-3">{body}</div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="flex items-center gap-2 border-t border-[rgba(150,205,255,.08)] px-5 py-3 font-mono text-[10px] text-[rgba(160,190,225,.55)]">
            <span className="min-w-0 truncate">{sheet.footer}</span>
            <span aria-hidden className="flex-1" />
            <span className="shrink-0">● auto ◆ gate</span>
          </div>
        </div>
      </BottomSheet>
      {record !== null && (
        <RecordSheet sessionId={sessionId} harness={harness} events={events} index={record} onDismiss={() => setRecord(null)} />
      )}
    </>
  )
}
