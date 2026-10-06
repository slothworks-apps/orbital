import { useState, type ReactNode } from 'react'
import { isReadOnly } from '../../lib/types'
import { clock } from '../../panels/harness/model'
import { somethingRuns } from '../../panels/harness/actions'
import { UNNAMED_MAC } from '../composer'
import { GateThumbs } from '../harness/GateThumbs'
import { approveStep, decideMyself, goBackFromPhone, reopenStep } from '../harness/answer'
import { gateView, shortSummary, type GateCardData, type GateView } from '../harness/gate'
import { setGateFold, useGateFold } from '../harness/gateFold'
import { GoBackSheet } from '../harness/GoBackSheet'
import { useHarness } from '../harness/useHarness'
import { useMobile } from '../state'
import { AckLine } from '../ui'
import type { SlotKeyProps, SlotProps } from './slot'

/** What the card shows for this session, from the harness, its log and this phone's last answer. */
function useGateView(sessionId: string): GateView {
  const { harness, events } = useHarness(sessionId)
  const fold = useGateFold(sessionId)
  return gateView({ harness, events, fold })
}

/**
 * The transcript's last row while a harness gate stands: the card and its
 * answers, folded to one line once answered (spec 2026-10-05-mobile-next
 * § 1; canvas 10b, 10c). Terminal sessions never have a harness.
 */
export function GateCard({ session, offline }: SlotProps) {
  const view = useGateView(session.id)
  if (isReadOnly(session) || view.kind === 'none') return null
  return (
    <div className="pt-3">
      <GateRow sessionId={session.id} view={view} offline={offline} />
    </div>
  )
}

/**
 * Changes whenever the card's content does — it appearing, folding, its
 * step moving on — so a reader at the bottom is kept there
 * (`TranscriptView`'s `footerKey`). Null while there is no card.
 */
export function useGateCardKey({ session }: SlotKeyProps): string | null {
  const view = useGateView(session?.id ?? '')
  if (!session || isReadOnly(session) || view.kind === 'none') return null
  switch (view.kind) {
    case 'waiting':
    case 'reviewing':
      return `${view.kind}:${view.step}`
    case 'fold':
      return `fold:${view.text}`
    case 'reopened':
      return `reopened:${view.step}`
  }
}

function GateRow({ sessionId, view, offline }: { sessionId: string; view: Exclude<GateView, { kind: 'none' }>; offline: boolean }) {
  switch (view.kind) {
    case 'fold':
      // Canvas 10b `gateAck*`: both answers this phone gives fold cyan.
      return <AckLine mark={view.mark}>{view.text}</AckLine>
    case 'reopened':
      // Canvas 10b third phone: the note in the fold line's place.
      return (
        <div className="flex flex-col gap-[5px] border-l border-[rgba(220,235,255,.3)] py-0.5 pl-3">
          <div className="font-mono text-[9.5px] tracking-[0.18em] text-[rgba(200,220,245,.75)]">
            ◆ STEP {view.step} · REOPENED BY YOU{view.at !== null ? ` · ${clock(view.at)}` : ''}
          </div>
          <div className="text-pretty text-[13px] leading-[1.5] text-[rgba(220,232,248,.88)]">
            Nothing was sent. Write what to change; the step stays open until the agent ticks it again.
          </div>
        </div>
      )
    case 'reviewing':
      return <ReviewerCard sessionId={sessionId} card={view} offline={offline} />
    case 'waiting':
      return offline ? <AsleepCard sessionId={sessionId} card={view} /> : <WaitingCard sessionId={sessionId} card={view} />
  }
}

/** The card's error line: neutral, under it, from the server's words (spec § 1 Failure). */
function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <div role="alert" className="mt-2 px-1 font-mono text-[11px] text-[rgba(200,215,235,.8)]">
      {text}
    </div>
  )
}

/** Canvas 10b: the chip at the card's head, and "step n of m". */
function CardHead({ chip, step, total }: { chip: ReactNode; step: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {chip}
      <span aria-hidden className="flex-1" />
      <span className="font-mono text-[10px] text-[rgba(160,190,225,.6)]">
        step {step} of {total}
      </span>
    </div>
  )
}

const CHIP = 'flex items-center gap-1.5 rounded-[4px] border px-2 py-[3px] font-mono text-[10px] tracking-[0.14em]'
const LABEL = 'font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.55)]'
const OUTLINED =
  'h-13 rounded-[14px] border border-[rgba(150,205,255,.22)] bg-[rgba(4,8,16,.5)] text-[14px] font-semibold text-text-bright disabled:opacity-40'

/** 10b first phone: the waiting gate and its three answers. */
function WaitingCard({ sessionId, card }: { sessionId: string; card: GateCardData }) {
  const { harness } = useHarness(sessionId)
  const focusComposer = useMobile((s) => s.focusComposer)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<{ running: boolean } | null>(null)

  async function run(call: () => Promise<string | null>, after?: () => void) {
    setBusy(true)
    setError(null)
    const failed = await call()
    setBusy(false)
    if (failed) setError(failed)
    else after?.()
  }

  const approve = () =>
    run(
      () => approveStep(sessionId, card.index),
      () => setGateFold(sessionId, { kind: 'approved', index: card.index, total: card.total, at: Date.now() }),
    )
  const reopen = () => run(() => reopenStep(sessionId, card.index), () => focusComposer({ kind: 'reopen', step: card.step }))
  const goBack = () => {
    const state = harness?.state[card.index]
    setAsking(null)
    if (!state) return
    // Stamped before the call: the rewound message it sends is the agent's cue, and the fold gives way to its reply.
    const at = Date.now()
    void run(
      () => goBackFromPhone(sessionId, card.index, state),
      () => setGateFold(sessionId, { kind: 'rewound', index: card.index, total: card.total, at }),
    )
  }

  return (
    <>
      {/* Canvas 10b: the 9c plan card's shell in amber. */}
      <div className="overflow-hidden rounded-[16px] border border-[rgba(255,187,123,.45)] bg-[linear-gradient(180deg,rgba(14,20,34,.92),rgba(8,12,22,.96))] shadow-[0_0_26px_rgba(255,187,123,.08),0_10px_30px_rgba(0,0,0,.35)]">
        <div className="px-3.5 pt-3">
          <CardHead
            step={card.step}
            total={card.total}
            chip={
              <span className={`${CHIP} border-[rgba(255,187,123,.4)] bg-[rgba(255,187,123,.1)] text-[#ffd6ad]`}>
                <span aria-hidden className="block h-1.5 w-1.5 rotate-45 rounded-[1px] bg-[#ffbb7b]" />
                GATE · NEEDS YOUR OK
              </span>
            }
          />
        </div>
        <div className="text-pretty px-3.5 pt-[9px] text-[15px] font-semibold leading-[1.35]">{card.title}</div>
        {card.summary && (
          <>
            <div className={`${LABEL} px-3.5 pt-2.5`}>WHAT IT DID</div>
            <div className="text-pretty px-3.5 pt-1 text-[13px] leading-[1.5] text-[rgba(220,232,248,.9)]">{card.summary}</div>
          </>
        )}
        {card.openQuestions.length > 0 && (
          <>
            <div className={`${LABEL} px-3.5 pt-2.5`}>OPEN QUESTIONS · {card.openQuestions.length}</div>
            <ul className="mt-1 flex list-disc flex-col gap-[3px] pl-[30px] pr-3.5 text-[13px] leading-[1.45] text-[rgba(220,232,248,.9)]">
              {card.openQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </>
        )}
        <GateThumbs sessionId={sessionId} paths={card.images} offline={false} />
        {(card.range || card.verifyPassed) && (
          <div className="flex items-center gap-1.5 px-3.5 pt-2 font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
            {card.range}
            {card.range && card.verifyPassed && ' · '}
            {card.verifyPassed && (
              <>
                <span className="text-[#7fe3b0]">✓</span> verify passed
              </>
            )}
          </div>
        )}
        {card.next && (
          <div className="mx-3.5 mt-2.5 flex items-center gap-2 border-t border-[rgba(150,205,255,.08)] pt-[9px] text-[12.5px] text-[rgba(200,215,235,.8)]">
            <span className={LABEL}>NEXT</span>
            <span
              aria-hidden
              className={[
                'box-border block h-[7px] w-[7px] shrink-0 border-[1.3px] border-[rgba(200,215,235,.6)]',
                card.next.gate ? 'rotate-45 rounded-[1.5px]' : 'rounded-full',
              ].join(' ')}
            />
            <span className="min-w-0 flex-1 truncate">
              {card.next.step} · {card.next.title}
            </span>
          </div>
        )}
        <div className="flex flex-col gap-2 px-3.5 pb-3.5 pt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void approve()}
            className="flex h-13 items-center justify-center gap-[9px] rounded-[14px] bg-[oklch(85%_.12_205)] text-[15px] font-bold text-[#03111a] shadow-[0_0_18px_oklch(85%_.12_205/.3)] disabled:opacity-40 disabled:shadow-none"
          >
            Approve
            {card.next && <span className="font-mono text-[10.5px] font-medium opacity-75">→ step {card.next.step}</span>}
          </button>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => void reopen()} className={`${OUTLINED} flex-1`}>
              Reopen
            </button>
            <button
              type="button"
              disabled={busy || !harness?.state[card.index]?.startMessageUuid}
              onClick={() => setAsking({ running: somethingRuns(sessionId) })}
              className={`${OUTLINED} flex-1`}
            >
              Go back
            </button>
          </div>
          <div className="text-center font-mono text-[10px] text-[rgba(160,190,225,.55)]">
            Reopen sends nothing. You write what to change.
          </div>
        </div>
      </div>
      <ErrorLine text={error} />
      {asking && harness && (
        <GoBackSheet
          harness={harness}
          index={card.index}
          running={asking.running}
          onConfirm={goBack}
          onCancel={() => setAsking(null)}
        />
      )}
    </>
  )
}

/** 10c second phone's locked line: what stands in for the answers while the Mac sleeps. */
function LockedLine() {
  const macName = useMobile((s) => s.macName) ?? UNNAMED_MAC
  return (
    <div className="box-border flex min-h-13 items-center gap-2.5 rounded-[14px] border border-dashed border-[rgba(150,205,255,.18)] px-3.5 text-[13.5px] text-[rgba(160,190,225,.7)]">
      <span aria-hidden className="relative block h-[13px] w-[11px] shrink-0">
        <span className="absolute left-[1.5px] top-0 box-border block h-2 w-2 rounded-t-[4px] border-[1.5px] border-b-0 border-current" />
        <span className="absolute bottom-0 left-0 block h-[7px] w-[11px] rounded-[2px] bg-current" />
      </span>
      Answer when {macName} wakes
    </div>
  )
}

/** 10c second phone: the gate as last known, readable and inert. */
function AsleepCard({ sessionId, card }: { sessionId: string; card: GateCardData }) {
  return (
    <div className="overflow-hidden rounded-[16px] border border-[rgba(255,187,123,.25)] bg-[rgba(8,12,22,.9)]">
      <div className="px-3.5 pt-3">
        <CardHead
          step={card.step}
          total={card.total}
          chip={
            <span className={`${CHIP} border-[rgba(255,187,123,.3)] text-[rgba(255,214,173,.8)]`}>
              <span aria-hidden className="block h-1.5 w-1.5 rotate-45 rounded-[1px] bg-[rgba(255,187,123,.7)]" />
              GATE · LAST KNOWN
            </span>
          }
        />
      </div>
      <div className="px-3.5 pt-[9px] text-[15px] font-semibold leading-[1.35] text-[rgba(232,238,248,.85)]">{card.title}</div>
      <div className="px-3.5 pt-2 text-[13px] leading-[1.5] text-[rgba(220,232,248,.75)]">
        {shortSummary(card.summary ?? undefined, card.openQuestions.length)}
      </div>
      {/* Nothing can be fetched while the Mac sleeps: a cached copy shows, one not held is the dashed box. */}
      <GateThumbs sessionId={sessionId} paths={card.images} offline />
      <div className="m-3.5">
        <LockedLine />
      </div>
    </div>
  )
}

/** 10c first phone: feeling lucky's reviewer reads the gate; the one answer takes it back. */
function ReviewerCard({ sessionId, card, offline }: { sessionId: string; card: GateCardData; offline: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function decide() {
    setBusy(true)
    setError(null)
    const failed = await decideMyself(sessionId, card.index)
    setBusy(false)
    setError(failed)
  }

  return (
    <>
      <div className="rounded-[16px] border border-dashed border-[rgba(220,235,255,.22)] bg-[rgba(8,12,22,.9)] p-3.5">
        <CardHead
          step={card.step}
          total={card.total}
          chip={
            <span className={`${CHIP} border-[rgba(200,215,235,.25)] text-[rgba(220,235,255,.85)]`}>
              <span aria-hidden className="box-border block h-1.5 w-1.5 rotate-45 rounded-[1px] border-[1.3px] border-[rgba(220,235,255,.8)]" />
              GATE · REVIEWER
            </span>
          }
        />
        <div className="mt-2.5 text-pretty text-[13.5px] leading-[1.5] text-[rgba(220,232,248,.9)]">
          Feeling lucky is on: a reviewer is reading the step. It decides on its own and leaves its reasoning in the record.
        </div>
        {card.reading && (
          <div className="mt-2 break-words font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.6)]">{card.reading}</div>
        )}
        {offline ? (
          <div className="mt-3.5">
            <LockedLine />
          </div>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => void decide()} className={`${OUTLINED} mt-3.5 w-full`}>
              Decide myself
            </button>
            <div className="mt-2 text-center font-mono text-[10px] text-[rgba(160,190,225,.55)]">
              the reviewer stops · the gate waits for you
            </div>
          </>
        )}
      </div>
      <ErrorLine text={error} />
    </>
  )
}
