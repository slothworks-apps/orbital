/**
 * The phone's harness gate, the pure part (spec 2026-10-05-mobile-next § 1;
 * canvas 10b, 10c): what the transcript's last row says about the harness —
 * the waiting card, the reviewer's card, the folded line after an answer, the
 * reopened note — what the Go back sheet says, and what the header's
 * segments and the steps sheet's rail show. The desktop's model
 * (`panels/harness/model.ts`) decides every step's kind; this only picks
 * what the phone draws from it.
 */

import { currentIndex as graphCurrentIndex, depsOf } from '../../lib/harnessGraph'
import { findPathMatches, isImagePath } from '../../lib/pathLinks'
import type { ApiSession, ChatMessage, HarnessEvent, SessionHarness } from '../../lib/types'
import {
  clock,
  eventsOfHarness,
  eventsOfStep,
  footerLine,
  headerStatus,
  isDone,
  isGateShape,
  pad2,
  railItems,
  scopeChip,
  shortSha,
  stepKind,
  stepWho,
  type StepKind,
} from '../../panels/harness/model'

/** One step's kind as the desktop's rail decides it, from its own events. */
function kindsOf(harness: SessionHarness, events: readonly HarnessEvent[]): StepKind[] {
  const own = eventsOfHarness(harness, events)
  return harness.steps.map((step, i) =>
    stepKind(step, harness.state[i] ?? { status: 'pending' }, harness, eventsOfStep(own, step, i, harness.createdAt)),
  )
}

/**
 * The step the harness stands at: a gate waiting for the user first — with
 * branches it need not be the first step not done — else the first one not
 * done, or -1 when every one is (`lib/harnessGraph`).
 */
export function currentIndex(harness: Pick<SessionHarness, 'state'>): number {
  return graphCurrentIndex(harness.state)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The image paths a step's summary or evidence names, in order and once
 * each: the card's thumbnails (spec Decision 4 — there is no screenshot
 * field, so a path in the words is all there is).
 */
export function gateImages(texts: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    for (const match of findPathMatches(text)) if (isImagePath(match.path)) seen.add(match.path)
  }
  return [...seen]
}

/** Every path a step's summary or evidence names: what 10c's reviewer line says it reads. */
function namedPaths(texts: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  for (const text of texts) if (text) for (const match of findPathMatches(text)) seen.add(match.path)
  return [...seen]
}

/** "8be04d7..c40a1e5", or null without both ends (spec Decision 5: no count). */
export function commitRange(state: { startHead?: string; endHead?: string }): string | null {
  return state.startHead && state.endHead ? `${shortSha(state.startHead)}..${shortSha(state.endHead)}` : null
}

/**
 * 10c asleep's short summary: the summary's first sentence, and how many
 * questions are open.
 */
export function shortSummary(summary: string | undefined, questions: number): string {
  const first = (summary ?? '').trim().split(/(?<=[.!?])\s+|\n/)[0] ?? ''
  const tail = questions > 0 ? `${plural(questions, 'open question')}.` : ''
  return [first, tail].filter(Boolean).join(' ')
}

/** What the card says about the gate it stands for (10b first phone, 10c). */
export interface GateCardData {
  index: number
  /** The step's number as read (1-based) and the step count. */
  step: number
  total: number
  title: string
  summary: string | null
  openQuestions: string[]
  /** Paths of images the step's words name (Decision 4). */
  images: string[]
  range: string | null
  /** The last tick's verify passed: "✓ verify passed". */
  verifyPassed: boolean
  next: { step: number; title: string; gate: boolean } | null
  /** 10c's "reading · diff <range> · <files>"; null when there is nothing to name. */
  reading: string | null
}

/**
 * The answer this phone gave, kept by the screen until the agent speaks
 * again (`foldStands`): what the card folds into.
 */
export type GateFold = { kind: 'approved' | 'rewound'; index: number; total: number; at: number }

export type GateView =
  | { kind: 'none' }
  | ({ kind: 'waiting' | 'reviewing' } & GateCardData)
  | { kind: 'fold'; mark: '✓' | '↺'; text: string }
  | { kind: 'reopened'; step: number; at: number | null }

/** The fold line's words (10b `ack`). */
export function foldLine(fold: GateFold): { mark: '✓' | '↺'; text: string } {
  const n = fold.index + 1
  if (fold.kind === 'rewound') return { mark: '↺', text: `Back at the start of step ${n} · the agent starts it again` }
  return {
    mark: '✓',
    text: n < fold.total ? `Approved step ${n} · on to step ${n + 1}` : `Approved step ${n} · every step is done`,
  }
}

/**
 * Whether the fold still ends the transcript: until the agent writes after
 * the answer, whose reply is then what the reader looks at.
 */
export function foldStands(fold: GateFold, messages: readonly Pick<ChatMessage, 'role' | 'timestamp'>[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || !m.timestamp) continue
    if (Date.parse(m.timestamp) > fold.at) return false
    break
  }
  return true
}

function cardData(harness: SessionHarness, events: readonly HarnessEvent[], index: number): GateCardData {
  const step = harness.steps[index]
  const state = harness.state[index]
  const own = eventsOfStep(eventsOfHarness(harness, events), step, index, harness.createdAt)
  let verifyPassed = false
  for (let i = own.length - 1; i >= 0; i--) {
    if (own[i].kind !== 'ticked') continue
    verifyPassed = own[i].detail.verify === 'passed'
    break
  }
  // What the approval opens: the first step that needs this one.
  const nextIndex = harness.steps.findIndex((_, j) => j > index && depsOf(harness.steps, j).includes(step.id))
  const nextStep = nextIndex === -1 ? undefined : harness.steps[nextIndex]
  const range = commitRange(state)
  const words = [state.summary, state.evidence]
  const files = namedPaths(words)
  const reading = [range ? `diff ${range}` : null, ...files].filter(Boolean)
  return {
    index,
    step: index + 1,
    total: harness.steps.length,
    title: step.title,
    summary: state.summary?.trim() || null,
    openQuestions: state.openQuestions ?? [],
    images: gateImages(words),
    range,
    verifyPassed,
    next: nextStep ? { step: nextIndex + 1, title: nextStep.title, gate: nextStep.mode === 'gate' } : null,
    reading: reading.length > 0 ? `reading · ${reading.join(' · ')}` : null,
  }
}

/**
 * What ends the transcript for this harness. A standing gate wins — waiting
 * on the user (10b) or on the reviewer (10c); then this phone's own answer,
 * folded, while it stands; then a step the user reopened, until the agent
 * ticks it again (10b third phone).
 */
export function gateView(input: {
  harness: SessionHarness | null | undefined
  events: readonly HarnessEvent[]
  fold: GateFold | null
}): GateView {
  const { harness, events, fold } = input
  if (!harness || harness.removedAt != null) return fold ? { kind: 'fold', ...foldLine(fold) } : { kind: 'none' }
  const index = currentIndex(harness)
  const state = index >= 0 ? harness.state[index] : undefined
  if (state?.status === 'awaiting_approval') {
    return { kind: state.reviewing ? 'reviewing' : 'waiting', ...cardData(harness, events, index) }
  }
  if (fold) return { kind: 'fold', ...foldLine(fold) }
  if (index >= 0 && kindsOf(harness, events)[index] === 'reopened') {
    const step = harness.steps[index]
    const own = eventsOfStep(eventsOfHarness(harness, events), step, index, harness.createdAt)
    const reopened = own.filter((e) => e.kind === 'reopened').at(-1)
    return { kind: 'reopened', step: index + 1, at: reopened?.at ?? null }
  }
  return { kind: 'none' }
}

/** What the Go back sheet says (10b second phone; the desktop's `GoBackDialog` for `running`). */
export function goBackLines(
  harness: SessionHarness,
  index: number,
  running: boolean,
): { eyebrow: string; title: string; body: string; detail: string[]; confirm: string } {
  const n = index + 1
  const range = commitRange(harness.state[index] ?? {})
  return {
    eyebrow: `GO BACK · STEP ${pad2(n)}`,
    title: `Go back to the start of step ${n}?`,
    body:
      (running ? 'The turn and anything running in the session stop. ' : '') +
      `The conversation returns to the message that sent the agent on to step ${n}, and the agent starts the step again.`,
    detail: [...(range ? [`Commits stay in git · ${range}`] : []), 'Orbital never resets files for you'],
    confirm: `Go back to step ${n}`,
  }
}

/**
 * A header segment's tone (canvas 10b `segC`): done mint, waiting amber, at
 * work cyan, reopened neutral, pending faint. The reviewer reading and a
 * pause the canvas does not draw take the desktop pill's tones.
 */
export type SegmentTone = 'done' | 'waiting' | 'active' | 'reopened' | 'reviewing' | 'paused' | 'pending'

export function segmentTone(kind: StepKind): SegmentTone {
  if (isDone(kind)) return 'done'
  switch (kind) {
    case 'waiting':
      return 'waiting'
    case 'reviewing':
      return 'reviewing'
    case 'reopened':
      return 'reopened'
    case 'pausedHere':
      return 'paused'
    case 'active':
    case 'sentBack':
      return 'active'
    default:
      return 'pending'
  }
}

/**
 * The header's segments and count. From the harness when one is held; else
 * from the snapshot's `harnessStep` (the steps before it done, its own tone
 * from the gate), so the header reads before the harness arrives.
 */
export function progress(
  harness: SessionHarness | null | undefined,
  events: readonly HarnessEvent[],
  session: Pick<ApiSession, 'harnessStep' | 'harnessGate'>,
): { tones: SegmentTone[]; count: string } | null {
  if (harness && harness.removedAt == null && harness.steps.length > 0) {
    const tones = kindsOf(harness, events).map(segmentTone)
    const at = currentIndex(harness)
    const total = harness.steps.length
    return { tones, count: at === -1 ? `${total}/${total}` : `${at + 1}/${total}` }
  }
  const step = session.harnessStep
  if (!step || step.total <= 0) return null
  const here: SegmentTone =
    session.harnessGate === 'waiting' ? 'waiting' : session.harnessGate === 'reviewing' ? 'reviewing' : 'active'
  const tones = Array.from({ length: step.total }, (_, i): SegmentTone =>
    i < step.index ? 'done' : i === step.index ? here : 'pending',
  )
  return { tones, count: `${Math.min(step.index + 1, step.total)}/${step.total}` }
}

/** One rail row of the steps sheet (10b fourth phone, `hSteps`). */
export interface StepRow {
  index: number
  /** "4 · Visual parity …" */
  title: string
  kind: StepKind
  gate: boolean
  meta: string
  /** A done step opens its record. */
  record: boolean
}

export type SheetItem = ({ type: 'step' } & StepRow) | { type: 'event'; id: number; text: string }

/** The steps sheet: its header lines, the rail in the desktop's order, the footer. */
export function stepsSheet(
  harness: SessionHarness,
  events: readonly HarnessEvent[],
): { eyebrow: string; name: string; status: { step: string; status: string; ink: string; started: string }; items: SheetItem[]; footer: string } {
  const own = eventsOfHarness(harness, events)
  const kinds = kindsOf(harness, events)
  const chip = scopeChip(harness, events)
  const head = headerStatus(harness, kinds)
  const items: SheetItem[] = railItems(harness, events).map((item) => {
    if (item.kind === 'event') return { type: 'event', id: item.event.id, text: item.text }
    const i = item.index
    const step = harness.steps[i]
    const state = harness.state[i] ?? { status: 'pending' as const }
    const kind = kinds[i]
    const who = stepWho(kind, step, state, harness, eventsOfStep(own, step, i, harness.createdAt))
    const questions = kind === 'waiting' ? (state.openQuestions?.length ?? 0) : 0
    // A step that names what it needs says it, so the branches read in a list.
    const needs = step.dependsOn ? `← ${step.dependsOn.map((id) => harness.steps.findIndex((s) => s.id === id) + 1).join(', ') || 'none'}` : null
    return {
      type: 'step',
      index: i,
      title: `${i + 1} · ${step.title}`,
      kind,
      gate: isGateShape(kind, step),
      meta: [who, questions > 0 ? plural(questions, 'open question') : null, needs].filter(Boolean).join(' · '),
      record: isDone(kind),
    }
  })
  return {
    eyebrow: chip ? `HARNESS · ${chip.replace(' · ', ' ').toUpperCase()}` : 'HARNESS',
    name: harness.name,
    status: { step: head.step, status: head.status, ink: head.ink, started: `started ${clock(harness.createdAt)}` },
    items,
    footer: footerLine(!harness.paused, harness.options.lucky),
  }
}
