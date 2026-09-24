import type { ChatMessage, Subagent } from './types'

/**
 * The subagent panel's own header state — five task states plus the
 * TRUNCATED modifier (spec: 2026-09-22-subagent-transcript-panel-design.md
 * § 10, canvas 11c). Deliberately its own vocabulary: `Subagent.state`
 * carries the MOON's states (`materializing` / `working` / `idle` /
 * `needs_input` / `ended`), and canvas 11c is explicit that the two sets
 * must never mix. This module is the one seam that turns a `Subagent` (plus
 * the fetch outcome the moon knows nothing about) into the panel's own read.
 */
export type SubagentTaskState = 'running' | 'completed' | 'failed' | 'stopped' | 'stream_lost'

/** How often the RUNNING elapsed reading advances (canvas 11c: "the only
 * state that animates"). A mono reading that never shows sub-second
 * precision has no use for anything finer. The subagent list's running
 * rows tick at the same rate. */
export const ELAPSED_TICK_MS = 1000

/**
 * Derives the panel's task state.
 *
 * `found` carries the 404-vs-empty-200 distinction from `openSubagent`'s
 * fetch and always wins first: a buffer the server no longer knows about is
 * STREAM LOST regardless of whatever the moon's own `state`/`status` still
 * say, because those are the last values this tab happened to see and
 * cannot be trusted once the buffer itself is gone.
 *
 * Every `Subagent.state` other than `'ended'` reads as RUNNING, not just
 * `'working'`: the server (`SubagentInfo` in
 * `server/src/transcript/subagents.ts`) only ever populates `'working'` or
 * `'ended'`, so the wider client union (which also carries the moon's
 * `materializing` / `idle` / `needs_input` for `MOON_STATES`' drawing code)
 * never actually reaches this function with one of those values today —
 * treating "not ended" as running is the honest, forward-compatible default
 * rather than a switch that would silently fall through.
 */
export function taskStateFor(
  subagent: Pick<Subagent, 'state' | 'status'>,
  found: boolean,
): SubagentTaskState {
  if (!found) return 'stream_lost'
  if (subagent.state !== 'ended') return 'running'
  if (subagent.status === 'failed') return 'failed'
  if (subagent.status === 'stopped') return 'stopped'
  return 'completed'
}

/**
 * The header's elapsed reading, in ms — or `undefined` for "elapsed
 * unknown" (canvas 11c: STREAM LOST, "never a zero"; see `SubagentPanel`
 * for the STREAM LOST short-circuit, which never calls this at all).
 *
 * RUNNING (anything not `'ended'`, by the same reasoning as `taskStateFor`)
 * measures against `nowMs`, supplied by the panel's own ticking effect —
 * this function stays pure and needs no clock of its own, which is what
 * makes it unit-testable without fake timers.
 *
 * A terminal state freezes at a moment taken from the record, never at
 * whatever moment the panel happened to first render the ended state: an
 * agent reopened long after it finished must read the same duration it did
 * the first time it was seen, and a component-lifecycle snapshot cannot
 * guarantee that. The record's moment is `endedAt` when the server stamped
 * one — the same value the subagent list reads, so the panel and the list
 * agree on the same agent (subagent list spec § 3) — else the LAST
 * message's own `timestamp`. `undefined` (never a fabricated number) for
 * the practically-rare case of a terminal agent with neither — every
 * forwarded `ChatMessage` is stamped at publish (spec § 7), so this only
 * happens for an agent whose buffer is genuinely empty.
 */
export function elapsedMsFor(
  subagent: Pick<Subagent, 'state' | 'startedAt' | 'endedAt'>,
  messages: readonly ChatMessage[],
  nowMs: number,
): number | undefined {
  if (subagent.state !== 'ended') return Math.max(0, nowMs - subagent.startedAt)
  if (subagent.endedAt !== undefined) return Math.max(0, subagent.endedAt - subagent.startedAt)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const ts = messages[i].timestamp
    if (!ts) continue
    const at = new Date(ts).getTime()
    if (!Number.isNaN(at)) return Math.max(0, at - subagent.startedAt)
  }
  return undefined
}

/**
 * The agent's own `subagent_type` (e.g. `general-purpose`), read out of the
 * PARENT transcript's `Agent`/`Task` tool_use block rather than off
 * `Subagent` itself.
 *
 * `SubagentInfo` (`server/src/transcript/subagents.ts`) never carries a
 * `subagent_type` field of its own: `feedTask` folds it into `name` only as
 * a FALLBACK ("description || subagent_type || 'subagent'"), so once a real
 * description is present — the normal case, `Agent`'s `description` input is
 * effectively always set — the type is nowhere else on the moon. The tool
 * call's raw `toolInput` is a real reading of what the SDK actually sent, so
 * this is a derivation, not a guess — matching how the header's model is
 * derived from the transcript rather than invented (see `modelFrom` below).
 *
 * Returns `undefined` (no chip, never a fabricated label) when the parent
 * transcript has not been fetched yet — a panel opened straight from a map
 * moon, before its parent session was ever selected — or the block has
 * since scrolled out of what this tab happens to hold.
 */
export function subagentTypeFrom(
  parentMessages: readonly ChatMessage[],
  toolUseId: string | undefined,
): string | undefined {
  if (!toolUseId) return undefined
  const toolUse = parentMessages.find((m) => m.role === 'tool_use' && m.toolUseId === toolUseId)
  const input = toolUse?.toolInput as { subagent_type?: unknown } | undefined
  return typeof input?.subagent_type === 'string' ? input.subagent_type : undefined
}

/**
 * The model that answered — read off the first assistant message that
 * carries one, the same source the transcript's own model dividers use
 * (`insertModelDividers` in `panels/TranscriptView.tsx`). `Subagent` has no
 * model field of its own: "assistant frames carry `message.model`, which
 * `ChatMessage` already transports" (spec § 6).
 */
export function subagentModelFrom(messages: readonly ChatMessage[]): string | undefined {
  return messages.find((m) => m.role === 'assistant' && m.model)?.model
}

/**
 * Strips a single LEADING user message — a subagent's one instruction,
 * already shown as the panel's own task-description heading, so repeating
 * it as the first transcript row would duplicate it rather than add
 * anything (spec § 8, "No user bubbles"). Never strips a later user
 * message: only index 0 is ever the agent's own launch prompt, and a
 * TRUNCATED buffer whose surviving head is no longer that prompt already
 * fails the `role === 'user'` check on its own, so this is a no-op for it —
 * nothing to strip, nothing duplicated.
 */
export function withoutLeadingUserFrame(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length > 0 && messages[0].role === 'user') return messages.slice(1)
  return messages
}
