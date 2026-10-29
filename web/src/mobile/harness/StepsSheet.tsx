import { swatch } from '../../lib/palette'
import { useState } from 'react'
import type { HarnessEvent, SessionHarness } from '../../lib/types'
import { MARKER, type StepKind } from '../../panels/harness/model'
import { BottomSheet, SheetPresence } from '../ui'
import { segmentTone, stepsSheet, type SegmentTone } from './gate'
import { RecordSheet } from './RecordSheet'

/**
 * Each segment tone's ink: canvas 10b `segC` for the five it draws; the
 * reviewer reading and a pause, which it does not, as the desktop pill's
 * segments (`lib/harnessSession.ts`).
 */
export const SEGMENT_INK: Record<SegmentTone, string> = {
  done: swatch('success'),
  waiting: swatch('warning'),
  active: swatch('accent'),
  reopened: swatch('ink-200', 0.7),
  pending: swatch('line', 0.18),
  reviewing: swatch('ink-200', 0.5),
  paused: swatch('accent', 0.45),
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
      style={{ border: `1.4px ${m.stroke} ${pending ? 'color-mix(in oklab, var(--color-ink-600) 45%, transparent)' : m.border}`, background: m.fill }}
    />
  )
}

/** Canvas 10b `hSteps`: pending titles dim, the rest bright; the waiting step's meta amber. */
function inks(kind: StepKind): { title: string; meta: string } {
  if (kind === 'pending' || kind === 'pendingGate') return { title: swatch('ink-400', 0.7), meta: swatch('ink-900', 0.6) }
  if (kind === 'waiting') return { title: swatch('ink-100'), meta: swatch('warning') }
  if (kind.startsWith('done')) return { title: swatch('ink-100'), meta: swatch('ink-900', 0.6) }
  // States 10b does not draw take the desktop rail's meta ink.
  return { title: swatch('ink-100'), meta: MARKER[kind].metaInk }
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
          <div className="border-b border-line/8 px-5 pb-3.5 pt-1">
            <div className="font-mono fs-10 tracking-[0.2em] text-ink-900/60">{sheet.eyebrow}</div>
            <div className="mt-1.5 fs-18 font-bold">{sheet.name}</div>
            <div className="mt-3 flex gap-[3px]">
              {tones.map((kind, i) => (
                <span key={i} className="block h-1 flex-1 rounded-[2px]" style={{ background: SEGMENT_INK[segmentTone(kind)] }} />
              ))}
            </div>
            <div className="mt-2 font-mono fs-10.5 text-ink-100">
              {sheet.status.step} <span className="text-line/30">·</span>{' '}
              <span style={{ color: sheet.status.ink }}>{sheet.status.status}</span>{' '}
              <span className="text-line/30">·</span>{' '}
              <span className="text-ink-900/60">{sheet.status.started}</span>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-3.5">
            {sheet.items.map((item) => {
              if (item.type === 'event') {
                // The harness's own events between the steps, as the desktop's rail draws them.
                return (
                  <div key={`e${item.id}`} className="-mt-1 mb-3.5 flex items-center gap-2 font-mono fs-9.5 tracking-[0.06em] text-ink-900/60">
                    <span className="flex w-[14px] shrink-0 justify-center">
                      <span aria-hidden className="block h-[1.4px] w-[7px] bg-ink-900/60" />
                    </span>
                    <span className="min-w-0 truncate">{item.text}</span>
                  </div>
                )
              }
              const ink = inks(item.kind)
              const body = (
                <>
                  <span className="text-pretty fs-13.5 font-semibold leading-[1.38]" style={{ color: ink.title }}>
                    {item.title}
                  </span>
                  <span className="flex gap-2 font-mono fs-10" style={{ color: ink.meta }}>
                    {item.meta}
                    {item.record && <span className="text-accent">record ›</span>}
                  </span>
                </>
              )
              return (
                <div key={`s${item.index}`} className="flex min-h-14 gap-3">
                  <div className="flex w-3.5 shrink-0 flex-col items-center">
                    <RailMarker kind={item.kind} gate={item.gate} />
                    {item !== lastStep && <span aria-hidden className="mt-1.5 block w-px flex-1 bg-line/12" />}
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
          {/* canvas 10b: the footer wraps rather than cutting its sentence. */}
          <div className="flex items-start gap-2 border-t border-line/8 px-5 py-3 font-mono fs-10 leading-[1.5] text-ink-900/55">
            <span className="min-w-0">{sheet.footer}</span>
            <span aria-hidden className="flex-1" />
            <span className="shrink-0">● auto ◆ gate</span>
          </div>
        </div>
      </BottomSheet>
      <SheetPresence>
        {record !== null && (
          <RecordSheet sessionId={sessionId} harness={harness} events={events} index={record} onDismiss={() => setRecord(null)} />
        )}
      </SheetPresence>
    </>
  )
}
