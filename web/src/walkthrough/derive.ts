import { ApiError } from '../lib/api'
import { changeCounts, describeFileChange } from '../lib/fileEdit'
import type { ApiSession, Gap, NarrationIntent, StepCall, Walkthrough, WalkthroughStep } from '../lib/types'

/**
 * Pure reads over a `Walkthrough` that the page's screens share (spec:
 * 2026-09-23-walkthrough-design § The page). Nothing here renders.
 */

/** One titled run of the rail: an intent when narrated, else every step untitled. */
export interface RailGroup {
  title: string | null
  steps: WalkthroughStep[]
}

export function railGroups(w: Walkthrough): RailGroup[] {
  if (!w.narration) return [{ title: null, steps: w.steps }]
  const byId = new Map(w.steps.map((s) => [s.id, s]))
  return w.narration.intents
    .map((i) => ({
      title: i.title || null,
      steps: i.steps.map((id) => byId.get(id)).filter((s): s is WalkthroughStep => !!s),
    }))
    .filter((g) => g.steps.length > 0)
}

export function intentFor(w: Walkthrough, stepId: string): NarrationIntent | null {
  return w.narration?.intents.find((i) => i.steps.includes(stepId)) ?? null
}

/** The gap immediately before a step in the timeline, or null when another step precedes it. */
export function gapBefore(w: Walkthrough, stepId: string): Gap | null {
  const i = w.timeline.findIndex((t) => t.kind === 'step' && t.id === stepId)
  const prev = i > 0 ? w.timeline[i - 1] : null
  return prev && prev.kind === 'gap' ? prev : null
}

/** What happened after the last step — reads, commands and words that wrote nothing. */
export function trailingGap(w: Walkthrough): Gap | null {
  const last = w.timeline[w.timeline.length - 1]
  return last && last.kind === 'gap' ? last : null
}

const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch'])

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The one-line fold of a step's or gap's non-writing calls (canvas 21b/21c). */
export function foldedLine(folded: Record<string, number>): string {
  return foldedParts(folded).join(' · ')
}

/** `foldedLine`'s parts, for a surface that sets each in its own ink (canvas 21c). */
export function foldedParts(folded: Record<string, number>): string[] {
  const parts: string[] = []
  const reads = folded.Read ?? 0
  const commands = folded.Bash ?? 0
  let searches = 0
  let other = 0
  for (const [tool, n] of Object.entries(folded)) {
    if (tool === 'Read' || tool === 'Bash') continue
    if (SEARCH_TOOLS.has(tool)) searches += n
    else other += n
  }
  if (reads) parts.push(`read ${plural(reads, 'file', 'files')}`)
  if (commands) parts.push(`ran ${plural(commands, 'command', 'commands')}`)
  if (searches) parts.push(plural(searches, 'search', 'searches'))
  if (other) parts.push(`${other} other ${other === 1 ? 'call' : 'calls'}`)
  return parts
}

/** What the rail and the gap's `▲` line call a step: its own first line, else its intent, else its agent. */
export function stepLabel(w: Walkthrough, step: WalkthroughStep): string {
  const own = step.narration.split('\n')[0]?.trim()
  return own || intentFor(w, step.id)?.title || step.subagent?.name || `step ${step.ordinal}`
}

/** Sum of `changeCounts` over `calls`; null when none is countable. */
export function callCounts(calls: StepCall[]): { added: number; removed: number } | null {
  let added = 0
  let removed = 0
  let any = false
  for (const c of calls) {
    const change = describeFileChange(c.call.toolName, c.call.toolInput, c.result?.text, c.result?.isError === true)
    const counts = change ? changeCounts(change) : null
    if (!counts) continue
    any = true
    added += counts.added
    removed += counts.removed
  }
  return any ? { added, removed } : null
}

/** A step's writing calls, a subagent step's sub-steps included. */
export function callsOf(step: WalkthroughStep): StepCall[] {
  return step.subagent ? step.subagent.steps.flatMap(callsOf) : step.calls
}

/** The file a writing call names, or null when its input carries none. */
export function pathOf(c: StepCall): string | null {
  const input = c.call.toolInput as Record<string, unknown> | null | undefined
  const p = input?.file_path ?? input?.notebook_path
  return typeof p === 'string' ? p : null
}

/** Sum of `changeCounts` over every countable call on `path`; null when none is countable. */
export function fileCounts(w: Walkthrough, path: string): { added: number; removed: number } | null {
  return callCounts(w.steps.flatMap(callsOf).filter((c) => pathOf(c) === path))
}

/** Steps a later step reverted, or whose intent the narration marked abandoned. */
export function blindAlleySteps(w: Walkthrough): WalkthroughStep[] {
  return w.steps.filter((s) => s.fate.some((f) => f.kind === 'reverted') || intentFor(w, s.id)?.abandoned === true)
}

/**
 * Writing calls whose result is an error and that no later successful
 * writing call on the same path made good — changes that never landed.
 * Retrying a failed Edit is routine; the retry closes it. The server's
 * `FileSummary.notApplied` follows the same rule.
 */
export function stillOpen(w: Walkthrough): Array<{ step: WalkthroughStep; call: StepCall }> {
  const all = w.steps.flatMap((step) => callsOf(step).map((call) => ({ step, call })))
  return all.filter(({ call }, i) => {
    if (call.result?.isError !== true) return false
    const path = pathOf(call)
    return !all.slice(i + 1).some((later) => later.call.result != null && later.call.result.isError !== true && pathOf(later.call) === path)
  })
}

/**
 * Which screen the page shows. A step screen names its step by id, not by
 * position: a dispatch step appears only once its subagent has written, so a
 * step can be inserted before the one being read, and the reader must stay
 * where they are (spec § The page, "the step being read never moves").
 */
export type Screen = { kind: 'cover' } | { kind: 'step'; id: string } | { kind: 'close' }

/**
 * The screen as the current steps allow it: a step screen whose id is gone
 * falls to the last step, or to the cover when there are no steps left.
 */
export function settleScreen(s: Screen, stepIds: string[]): Screen {
  if (s.kind !== 'step' || stepIds.includes(s.id)) return s
  return stepIds.length > 0 ? { kind: 'step', id: stepIds[stepIds.length - 1] } : { kind: 'cover' }
}

export function nextScreen(screen: Screen, stepIds: string[]): Screen {
  const s = settleScreen(screen, stepIds)
  if (s.kind === 'cover') return stepIds.length > 0 ? { kind: 'step', id: stepIds[0] } : { kind: 'close' }
  if (s.kind === 'step') {
    const i = stepIds.indexOf(s.id)
    return i + 1 < stepIds.length ? { kind: 'step', id: stepIds[i + 1] } : { kind: 'close' }
  }
  return s
}

export function prevScreen(screen: Screen, stepIds: string[]): Screen {
  const s = settleScreen(screen, stepIds)
  if (s.kind === 'close') return stepIds.length > 0 ? { kind: 'step', id: stepIds[stepIds.length - 1] } : { kind: 'cover' }
  if (s.kind === 'step') {
    const i = stepIds.indexOf(s.id)
    return i > 0 ? { kind: 'step', id: stepIds[i - 1] } : { kind: 'cover' }
  }
  return s
}

/**
 * Mid-turn: working, or parked on a decision. Asking and narrating are both
 * refused then (spec § Asking). `needs_input` alone is not mid-turn — it is
 * every live Orbital session between turns, which is when a walkthrough is
 * read — so the rule is the server's `refuseTurn`, not the status word.
 */
export function midTurn(session: Pick<ApiSession, 'status' | 'pendingDecision'>): boolean {
  return session.status === 'working' || (session.pendingDecision ?? null) !== null
}

/** The top bar's status pill (canvas 21a/21b): a person's word for the status, never the raw one. */
export function statusWord(session: Pick<ApiSession, 'status' | 'pendingDecision'>): 'WORKING' | 'WAITING' | 'IDLE' | 'ENDED' {
  if (session.status === 'working') return 'WORKING'
  if (session.status === 'ended') return 'ENDED'
  if (session.status === 'needs_input' && (session.pendingDecision ?? null) !== null) return 'WAITING'
  return 'IDLE'
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/**
 * When the session ran, for the cover's eyebrow (canvas 21a): `9 SEP 14:02 →
 * 16:24`, the date repeated after the arrow only when the session crossed
 * midnight. Local time. Null when either end is unknown.
 */
export function sessionSpan(firstAt: number | null, lastAt: number | null): string | null {
  if (firstAt === null || lastAt === null) return null
  const a = new Date(firstAt)
  const b = new Date(lastAt)
  const day = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}`
  const clock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  return `${day(a)} ${clock(a)} → ${sameDay ? '' : `${day(b)} `}${clock(b)}`
}

/** Which of the two turn refusals a failed ask or narrate was, or null for any other failure. */
export function refusalOf(err: unknown): 'busy' | 'terminal_session' | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null
  try {
    const body = JSON.parse(err.message) as { error?: unknown }
    return body.error === 'busy' || body.error === 'terminal_session' ? body.error : null
  } catch {
    return null
  }
}
