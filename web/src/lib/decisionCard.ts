import type { PendingVerdictDecision } from './types'

/**
 * The `PermissionCard`'s state machine, extracted from the component so the
 * rules the spec is about — what the card is allowed to say about a tool, and
 * how a refusal is assembled — are testable without a DOM (spec:
 * 2026-09-23-permission-and-plan-decisions-design § Testing).
 *
 * Everything here is pure. The sibling of `lib/questionCard.ts`, for the two
 * kinds that are answered with a verdict rather than with words.
 */

/** The tool whose call is a plan waiting for approval rather than a permission ask. */
export const PLAN_TOOL_NAME = 'ExitPlanMode'

/** The refusal field's cap, in step with the question card's own free-text cap. */
export const DECLINE_TEXT_CAP = 500

/**
 * The chip's copy. Capped and uppercased like the question card's, and named
 * by the kind rather than by the tool — a row of chips that all read `BASH`
 * says nothing the row below it does not.
 */
export function decisionChipLabel(kind: 'permission' | 'plan'): string {
  return kind === 'plan' ? 'PLAN' : 'PERMISSION'
}

/**
 * The card's headline: the bridge's own sentence when it sent one, and a
 * plain fallback built from the tool's name when it did not.
 *
 * The fallback never quotes the input. A `title` the bridge wrote has already
 * decided how much of a command is safe to show inline; anything this side
 * assembles from raw input would be guessing, and the detail block below the
 * headline shows the whole input anyway.
 */
export function decisionHeadline(decision: PendingVerdictDecision): string {
  if (decision.title?.trim()) return decision.title.trim()
  if (decision.kind === 'plan') return 'Claude has a plan and wants to start on it'
  const tool = decision.toolName?.trim()
  return tool ? `Claude wants to use ${tool}` : 'Claude is asking for permission'
}

/**
 * The plan's markdown, or null when this decision carries none — which is
 * what an `ExitPlanMode` call from a CLI that saved the plan to a file
 * instead of inlining it looks like. The card then falls back to the input
 * block, rather than rendering an empty plan.
 */
export function planText(input: Record<string, unknown>): string | null {
  const plan = input.plan
  return typeof plan === 'string' && plan.trim() ? plan : null
}

/**
 * The tool input as the card's detail block shows it: pretty JSON, or the
 * string itself when the whole input is one. `null` when there is nothing
 * worth a block — an empty input is not a detail, it is noise.
 */
export function inputDetail(input: Record<string, unknown>): string | null {
  if (!input || typeof input !== 'object') return null
  const keys = Object.keys(input)
  if (keys.length === 0) return null
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    // A cyclic or otherwise unserialisable input still has to show something
    // rather than blank the card. Its keys are what there is to say about it
    // — `String()` on an object is `[object Object]`, which is nothing.
    return keys.join('\n')
  }
}

/**
 * The single most useful line of a tool's input, for the headline's subtitle —
 * a shell command, a file path, a URL. `null` when the tool takes none of
 * them, which is most MCP tools and is why the detail block exists.
 *
 * Ordered by how much the field tells you about what is about to happen, not
 * by how common it is: a command is the action itself, a path is only where.
 */
export function inputSummary(input: Record<string, unknown>): string | null {
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const value = input?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * The body a decline POSTs. Whitespace-only text is no reason at all — the
 * server has its own wording for a bare refusal, and sending a blank string
 * would replace it with nothing.
 */
export function declineVerdict(text: string): { approved: false; message?: string } {
  const message = text.trim().slice(0, DECLINE_TEXT_CAP)
  return message ? { approved: false, message } : { approved: false }
}

/**
 * What the composer's hint says while this decision is parked. Typing is a
 * refusal with a reason in it, never an approval (spec § Answering), and the
 * hint has to say so before someone presses ⏎ expecting the opposite.
 */
export function composerHintFor(kind: 'permission' | 'plan'): string {
  return kind === 'plan'
    ? '⏎ sends this back as plan feedback · ⇧⏎ newline'
    : '⏎ declines with your reason · ⇧⏎ newline'
}

/** The composer's placeholder while a verdict decision is parked. */
export function composerPlaceholderFor(kind: 'permission' | 'plan'): string {
  return kind === 'plan'
    ? 'Say what the plan is missing, or approve it above…'
    : 'Say what to do instead, or answer above…'
}
