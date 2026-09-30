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

/**
 * A run's direct writing calls, or one writing dispatch in it. `id` is the
 * `toolUseId` of its first writing call (falling back to that message's id),
 * stable while the transcript grows.
 */
export interface Step {
  id: string; ordinal: number; narration: string; calls: StepCall[];
  folded: Record<string, number>;
  subagent: { name: string; prompt: string; steps: Step[] } | null;
  fate: StepFate[]; durationMs: number | null;
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

/** The last finished narration, laid over the current steps. */
export interface Narration { intents: NarrationIntent[]; /** current steps no stored intent names */ staleSteps: number }

/**
 * Why the last narrate query failed (spec 2026-09-30-narrate-out-of-band-design
 * § Failure): the model refused, it answered in a shape `parseNarration`
 * could not read, or anything else went wrong.
 */
export type NarrationFailure = 'refused' | 'unparsable' | 'error';

/**
 * What the walkthrough page is built from. The spine is rebuilt from the
 * transcript on every request; the narration fields come from the stored
 * narration (spec 2026-09-30-narrate-out-of-band-design § Storage and state).
 * `narration` is the last *finished* run's; `narrationPending` says a newer
 * run is in flight; `narrationFailure` is set exactly when `narrationFailed` is.
 */
export interface Walkthrough {
  steps: Step[]; timeline: TimelineEntry[]; files: FileSummary[];
  narration: Narration | null; narrationFailed: boolean; narrationPending: boolean;
  narrationFailure: NarrationFailure | null; lastMessageId: string | null;
}

/** The part of a walkthrough the transcript alone decides. */
export type Spine = Omit<Walkthrough, 'narration' | 'narrationFailed' | 'narrationPending' | 'narrationFailure'>;
