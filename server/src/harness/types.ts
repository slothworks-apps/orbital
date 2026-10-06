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
  /** The ids of the steps this one depends on. Absent means "the step before it"; [] makes it a root. */
  dependsOn?: string[];
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
  /**
   * The reviewer's model (an SDK model value). Null: the session's own model
   * (spec 2026-10-02-harness-redesign-design § 7).
   */
  reviewerModel: string | null;
}

export const DEFAULT_OPTIONS: HarnessOptions = {
  commitPerStep: true,
  maxAutoRounds: 150,
  maxIdleNudges: 5,
  maxReviewerReopens: 5,
  lucky: false,
  reviewerModel: null,
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
  /**
   * A reviewer is reading this gate right now (REVIEWER READING). Persisted so
   * a reload shows it; a restart clears it, because a review cannot survive one.
   */
  reviewing?: true;
  /**
   * The user took this gate from the reviewer ("Decide myself", or a review a
   * restart cut off): no review starts on it until it leaves the gate, or
   * lucky is turned on again.
   */
  reviewerOff?: true;
  /** The reviewer sent the step back while paused; its findings go out on resume. */
  unsentFindings?: true;
  /**
   * Earlier runs of this step, oldest first: the record it had before the
   * user reopened it or went back to it (spec 2026-10-02-harness-redesign-design § 6).
   */
  previousRuns?: PreviousRun[];
}

/** A step's record as it stood when the user reopened it or went back past it. */
export interface PreviousRun extends Omit<StepState, 'previousRuns' | 'reviewing' | 'reviewerOff' | 'unsentFindings'> {
  /** When it was set aside (epoch ms). */
  endedAt: number;
  /** `went_back`: "before going back"; `reopened`: the user reopened the gate; `edited`: the harness was edited. */
  reason: 'went_back' | 'reopened' | 'edited';
}

/** Where a template is offered: everywhere, or in one project's sessions only. */
export type TemplateScope =
  | { kind: 'global' }
  /** `root` is the project's directory (see `projectRootOf`), `name` its basename. */
  | { kind: 'project'; root: string; name: string };

export interface HarnessTemplate {
  id: number;
  name: string;
  description: string;
  tags: string[];
  inputs: HarnessInput[];
  steps: HarnessStep[];
  options: HarnessOptions;
  scope: TemplateScope;
  /**
   * Written by a drafting conversation and not saved by the user yet: listed
   * in Settings, never offered when starting a harness. Save clears it.
   */
  draft: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Why a harness paused, for the panel's wording (30f "pause reasons"). */
export type PauseKind = 'user' | 'nudge_cap' | 'message_cap' | 'review_failed' | 'send_failed' | 'session_ended';

/** What Orbital sent into the session on the harness's account. */
export type HarnessMessageKind = 'kickoff' | 'advance' | 'nudge' | 'findings' | 'edited';

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
  /** Which kind of pause, null while it runs. */
  pauseKind: PauseKind | null;
  /** When it paused (epoch ms), null while it runs. */
  pausedAt: number | null;
  /**
   * When the user removed it (epoch ms). A removed harness runs nothing; it is
   * kept so its records stay readable. Null for the session's live harness.
   */
  removedAt: number | null;
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
  /** A running review was stopped: by the user, lucky turned off, or a restart. */
  | 'review_aborted'
  | 'options'
  /** The user went back to a step; the later steps' records are kept as previous runs. */
  | 'went_back'
  /** The harness left the session; its records are kept. */
  | 'removed'
  /** The harness came over from another session (Clear → new session). */
  | 'carried_over'
  /** The agent proposed a harness or a change to it; the user applies or discards it. */
  | 'proposed'
  | 'proposal_applied'
  | 'proposal_discarded'
  /** A newer proposal replaced one the user had not decided yet. */
  | 'proposal_superseded'
  /** The checklist was changed while it ran: by the user, or by a proposal they applied. */
  | 'edited';

/**
 * A session's harness gate as the session's state sees it: `waiting` is
 * NEEDS YOUR OK (the session reads `needs_input`), `reviewing` is REVIEWER
 * READING (spec 2026-10-02-harness-redesign-design § 2), `proposal` is a
 * pending proposal waiting for the user (spec 2026-10-06-harness-graph-and-proposals).
 */
export type HarnessGate = 'waiting' | 'reviewing' | 'proposal';

/** A project as harness scopes know it: a git repository's root, or a plain directory. */
export interface HarnessProject {
  root: string;
  name: string;
}

export interface HarnessEvent {
  id: number;
  sessionId: string;
  at: number;
  kind: HarnessEventKind;
  detail: Record<string, unknown>;
}

/** A change to a running harness: steps added at the end, changed in place, removed. */
export interface HarnessChanges {
  add?: HarnessStep[];
  update?: HarnessStep[];
  remove?: string[];
}

/** A harness the agent worked out in the conversation, without a template. */
export interface ProposedHarness {
  name: string;
  steps: HarnessStep[];
}

/**
 * What the agent proposed with `harness_propose` and the user has not taken
 * or discarded yet: a whole harness, or a change to the running one (spec
 * 2026-10-06-harness-graph-and-proposals-design § Proposals).
 */
export type HarnessProposal = (
  | { kind: 'harness'; harness: ProposedHarness }
  | { kind: 'changes'; changes: HarnessChanges }
) & { note: string | null; createdAt: number };
