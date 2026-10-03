/**
 * The harness panel's pure model (canvas `Feature - Harness` 30b–30h; spec
 * 2026-10-02-harness-redesign-design): which marker a step wears, what its
 * mono line says, where the harness's own events sit between the steps, and
 * the lines a step's record shows under WHAT HAPPENED. Times are clock times,
 * never durations (30d RULES, 30g).
 */

import type { HarnessEvent, HarnessStep, PauseKind, SessionHarness, StepReview, StepState } from '../../lib/types'

/** 24 h clock time, `22:46` (30g: "times are clock times, never “12 min ago”"). */
export function clock(at: number | undefined | null): string {
  if (at === undefined || at === null) return ''
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export const pad2 = (n: number) => String(n).padStart(2, '0')

export const shortSha = (sha: string) => sha.slice(0, 7)

/**
 * The step marker's kinds (30d, THE MARKER). Shape says auto or gate, fill
 * says who finished it.
 */
export type StepKind =
  | 'pending'
  | 'pendingGate'
  | 'active'
  | 'pausedHere'
  | 'sentBack'
  | 'reopened'
  | 'waiting'
  | 'reviewing'
  | 'doneAgent'
  | 'doneYou'
  | 'doneRev'
  | 'doneUnsure'

const lastOf = <T>(list: readonly T[] | undefined): T | undefined => (list && list.length > 0 ? list[list.length - 1] : undefined)

/** The step's events, oldest first, from this harness on. */
export function eventsOfStep(events: readonly HarnessEvent[], step: HarnessStep, index: number, since: number): HarnessEvent[] {
  return events
    .filter((e) => e.at >= since && (e.detail.step === step.id || (e.detail.step === undefined && e.detail.index === index)))
    .sort((a, b) => a.at - b.at || a.id - b.id)
}

/** The harness's events from its start on, oldest first (a removed one before it may share the log). */
export function eventsOfHarness(harness: SessionHarness, events: readonly HarnessEvent[]): HarnessEvent[] {
  return events.filter((e) => e.at >= harness.createdAt).sort((a, b) => a.at - b.at || a.id - b.id)
}

/** The step's latest event of `kind`. */
function latest(events: readonly HarnessEvent[], kind: HarnessEvent['kind']): HarnessEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === kind) return events[i]
  return undefined
}

/**
 * Which marker the step wears. `stepEvents` are the step's own (oldest
 * first); they tell a step the user reopened from one simply at work.
 */
export function stepKind(
  step: HarnessStep,
  state: StepState,
  harness: Pick<SessionHarness, 'paused'>,
  stepEvents: readonly HarnessEvent[] = [],
): StepKind {
  switch (state.status) {
    case 'pending':
      return step.mode === 'gate' ? 'pendingGate' : 'pending'
    case 'awaiting_approval':
      return state.reviewing ? 'reviewing' : 'waiting'
    case 'done': {
      if (step.mode === 'auto') return 'doneAgent'
      if (state.approvedBy === 'reviewer') return lastOf(state.reviews)?.uncertain ? 'doneUnsure' : 'doneRev'
      return 'doneYou'
    }
    case 'active': {
      if (harness.paused) return 'pausedHere'
      if (lastOf(state.reviews)?.verdict === 'reopen') return 'sentBack'
      const lastStart = Math.max(latest(stepEvents, 'advanced')?.at ?? 0, latest(stepEvents, 'carried_over')?.at ?? 0)
      const reopened = latest(stepEvents, 'reopened')
      if (reopened && reopened.at >= lastStart) return 'reopened'
      return 'active'
    }
  }
}

export const isDone = (kind: StepKind) => kind.startsWith('done')
export const isGateShape = (kind: StepKind, step: HarnessStep) => step.mode === 'gate' || kind === 'pendingGate'

/**
 * Only these open by default (30d RULES): the active one, the waiting one, the
 * one being reviewed — and, as 30d A draws it, a gate the reviewer approved
 * unsure, since its open questions are left for you.
 */
export function opensByDefault(kind: StepKind): boolean {
  return kind === 'active' || kind === 'sentBack' || kind === 'pausedHere' || kind === 'reopened' || kind === 'waiting' || kind === 'reviewing'
    || kind === 'doneUnsure'
}

const AMB = '#ffbb7b'
const CY = '#59e4f3'
const MINT = '#7fe3b0'
const NEU = 'rgba(200,220,245,.8)'
const MUT = 'rgba(160,190,225,.6)'

export interface MarkerStyle {
  /** The 1.4 px border's colour and stroke. */
  border: string
  stroke: 'solid' | 'dashed'
  fill: string
  shadow: string
  /** Title ink and meta ink on the rail. */
  titleInk: string
  metaInk: string
  /** The header bar's segment colour. */
  segment: string
}

/** Canvas 30d's `V` table, verbatim. */
export const MARKER: Record<StepKind, MarkerStyle> = {
  pending: { border: 'rgba(160,190,225,.4)', stroke: 'solid', fill: 'transparent', shadow: 'none', titleInk: 'rgba(200,214,235,.62)', metaInk: 'rgba(160,190,225,.5)', segment: 'rgba(150,205,255,.14)' },
  pendingGate: { border: 'rgba(160,190,225,.4)', stroke: 'solid', fill: 'transparent', shadow: 'none', titleInk: 'rgba(200,214,235,.62)', metaInk: 'rgba(160,190,225,.5)', segment: 'rgba(150,205,255,.14)' },
  active: { border: CY, stroke: 'solid', fill: CY, shadow: '0 0 0 3px rgba(89,228,243,.14)', titleInk: '#e8eef8', metaInk: CY, segment: CY },
  reopened: { border: CY, stroke: 'solid', fill: CY, shadow: '0 0 0 3px rgba(89,228,243,.14)', titleInk: '#e8eef8', metaInk: NEU, segment: CY },
  pausedHere: { border: CY, stroke: 'solid', fill: 'transparent', shadow: 'none', titleInk: '#e8eef8', metaInk: NEU, segment: 'rgba(89,228,243,.45)' },
  sentBack: { border: CY, stroke: 'solid', fill: CY, shadow: '0 0 0 3px rgba(89,228,243,.14)', titleInk: '#e8eef8', metaInk: NEU, segment: CY },
  waiting: { border: AMB, stroke: 'solid', fill: AMB, shadow: '0 0 0 3px rgba(255,187,123,.12)', titleInk: '#e8eef8', metaInk: AMB, segment: AMB },
  reviewing: { border: 'rgba(220,235,255,.75)', stroke: 'solid', fill: 'rgba(220,235,255,.12)', shadow: 'none', titleInk: '#e8eef8', metaInk: NEU, segment: 'rgba(220,235,255,.5)' },
  doneAgent: { border: MINT, stroke: 'solid', fill: MINT, shadow: 'none', titleInk: 'rgba(220,235,255,.8)', metaInk: MUT, segment: 'rgba(127,227,176,.75)' },
  doneYou: { border: MINT, stroke: 'solid', fill: MINT, shadow: 'none', titleInk: 'rgba(220,235,255,.8)', metaInk: MUT, segment: 'rgba(127,227,176,.75)' },
  doneRev: { border: MINT, stroke: 'solid', fill: 'transparent', shadow: 'none', titleInk: 'rgba(220,235,255,.8)', metaInk: MUT, segment: 'rgba(127,227,176,.75)' },
  doneUnsure: { border: MINT, stroke: 'dashed', fill: 'transparent', shadow: 'none', titleInk: 'rgba(220,235,255,.8)', metaInk: MUT, segment: 'rgba(127,227,176,.75)' },
}

export const INK = { AMB, CY, MINT, NEU, MUT }

/** When the user approved a gate: the `approved` event, else the tick. */
function approvedAt(state: StepState, stepEvents: readonly HarnessEvent[]): number | undefined {
  return latest(stepEvents, 'approved')?.at ?? state.completedAt
}

/** "who/what · time" — the third part of the step's mono line (30d: "NN · auto|gate · who/what · time"). */
export function stepWho(
  kind: StepKind,
  step: HarnessStep,
  state: StepState,
  harness: Pick<SessionHarness, 'pauseKind' | 'options'>,
  stepEvents: readonly HarnessEvent[],
): string {
  switch (kind) {
    case 'pending':
    case 'pendingGate':
      return step.verify ? 'verify set' : ''
    case 'active':
      return 'working'
    case 'reopened':
      return 'reopened by you'
    case 'pausedHere':
      return harness.pauseKind === 'nudge_cap' && state.nudges ? `paused here · ${state.nudges} nudges, no tick` : 'paused here'
    case 'sentBack':
      return `sent back by reviewer · ${state.reviewerReopens ?? 1} of ${harness.options.maxReviewerReopens}`
    case 'waiting':
      return 'needs your OK'
    case 'reviewing':
      return 'reviewer reading'
    case 'doneAgent':
      return `ticked ${clock(state.completedAt)}`.trim()
    case 'doneYou':
      return `you approved ${clock(approvedAt(state, stepEvents))}`.trim()
    case 'doneRev':
      return `reviewer approved ${clock(lastOf(state.reviews)?.at)}`.trim()
    case 'doneUnsure':
      return 'reviewer approved, unsure'
  }
}

/** The whole mono line under a step's title. */
export function stepMeta(index: number, step: HarnessStep, who: string): string {
  return [pad2(index + 1), step.mode, who].filter(Boolean).join(' · ')
}

/** The record header's line: "gate · reviewer approved, unsure · 23:10" (30e). */
export function recordMeta(kind: StepKind, step: HarnessStep, state: StepState, who: string): string {
  const time = kind === 'doneUnsure' ? clock(lastOf(state.reviews)?.at) : ''
  return [step.mode, who, time].filter(Boolean).join(' · ')
}

/** The header's status (30b/30d): the word and its ink. */
export function headerStatus(harness: SessionHarness, kinds: readonly StepKind[]): { step: string; status: string; ink: string } {
  const total = harness.steps.length
  const current = kinds.findIndex((k) => !isDone(k))
  if (current === -1) return { step: `${total} of ${total} done`, status: 'finished', ink: MUT }
  const step = `step ${current + 1} of ${total}`
  if (harness.paused) return { step, status: 'paused', ink: NEU }
  switch (kinds[current]) {
    case 'waiting':
      return { step, status: 'needs your OK', ink: AMB }
    case 'reviewing':
      return { step, status: 'reviewer reading', ink: NEU }
    case 'sentBack':
      return { step, status: 'working · sent back', ink: CY }
    case 'reopened':
      return { step, status: 'reopened · your turn', ink: NEU }
    default:
      return { step, status: 'working', ink: CY }
  }
}

/** The footer line for each switch combination (30f, THE SWITCH ROW). */
export function footerLine(autoContinue: boolean, lucky: boolean): string {
  if (autoContinue) return lucky ? 'feeling lucky · the reviewer decides gates' : 'auto-continue · sent on when nothing needs you'
  return lucky ? 'paused · the reviewer still reads gates' : 'paused · nothing is sent on'
}

/** The pause banner's right-hand label (30f, PAUSE REASONS). */
export const PAUSE_LABEL: Record<PauseKind, string> = {
  user: 'by you',
  nudge_cap: 'nudge cap',
  message_cap: 'message cap',
  review_failed: 'reviewer failed',
  send_failed: 'not sent',
  session_ended: 'session ended',
}

/** The pause banner's quiet hint under the reason (30b, 30d C). */
export function pauseHint(kind: PauseKind | null): string {
  switch (kind) {
    case 'user':
      return 'the agent can still be messaged as usual'
    case 'nudge_cap':
    case 'message_cap':
    case 'send_failed':
      return 'turn auto-continue back on to resume · or write to the agent first'
    case 'review_failed':
      return 'the gate waits for you'
    default:
      return ''
  }
}

/** The short form of a pause for the dashed row between steps. */
function pauseShort(detail: Record<string, unknown>, harness: SessionHarness): string {
  if (detail.by === 'user') return 'paused by you'
  switch (detail.kind) {
    case 'nudge_cap':
      return `paused · stuck: ${harness.options.maxIdleNudges} nudges without a tick`
    case 'message_cap':
      return `paused · cap: ${harness.options.maxAutoRounds} messages sent on its own`
    case 'session_ended':
      return 'paused · the session ended'
    case 'review_failed':
      return 'paused · the reviewer could not decide'
    case 'send_failed':
      return 'paused · a message could not be sent'
    default:
      return 'paused'
  }
}

/** A harness-level event (30g, "between steps"), as its dashed row reads, or null for a step's own. */
export function harnessEventText(event: HarnessEvent, harness: SessionHarness): string | null {
  const at = clock(event.at)
  const index = typeof event.detail.index === 'number' ? event.detail.index : undefined
  switch (event.kind) {
    case 'attached':
      return `started · ${at}`
    case 'paused':
      // A session that ended mid-step is a step's pause, but it still reads between steps.
      return `${pauseShort(event.detail, harness)} · ${at}`
    case 'resumed':
      return `resumed · ${at}`
    case 'went_back':
      return index !== undefined ? `went back to step ${index + 1} · ${at}` : `went back · ${at}`
    case 'removed':
      return typeof event.detail.carriedTo === 'string' ? `carried to a new session · ${at}` : `removed · ${at}`
    case 'carried_over':
      return `carried over from an earlier session · ${at}`
    default:
      return null
  }
}

export type RailItem =
  | { kind: 'step'; index: number }
  | { kind: 'event'; event: HarnessEvent; text: string }

/**
 * The rail in order: each step, and between them the harness's own events,
 * each after the step that was current when it happened (30d C: "paused"
 * after the step paused at). `started` sits above the first step.
 */
export function railItems(harness: SessionHarness, events: readonly HarnessEvent[]): RailItem[] {
  const own = eventsOfHarness(harness, events)
    .map((event) => ({ event, text: harnessEventText(event, harness) }))
    .filter((e): e is { event: HarnessEvent; text: string } => e.text !== null)
  const n = harness.steps.length
  const after: { event: HarnessEvent; text: string }[][] = Array.from({ length: n }, () => [])
  const before: { event: HarnessEvent; text: string }[] = []
  for (const e of own) {
    if (e.event.kind === 'attached' || n === 0) {
      before.push(e)
      continue
    }
    const index = typeof e.event.detail.index === 'number' ? e.event.detail.index : undefined
    // The step current at the time: the first one not finished by then.
    let current = index ?? harness.state.findIndex((s) => !(s.status === 'done' && (s.completedAt ?? Infinity) <= e.event.at))
    if (current === -1 || current >= n || e.event.kind === 'removed') current = n - 1
    after[Math.max(0, current)].push(e)
  }
  const items: RailItem[] = before.map((e) => ({ kind: 'event', ...e }))
  for (let i = 0; i < n; i++) {
    items.push({ kind: 'step', index: i })
    for (const e of after[i]) items.push({ kind: 'event', ...e })
  }
  return items
}

/** A review's verdict as the record says it (30n: approved · approved, unsure · sent back). */
export function verdictWord(review: Pick<StepReview, 'verdict' | 'uncertain'>): string {
  if (review.verdict === 'reopen') return 'sent back'
  return review.uncertain ? 'approved, unsure' : 'approved'
}

/** One line under WHAT HAPPENED for a step's own event, or null when it says nothing new. */
export function stepEventLine(event: HarnessEvent, steps: readonly HarnessStep[]): string | null {
  const d = event.detail
  switch (event.kind) {
    case 'advanced': {
      const index = typeof d.index === 'number' ? d.index : steps.findIndex((s) => s.id === d.step)
      return `sent on to step ${index + 1}`
    }
    case 'ticked':
      return ['ticked', d.verify === 'passed' ? 'verify passed' : null, d.gate === true ? 'stopped for review' : null]
        .filter(Boolean)
        .join(' · ')
    case 'verify_failed':
      return 'verify failed · the tick is undone'
    case 'nudged':
      return typeof d.n === 'number' && typeof d.of === 'number' ? `nudged ${d.n} of ${d.of}` : 'nudged'
    case 'watcher_stop':
      return typeof d.reason === 'string' && d.reason ? `stopped for you · ${d.reason}` : 'stopped for you'
    case 'approved':
      return d.by === 'reviewer' ? null : 'you approved'
    case 'reopened':
      return 'you reopened · nothing sent'
    case 'review_started':
      return 'reviewer reading'
    case 'reviewed':
      return `reviewer ${verdictWord({ verdict: d.verdict === 'approve' ? 'approve' : 'reopen', uncertain: d.uncertain === true })}`
    case 'review_failed':
      return 'the reviewer could not decide'
    case 'review_aborted':
      return d.by === 'user'
        ? 'you took the gate · the reviewer stopped'
        : d.by === 'lucky_off'
          ? 'feeling lucky off · the reviewer stopped'
          : 'the reviewer stopped with Orbital'
    case 'went_back':
      return 'went back here'
    case 'carried_over':
      return 'carried over to a new session'
    case 'paused':
      return d.kind === 'session_ended' ? 'paused · the session ended' : null
    default:
      return null
  }
}

/** WHAT HAPPENED for one run of a step: `{ time, text }` rows, oldest first. */
export function whatHappened(
  stepEvents: readonly HarnessEvent[],
  steps: readonly HarnessStep[],
  from: number,
  to: number,
): { at: number; text: string }[] {
  return stepEvents
    .filter((e) => e.at >= from && e.at <= to)
    .map((e) => ({ at: e.at, text: stepEventLine(e, steps) }))
    .filter((r): r is { at: number; text: string } => r.text !== null)
}

/** The model a review ran on, from the `review_started` event before it; undefined when the log does not say. */
export function reviewModel(review: StepReview, stepEvents: readonly HarnessEvent[]): string | undefined {
  let model: string | undefined
  for (const e of stepEvents) {
    if (e.at > review.at) break
    if (e.kind === 'review_started' && typeof e.detail.model === 'string') model = e.detail.model
  }
  return model
}

/** "Opus" for `opus`, the catalog's name otherwise; the caller passes its lookup. */
export function modelLabel(model: string, lookup: (id: string) => string): string {
  if (/^(opus|sonnet|haiku|fable)$/i.test(model)) return model[0].toUpperCase() + model.slice(1).toLowerCase()
  return lookup(model)
}

/** The inputs line under the title: "component Button · figma …". */
export function inputsLine(inputs: Record<string, string>): string {
  return Object.entries(inputs)
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ')
}

/** The scope chip's text, from the `attached` event (the harness does not carry it). */
export function scopeChip(harness: SessionHarness, events: readonly HarnessEvent[]): string | null {
  const attached = eventsOfHarness(harness, events).find((e) => e.kind === 'attached')
  const scope = attached?.detail.scope as { kind?: string; name?: string; root?: string } | undefined
  if (!scope) return null
  if (scope.kind === 'global') return 'global'
  const name = scope.name ?? scope.root?.split('/').filter(Boolean).pop()
  return name ? `project · ${name}` : 'project'
}

/**
 * The full window's "N to look at" (30h): open questions plus unsure
 * approvals over the whole run — a fixed fact about it, not a growing count.
 */
export function toLookAt(harness: SessionHarness): number {
  return harness.state.reduce(
    (n, s) => n + (s.openQuestions?.length ?? 0) + (s.status === 'done' && s.approvedBy === 'reviewer' && lastOf(s.reviews)?.uncertain ? 1 : 0),
    0,
  )
}

/** The run's span "21:40 → 03:12", or just the start while it runs. */
export function runSpan(harness: SessionHarness, events: readonly HarnessEvent[]): string {
  const start = clock(harness.createdAt)
  const finished = harness.state.length > 0 && harness.state.every((s) => s.status === 'done')
  if (!finished) return start
  const end = latest(eventsOfHarness(harness, events), 'finished')?.at ?? Math.max(...harness.state.map((s) => s.completedAt ?? 0))
  return end ? `${start} → ${clock(end)}` : start
}

/** Steps a go-back to `index` turns pending again: it and every later one that has begun. */
export function stepsGoingBack(harness: SessionHarness, index: number): number[] {
  const out: number[] = []
  for (let i = index; i < harness.steps.length; i++) {
    if (i === index || harness.state[i]?.status !== 'pending') out.push(i)
  }
  return out
}

/** "3–4" or "3" for the go-back dialog's copy. */
export function stepRange(indices: readonly number[]): string {
  if (indices.length === 0) return ''
  const first = indices[0] + 1
  const last = indices[indices.length - 1] + 1
  return first === last ? String(first) : `${first}–${last}`
}
