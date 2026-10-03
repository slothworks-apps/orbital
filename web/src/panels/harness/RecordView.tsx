import type { ReactNode } from 'react'
import { useOrbital } from '../../store/store'
import { modelNameForId } from '../../lib/models'
import type { HarnessEvent, PreviousRun, SessionHarness, StepReview, StepState } from '../../lib/types'
import {
  clock,
  eventsOfHarness,
  eventsOfStep,
  isGateShape,
  modelLabel,
  pad2,
  recordMeta,
  reviewModel,
  shortSha,
  stepKind,
  stepWho,
  verdictWord,
  whatHappened,
} from './model'
import { HeaderBlock, Kicker, Label, Marker, OutlineButton, type Chrome } from './parts'
import { useStepDiff } from './useStepDiff'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Everything the record needs to know about one step. */
export function useStepRecord(harness: SessionHarness, events: readonly HarnessEvent[], index: number) {
  const step = harness.steps[index]
  const state: StepState = harness.state[index] ?? { status: 'pending' }
  const own = eventsOfStep(eventsOfHarness(harness, events), step, index, harness.createdAt)
  const kind = stepKind(step, state, harness, own)
  const who = stepWho(kind, step, state, harness, own)
  return { step, state, own, kind, who, meta: recordMeta(kind, step, state, who) }
}

/** A decision (30e): a three-row card — what, why, instead of. */
function DecisionCard({ d, wide }: { d: NonNullable<StepState['decisions']>[number]; wide: boolean }) {
  const key = 'font-mono text-[9.5px] text-[rgba(160,190,225,.55)]'
  return (
    <div
      className="grid gap-x-2 rounded-lg border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] leading-[1.45] text-[rgba(220,232,248,.88)]"
      style={{
        gridTemplateColumns: `${wide ? 60 : 52}px minmax(0,1fr)`,
        rowGap: wide ? 4 : 3,
        padding: wide ? '10px 12px' : '9px 10px',
        fontSize: wide ? 12 : 11.5,
      }}
    >
      <span className={key}>what</span>
      <span className="font-semibold text-[#e8eef8]">{d.what}</span>
      <span className={key}>why</span>
      <span>{d.why}</span>
      {d.alternatives && (
        <>
          <span className={key}>instead of</span>
          <span className="text-[rgba(190,212,238,.7)]">{d.alternatives}</span>
        </>
      )}
    </div>
  )
}

/** A review card (30e REVIEWS): verdict, model, time, reasoning, findings, checked, earlier send-backs. */
function ReviewCard({ review, earlier, model, wide }: { review: StepReview; earlier: StepReview[]; model?: string; wide: boolean }) {
  const approve = review.verdict === 'approve'
  const ink = approve ? '#7fe3b0' : 'rgba(220,235,255,.85)'
  const sendBacks = earlier.filter((r) => r.verdict === 'reopen').length
  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border bg-[rgba(4,8,16,.45)]"
      style={{ borderColor: approve ? 'rgba(127,227,176,.3)' : 'rgba(220,235,255,.22)', padding: wide ? 12 : 10 }}
    >
      <div className="flex items-center gap-2 font-mono text-[9.5px] tracking-[0.12em]" style={{ color: ink }}>
        {approve ? (
          <span
            aria-hidden
            className="block size-[7px] rotate-45 rounded-[1px] box-border"
            style={{ border: `1.3px ${review.uncertain ? 'dashed' : 'solid'} #7fe3b0` }}
          />
        ) : (
          <span aria-hidden>↺</span>
        )}
        {verdictWord(review).toUpperCase()}
        <span aria-hidden className="flex-1" />
        <span className="tracking-[0.04em] text-[rgba(160,190,225,.6)]">
          {['reviewer', model, clock(review.at), wide && sendBacks > 0 ? `after ${plural(sendBacks, 'send-back')}` : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <div className="text-pretty leading-[1.5] text-[rgba(220,232,248,.88)]" style={{ fontSize: wide ? 12.5 : 11.5 }}>
        {review.reasoning}
      </div>
      {(review.findings.length > 0 || review.checked.length > 0 || (!wide && earlier.length > 0)) && (
        <div className="font-mono text-[10px] leading-[1.65] text-[rgba(160,190,225,.65)]">
          {review.findings.length > 0 && <div>findings · {review.findings.join(' · ')}</div>}
          {review.checked.length > 0 && <div>checked · {review.checked.join(' · ')}</div>}
          {!wide &&
            earlier.map((r, i) => (
              <div key={i}>
                earlier · {clock(r.at)} ↺ {verdictWord(r)}: {r.reasoning}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

/**
 * A record's sections in their fixed order (30e THE RECORD): summary,
 * decisions, open questions, reviews, what happened. Empty ones are left out.
 */
function Sections({
  record,
  own,
  happened,
  wide,
}: {
  record: StepState | PreviousRun
  own: readonly HarnessEvent[]
  happened: { at: number; text: string }[]
  wide: boolean
}) {
  const models = useOrbital((s) => s.models)
  const summary = record.summary ?? record.evidence
  const decisions = record.decisions ?? []
  const questions = record.openQuestions ?? []
  const reviews = record.reviews ?? []
  const last = reviews[reviews.length - 1]
  const lastModel = last ? reviewModel(last, own) : undefined
  return (
    <>
      {summary && (
        <div>
          <Label>SUMMARY</Label>
          <div className="mt-1.5 text-pretty text-[rgba(220,232,248,.9)]" style={{ fontSize: wide ? 13 : 12, lineHeight: wide ? 1.6 : 1.58 }}>
            {summary}
          </div>
        </div>
      )}
      {decisions.length > 0 && (
        <div>
          <Label>{wide ? 'DECISIONS' : `DECISIONS · ${decisions.length}`}</Label>
          {/* Side by side as 30h draws them while the column has room; stacked once it narrows. */}
          <div className={wide ? 'mt-2 grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-2.5' : 'mt-[7px] flex flex-col gap-2'}>
            {decisions.map((d, i) => (
              <DecisionCard key={i} d={d} wide={wide} />
            ))}
          </div>
        </div>
      )}
      {questions.length > 0 && (
        <div>
          <Label>OPEN QUESTIONS · TO LOOK AT</Label>
          <div
            className="mt-[7px] flex flex-col gap-1.5 leading-[1.5] text-[rgba(220,232,248,.88)]"
            style={{ fontSize: wide ? 12.5 : 11.5 }}
          >
            {questions.map((q, i) => (
              <div key={i} className="flex gap-2">
                <span aria-hidden className="shrink-0 font-mono text-[rgba(220,235,255,.7)]">
                  ◇
                </span>
                <span className="text-pretty">{q}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {last && (
        <div>
          {!wide && <Label>REVIEWS</Label>}
          <div className={wide ? '' : 'mt-[7px]'}>
            <ReviewCard
              review={last}
              earlier={reviews.slice(0, -1)}
              model={lastModel ? modelLabel(lastModel, (id) => modelNameForId(id, models)) : undefined}
              wide={wide}
            />
          </div>
        </div>
      )}
      {happened.length > 0 && (
        <div>
          <Label>WHAT HAPPENED</Label>
          <div className="mt-[7px] grid grid-cols-[38px_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono text-[10px] leading-[1.5] text-[rgba(200,214,235,.78)]">
            {happened.map((h, i) => (
              <Row key={i} time={clock(h.at)}>
                {h.text}
              </Row>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function Row({ time, children }: { time: string; children: ReactNode }) {
  return (
    <>
      <span className="text-[rgba(160,190,225,.5)]">{time}</span>
      <span>{children}</span>
    </>
  )
}

/** The record's body: the current run, then earlier runs marked "before going back" (30e). */
export function RecordBody({
  harness,
  events,
  index,
  wide,
}: {
  harness: SessionHarness
  events: readonly HarnessEvent[]
  index: number
  wide: boolean
}) {
  const { state, own } = useStepRecord(harness, events, index)
  const runs = state.previousRuns ?? []
  const since = runs.length > 0 ? runs[runs.length - 1].endedAt : 0
  let from = 0
  return (
    <>
      <Sections record={state} own={own} happened={whatHappened(own, harness.steps, since, Infinity)} wide={wide} />
      {runs
        .map((run) => {
          const happened = whatHappened(own, harness.steps, from, run.endedAt)
          from = run.endedAt
          return { run, happened }
        })
        .reverse()
        .map(({ run, happened }, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-[9px] border border-dashed border-[rgba(150,205,255,.16)] px-3 py-[11px]">
            <div className="font-mono text-[9px] tracking-[0.18em] text-[rgba(200,220,245,.75)]">
              {run.reason === 'went_back' ? 'BEFORE GOING BACK' : 'BEFORE YOU REOPENED IT'} · {clock(run.endedAt)}
            </div>
            <Sections record={run} own={own} happened={happened} wide={wide} />
          </div>
        ))}
    </>
  )
}

/** The commit line pinned to the record's foot: "3f9c21a..8be04d7  3 commits · +212 −18". */
function CommitLine({ sessionId, index, state }: { sessionId: string; index: number; state: StepState }) {
  const { diff } = useStepDiff(sessionId, index, state)
  if (!state.startHead || !state.endHead) return null
  return (
    <>
      {shortSha(state.startHead)}..{shortSha(state.endHead)}
      {diff && (
        <span className="text-[rgba(160,190,225,.6)]">
          {diff.commits !== null ? plural(diff.commits, 'commit') : plural(diff.parsed.files.length, 'file')} · +{diff.parsed.added} −{diff.parsed.removed}
        </span>
      )}
    </>
  )
}

/**
 * A step's record in the side slot (canvas 30e, left): it replaces the
 * checklist; ‹ returns. Commits and Go back here are pinned to the foot.
 */
export function RecordView({
  sessionId,
  harness,
  events,
  index,
  chrome,
  onBack,
  onDiff,
  onGoBack,
}: {
  sessionId: string
  harness: SessionHarness
  events: readonly HarnessEvent[]
  index: number
  chrome: Chrome
  onBack: () => void
  onDiff: () => void
  /** Null when the record is read-only or the step has no start to go back to. */
  onGoBack: (() => void) | null
}) {
  const { step, state, kind, meta } = useStepRecord(harness, events, index)
  const hasRange = !!(state.startHead && state.endHead)
  return (
    <>
      <HeaderBlock chrome={chrome}>
        {chrome.row(
          <>
            <button type="button" onClick={onBack} className="font-mono text-[10.5px] text-[oklch(85%_.12_205)] hover:brightness-110">
              ‹ checklist
            </button>
            <span aria-hidden className="flex-1" />
            <Kicker>
              RECORD · STEP {pad2(index + 1)} OF {pad2(harness.steps.length)}
            </Kicker>
          </>,
        )}
        <div className="mt-2.5 flex gap-2.5">
          <span className="mt-[5px]">
            <Marker kind={kind} gate={isGateShape(kind, step)} />
          </span>
          <div className="text-pretty text-[14px] font-semibold leading-[1.38] text-text-bright">{step.title}</div>
        </div>
        <div className="ml-[19px] mt-1.5 font-mono text-[10px] text-[rgba(160,190,225,.6)]">{meta}</div>
      </HeaderBlock>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[18px] py-3">
        <RecordBody harness={harness} events={events} index={index} wide={false} />
      </div>
      {(hasRange || onGoBack) && (
        <div className="flex flex-col gap-2.5 border-t border-[rgba(150,205,255,.1)] px-[18px] pb-3.5 pt-3">
          {hasRange && (
            <div className="flex items-center gap-2 font-mono text-[10.5px] text-[#e8eef8]">
              <CommitLine sessionId={sessionId} index={index} state={state} />
              <span aria-hidden className="flex-1" />
              <button
                type="button"
                onClick={onDiff}
                className="shrink-0 font-mono text-[10.5px] tracking-[0.06em] text-[oklch(85%_.12_205)] hover:brightness-110"
              >
                Show diff →
              </button>
            </div>
          )}
          {onGoBack && (
            <div className="flex items-center gap-2">
              <OutlineButton onClick={onGoBack}>↶ Go back here</OutlineButton>
              <span className="font-mono text-[9.5px] text-[rgba(160,190,225,.5)]">rewinds to the start of step {index + 1}</span>
            </div>
          )}
        </div>
      )}
    </>
  )
}

/** The full window's record column (canvas 30h, middle). */
export function WideRecord({
  sessionId,
  harness,
  events,
  index,
  onGoBack,
}: {
  sessionId: string
  harness: SessionHarness
  events: readonly HarnessEvent[]
  index: number
  onGoBack: (() => void) | null
}) {
  const { step, state, who, kind } = useStepRecord(harness, events, index)
  const time = kind === 'doneUnsure' ? clock(state.reviews?.[state.reviews.length - 1]?.at) : ''
  return (
    <div className="flex min-h-0 flex-col gap-[18px] overflow-y-auto px-[26px] py-5">
      <div className="font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.55)]">
        {['RECORD', `STEP ${pad2(index + 1)}`, who, time].filter(Boolean).join(' · ')}
      </div>
      <div className="text-pretty text-[18px] font-bold leading-[1.35] tracking-[-0.01em] text-text-bright">{step.title}</div>
      <RecordBody harness={harness} events={events} index={index} wide />
      <span aria-hidden className="flex-1" />
      {(state.startHead || onGoBack) && (
        <div className="flex items-center gap-3 border-t border-[rgba(150,205,255,.1)] pt-3 font-mono text-[10.5px] text-[#e8eef8]">
          <CommitLine sessionId={sessionId} index={index} state={state} />
          <span aria-hidden className="flex-1" />
          {onGoBack && (
            <span className="font-sans">
              <OutlineButton onClick={onGoBack}>↶ Go back here</OutlineButton>
            </span>
          )}
        </div>
      )}
    </div>
  )
}
