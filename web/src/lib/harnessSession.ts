/**
 * The harness as the session around it shows it (canvas `Feature - Harness`
 * 30a-d, 30b, 30i; spec 2026-10-02-harness-redesign-design): the pill on the
 * session panel's edge, the dashed ◆ rows in the transcript, and which
 * sessions are listed at all. The panel's own model lives in
 * `panels/harness/`.
 */

import { currentIndex } from './harnessGraph'
import type { ApiSession, ChatMessage, HarnessEvent, HarnessMessageKind, PauseKind, SessionHarness } from './types'

/** The state tokens the harness draws in (30a-d's `AMB`, `CY`, `MINT`, `NEU`, `MUT`). */
export const HARNESS_INK = {
  amber: '#ffbb7b',
  cyan: '#59e4f3',
  mint: '#7fe3b0',
  neutral: 'rgba(200,220,245,.8)',
  muted: 'rgba(160,190,225,.6)',
} as const

/** 30a-d's segment colours, one per step state (`heads.seg`). */
const SEGMENT = {
  done: 'rgba(127,227,176,.75)',
  active: HARNESS_INK.cyan,
  waiting: HARNESS_INK.amber,
  reviewing: 'rgba(220,235,255,.5)',
  pending: 'rgba(150,205,255,.14)',
  pausedHere: 'rgba(89,228,243,.45)',
} as const

/**
 * Whether a session belongs in a list — the sidebar, history, search, the
 * example-session picker. A harness drafting conversation does not, during or
 * after: it lives on the map while it runs and nowhere else (spec § Overruled,
 * "The drafting session is listed nowhere").
 */
export const isListable = (session: Pick<ApiSession, 'purpose'>): boolean => session.purpose !== 'harness_draft'

/** The pill's state glyph (30a-d's six states, the first being no pill at all). */
export type PillGlyph = 'work' | 'gate' | 'eye' | 'pause' | 'done'

export interface PillReading {
  glyph: PillGlyph
  /** The glyph's ink. */
  ink: string
  /** One colour per step, in order. */
  segments: string[]
  /** `4/7`: the step it stands at, of all. */
  count: string
  /** The flyout's second line: the current step's title. */
  title: string
  /** The flyout's status word, in `statusInk`. */
  status: string
  statusInk: string
  /** What follows the status, muted: `2 open questions`. */
  detail: string | null
}

/** A pause in the harness's own words, short enough for one line (30f's reasons). */
export function pauseWords(kind: PauseKind | null, options: SessionHarness['options']): string {
  switch (kind) {
    case 'user':
      return 'paused by you'
    case 'nudge_cap':
      return `paused · stuck: ${options.maxIdleNudges} nudges without a tick`
    case 'message_cap':
      return `paused · cap: ${options.maxAutoRounds} messages sent on its own`
    case 'review_failed':
      return 'paused · the reviewer could not decide'
    case 'send_failed':
      return 'paused · a message could not be sent'
    case 'session_ended':
      return 'paused · the session ended'
    default:
      return 'paused'
  }
}

/** What the pill and its flyout say about a live harness (30a-d). */
export function pillReading(harness: SessionHarness): PillReading {
  const total = harness.steps.length
  const current = currentIndex(harness.state)
  const segments = harness.state.map((s, i) => {
    if (s.status === 'done') return SEGMENT.done
    if (s.status === 'awaiting_approval') return s.reviewing ? SEGMENT.reviewing : SEGMENT.waiting
    if (s.status === 'active') return harness.paused && i === current ? SEGMENT.pausedHere : SEGMENT.active
    return SEGMENT.pending
  })
  if (current === -1) {
    return {
      glyph: 'done', ink: HARNESS_INK.mint, segments, count: `${total}/${total}`,
      title: harness.steps[total - 1]?.title ?? harness.name,
      status: 'finished', statusInk: HARNESS_INK.muted, detail: null,
    }
  }
  const step = harness.state[current]
  const base = { segments, count: `${current + 1}/${total}`, title: harness.steps[current]?.title ?? '' }
  // A gate keeps its own glyph when paused: it still waits for you, and lucky still reviews it.
  if (step.status === 'awaiting_approval' && step.reviewing) {
    return { ...base, glyph: 'eye', ink: HARNESS_INK.neutral, status: 'reviewer reading', statusInk: HARNESS_INK.neutral, detail: null }
  }
  if (step.status === 'awaiting_approval') {
    const questions = step.openQuestions?.length ?? 0
    return {
      ...base, glyph: 'gate', ink: HARNESS_INK.amber, status: 'needs your OK', statusInk: HARNESS_INK.amber,
      detail: questions > 0 ? `${questions} open question${questions === 1 ? '' : 's'}` : null,
    }
  }
  if (harness.paused) {
    return {
      ...base, glyph: 'pause', ink: HARNESS_INK.neutral,
      status: pauseWords(harness.pauseKind, harness.options), statusInk: HARNESS_INK.neutral, detail: null,
    }
  }
  return { ...base, glyph: 'work', ink: HARNESS_INK.cyan, status: 'working', statusInk: HARNESS_INK.cyan, detail: null }
}

/** Whether a harness still has steps to do — what Clear offers to carry into the next session. */
export const harnessUnfinished = (harness: SessionHarness | null | undefined): harness is SessionHarness =>
  harness != null && harness.removedAt == null && harness.state.some((s) => s.status !== 'done')

/** The title of step `index` (0-based) in whichever of the session's harnesses has one. */
function stepTitle(harnesses: readonly SessionHarness[], index: number): string | undefined {
  for (const h of harnesses) {
    const title = h.steps[index]?.title
    if (title) return title
  }
  return undefined
}

/** The step's index (0-based) an event names, by `index` or by step id. */
function eventIndex(event: HarnessEvent, harnesses: readonly SessionHarness[]): number | undefined {
  if (typeof event.detail.index === 'number') return event.detail.index
  const id = event.detail.step
  if (typeof id !== 'string') return undefined
  for (const h of harnesses) {
    const i = h.steps.findIndex((s) => s.id === id)
    if (i !== -1) return i
  }
  return undefined
}

/**
 * The text after `harness · ` on the row of a message Orbital sent (30b):
 * `sent on to step 4 · Visual parity…`, `nudged · step 6`, `started · Build a
 * component`. `step` is 0-based; the rows count from 1.
 */
export function harnessMessageText(
  mark: { kind: HarnessMessageKind; step: number },
  harnesses: readonly SessionHarness[],
): string {
  const n = mark.step + 1
  const title = stepTitle(harnesses, mark.step)
  switch (mark.kind) {
    case 'kickoff':
      // A carried harness starts where the old session stood.
      if (mark.step > 0) return ['continued at step ' + n, title].filter(Boolean).join(' · ')
      return ['started', harnesses[0]?.name].filter(Boolean).join(' · ')
    case 'advance':
      return [`sent on to step ${n}`, title].filter(Boolean).join(' · ')
    case 'nudge':
      return `nudged · step ${n}`
    case 'findings':
      return `sent back · step ${n} · the reviewer's findings`
    case 'edited':
      return 'the checklist changed · the agent was told'
  }
}

/**
 * The text after `harness · ` for one event of the log, or null when the
 * transcript does not show it: the kickoff, the sends and the nudges are
 * there as messages already, and option changes are no event of the
 * conversation's.
 */
export function harnessEventText(
  event: HarnessEvent,
  harnesses: readonly SessionHarness[],
  next?: HarnessEvent,
): string | null {
  const index = eventIndex(event, harnesses)
  const step = index === undefined ? 'a step' : `step ${index + 1}`
  const d = event.detail
  switch (event.kind) {
    case 'ticked': {
      const ticked = `${step} ticked${d.verify === 'passed' ? ' · verify passed' : ''}`
      // A gate stops for you — unless the reviewer picks it up at once (lucky).
      if (d.gate !== true || (next?.kind === 'review_started' && eventIndex(next, harnesses) === index)) return ticked
      return `${ticked}\n` + `stopped for you · ${step} is a gate`
    }
    case 'verify_failed':
      return `${step} · verify failed`
    case 'watcher_stop':
      return `stopped for you · ${step}${typeof d.reason === 'string' && d.reason ? ` · ${d.reason}` : ''}`
    case 'review_started':
      return `reviewer is reading ${step}`
    case 'reviewed':
      if (d.verdict === 'reopen') return `reviewer sent ${step} back`
      return `reviewer approved ${step}${d.uncertain === true ? ', unsure' : ''}`
    case 'review_failed':
      return `reviewer could not decide ${step}`
    case 'review_aborted':
      if (d.by === 'user') return `you took ${step} from the reviewer`
      if (d.by === 'restart') return `review of ${step} stopped by a restart`
      return `review of ${step} stopped`
    case 'approved':
      // The reviewer's approval is its `reviewed` row.
      return d.by === 'reviewer' ? null : `you approved ${step}`
    case 'reopened':
      return `you reopened ${step} · nothing sent`
    case 'paused':
      if (d.by === 'user') return 'paused by you'
      return typeof d.reason === 'string' && d.reason ? `paused · ${d.reason}` : 'paused'
    case 'resumed':
      return 'resumed'
    case 'went_back':
      return `went back to ${step}`
    case 'removed':
      if (typeof d.carriedTo === 'string') return 'carried into a new session'
      return 'removed · the conversation stays'
    case 'carried_over':
      return 'carried over from the previous session'
    case 'finished':
      return 'finished · every step is done'
    case 'proposed':
      return d.kind === 'harness' ? 'the agent proposed a harness · waits for your OK' : 'the agent proposed a change · waits for your OK'
    case 'proposal_applied':
      return d.kind === 'harness' ? 'you attached the proposed harness' : 'you applied the proposed change'
    case 'proposal_discarded':
      return 'you discarded the proposal'
    case 'attached':
    case 'advanced':
    case 'nudged':
    case 'options':
    case 'proposal_superseded':
    case 'edited':
      // An edit's row is the message the agent was sent about it.
      return null
  }
}

/** A message's time, ms; NaN when it carries none. */
const timeOf = (m: ChatMessage): number => (m.timestamp ? Date.parse(m.timestamp) : Number.NaN)

/**
 * The transcript as the session panel draws it, with the harness in it (30b):
 * every message Orbital sent becomes a `role: 'harness'` row — never the
 * user's bubble — and the harness's own events are laid in where they
 * happened (30g: "sit … as dashed rows, where they happened").
 *
 * `events` may come in any order; each goes before the first message stamped
 * after it, and a message without a time keeps the place of the one before
 * it. Events older than `since` — before the oldest message held, while older
 * history is still unread — are left for when it is. A ticked gate that stops
 * for the user is two rows.
 */
export function withHarnessRows(
  source: readonly ChatMessage[],
  events: readonly HarnessEvent[],
  harnesses: readonly SessionHarness[],
  since: number | null,
): ChatMessage[] {
  const messages = source.some((m) => m.harnessMessage)
    ? source.map((m): ChatMessage =>
        m.role === 'user' && m.harnessMessage
          ? { ...m, role: 'harness', text: harnessMessageText(m.harnessMessage, harnesses) }
          : m,
      )
    : (source as ChatMessage[])
  if (events.length === 0) return messages
  const ordered = events
    .filter((e) => since === null || e.at >= since)
    .sort((a, b) => a.at - b.at || a.id - b.id)
  const rows: ChatMessage[] = []
  ordered.forEach((event, i) => {
    const text = harnessEventText(event, harnesses, ordered[i + 1])
    if (text === null) return
    text.split('\n').forEach((line, part) => {
      rows.push({
        id: `harness-event:${event.id}${part > 0 ? `:${part}` : ''}`,
        role: 'harness',
        text: line,
        timestamp: new Date(event.at).toISOString(),
      })
    })
  })
  if (rows.length === 0) return messages

  const out: ChatMessage[] = []
  let next = 0
  for (const message of messages) {
    const t = timeOf(message)
    if (!Number.isNaN(t)) {
      while (next < rows.length && timeOf(rows[next]) < t) out.push(rows[next++])
    }
    out.push(message)
  }
  while (next < rows.length) out.push(rows[next++])
  return out
}
