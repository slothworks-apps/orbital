/**
 * A harness template and the checklist it becomes in a session (spec
 * 2026-09-30-session-harness-design). Shared by the store, the logic and the
 * routes; the web mirrors these by hand in `web/src/lib/types.ts`.
 */

export type StepMode = 'auto' | 'gate';

export interface HarnessInput {
  /** What `{{key}}` in a step's instructions is replaced with. */
  key: string;
  label: string;
  hint?: string;
}

export interface HarnessStep {
  id: string;
  title: string;
  instructions: string;
  mode: StepMode;
  /** Plain-language criteria the agent ticks the step against. */
  doneWhen: string;
  /** Shell command run in the session's cwd; exit 0 is required to tick. */
  verify?: string;
}

export type StepStatus = 'pending' | 'active' | 'awaiting_approval' | 'done';

/**
 * How a harness runs (spec 2026-09-30-harness-lucky-and-step-records-design
 * § Options). A template's are copied into the session's harness.
 */
export interface HarnessOptions {
  /** The agent commits locally before ticking, so each step is a clean git range. */
  commitPerStep: boolean;
  maxAutoRounds: number;
  maxIdleNudges: number;
  maxReviewerReopens: number;
  /** A reviewer agent decides the gates instead of the user. */
  lucky: boolean;
}

export const DEFAULT_OPTIONS: HarnessOptions = {
  commitPerStep: true,
  maxAutoRounds: 150,
  maxIdleNudges: 5,
  maxReviewerReopens: 5,
  lucky: false,
};

/** One choice the agent made in a step, as it wrote it at the tick. */
export interface StepDecision {
  what: string;
  why: string;
  alternatives?: string;
}

/** A reviewer's verdict on a gate step. */
export interface StepReview {
  at: number;
  verdict: 'approve' | 'reopen';
  /** The reviewer was not sure; its verdict was followed anyway. */
  uncertain: boolean;
  reasoning: string;
  checked: string[];
  findings: string[];
}

export interface StepState {
  status: StepStatus;
  /** What the agent did, at the tick. */
  summary?: string;
  decisions?: StepDecision[];
  openQuestions?: string[];
  /** Before step records: the one-line note the tick carried. Read-only now. */
  evidence?: string;
  startedAt?: number;
  completedAt?: number;
  /** git HEAD when the step became active, and at the tick. */
  startHead?: string;
  endHead?: string;
  /** The user message Orbital sent to begin the step — a rewind target. */
  startMessageUuid?: string;
  nudges?: number;
  approvedBy?: 'user' | 'reviewer';
  reviews?: StepReview[];
  reviewerReopens?: number;
}

export interface HarnessTemplate {
  id: number;
  name: string;
  description: string;
  tags: string[];
  inputs: HarnessInput[];
  steps: HarnessStep[];
  options: HarnessOptions;
  createdAt: number;
  updatedAt: number;
}

export interface SessionHarness {
  sessionId: string;
  templateId: number | null;
  name: string;
  /** The template's steps at attach time, inputs already filled in. */
  steps: HarnessStep[];
  inputs: Record<string, string>;
  state: StepState[];
  options: HarnessOptions;
  paused: boolean;
  /** Why the harness paused itself; null when the user paused it or it runs. */
  pauseReason: string | null;
  /** Messages Orbital sent into the session on its own. */
  autoRounds: number;
  /** Nudges since the last tick or the last message the user typed. */
  idleNudges: number;
  createdAt: number;
  updatedAt: number;
}

export type HarnessEventKind =
  | 'attached'
  | 'ticked'
  | 'verify_failed'
  | 'advanced'
  | 'nudged'
  | 'watcher_stop'
  | 'approved'
  | 'reopened'
  | 'paused'
  | 'resumed'
  | 'finished'
  | 'review_started'
  | 'reviewed'
  | 'review_failed'
  | 'options';

export interface HarnessEvent {
  id: number;
  sessionId: string;
  at: number;
  kind: HarnessEventKind;
  detail: Record<string, unknown>;
}
