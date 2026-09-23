/**
 * The walkthrough's wire shape (spec: 2026-09-23-walkthrough-design § The
 * spine). Mirrored field-for-field in `web/src/lib/types.ts`.
 */
import type { ChatMessage } from '../types.js';

/** How a later step treated an earlier step's work (spec § Blind alleys). */
export type FateKind = 'revised' | 'reverted';

/** A writing call as the transcript carries it, joined to its result; the browser builds the diff. */
export interface StepCall { call: ChatMessage; result: ChatMessage | null }

/** A later step that revised or reverted this step's work on `path`. */
export interface StepFate { kind: FateKind; byStep: string; path: string }

/** A question asked about a step and its answer (spec § Asking). */
export interface StepQuestion { question: string; answer: string | null; messageId: string }

/**
 * A run's direct writing calls, or one writing dispatch in it. `id` is the
 * `toolUseId` of its first writing call (falling back to that message's id),
 * stable while the transcript grows.
 */
export interface Step {
  id: string; ordinal: number; narration: string; calls: StepCall[];
  folded: Record<string, number>;
  subagent: { name: string; prompt: string; steps: Step[] } | null;
  fate: StepFate[]; questions: StepQuestion[]; durationMs: number | null;
}

/** Everything between two steps: tool calls folded per tool, subagents that changed nothing, and what the agent said. */
export interface Gap { kind: 'gap'; durationMs: number | null; folded: Record<string, number>; subagents: string[]; said: string }

/** Steps and gaps interleaved, in transcript order. */
export type TimelineEntry = { kind: 'step'; id: string } | Gap;

/**
 * One path the session wrote: the steps that wrote it, whether it was
 * created, its last fate, and whether a call on it failed with no later
 * successful writing call on the same path (a retried failure is not open).
 */
export interface FileSummary { path: string; steps: string[]; created: boolean; fate: FateKind | null; notApplied: boolean }

/** One intent the narration grouped steps under (spec § Narration). */
export interface NarrationIntent { title: string; summary: string; steps: string[]; considered: string[]; abandoned: boolean }

/** The narration turn's answer, read back from the transcript. */
export interface Narration { intents: NarrationIntent[]; /** steps added after the narrate turn */ staleSteps: number }

/**
 * What the walkthrough page is built from. Nothing is stored; it is rebuilt
 * from the transcript on every request. `narration` is the last *answered*
 * narrate turn's; `narrationPending` says a newer narrate turn has no answer yet.
 */
export interface Walkthrough {
  steps: Step[]; timeline: TimelineEntry[]; files: FileSummary[];
  narration: Narration | null; narrationFailed: boolean; narrationPending: boolean; lastMessageId: string | null;
}
