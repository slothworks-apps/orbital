/**
 * The harness's decisions, pure and synchronous: filling a template in, the
 * step state machine, what to do when a turn ends, and the text Orbital
 * sends into the session. Everything with a side effect is in `service.ts`.
 */

import {
  DEFAULT_OPTIONS, type HarnessGate, type HarnessInput, type HarnessOptions, type HarnessStep, type PauseKind,
  type PreviousRun, type SessionHarness, type StepDecision, type StepReview, type StepState,
} from './types.js';

/** A template's or a session's options, with every missing or malformed field at its default. */
export function normalizeOptions(raw: unknown): HarnessOptions {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const count = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
  return {
    commitPerStep: typeof o.commitPerStep === 'boolean' ? o.commitPerStep : DEFAULT_OPTIONS.commitPerStep,
    maxAutoRounds: count(o.maxAutoRounds, DEFAULT_OPTIONS.maxAutoRounds),
    maxIdleNudges: count(o.maxIdleNudges, DEFAULT_OPTIONS.maxIdleNudges),
    maxReviewerReopens: count(o.maxReviewerReopens, DEFAULT_OPTIONS.maxReviewerReopens),
    lucky: typeof o.lucky === 'boolean' ? o.lucky : DEFAULT_OPTIONS.lucky,
    reviewerModel: typeof o.reviewerModel === 'string' && o.reviewerModel.trim() ? o.reviewerModel.trim() : null,
  };
}

/** `{{key}}` → the input's value. Unknown keys stay as written, so a typo shows. */
export function fillInputs(text: string, inputs: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(inputs, key) ? inputs[key] : whole,
  );
}

export function snapshotSteps(steps: HarnessStep[], inputs: Record<string, string>): HarnessStep[] {
  return steps.map((step) => ({
    ...step,
    title: fillInputs(step.title, inputs),
    instructions: fillInputs(step.instructions, inputs),
    doneWhen: fillInputs(step.doneWhen, inputs),
    ...(step.verify !== undefined && { verify: fillInputs(step.verify, inputs) }),
  }));
}

export function initialState(steps: HarnessStep[]): StepState[] {
  return steps.map((_, i) => ({ status: i === 0 ? 'active' : 'pending' }));
}

/** The first step not done, or -1 when every step is. */
export function activeIndex(state: StepState[]): number {
  return state.findIndex((s) => s.status !== 'done');
}

/** Promotes the first step not done to `active`, if it is still `pending`. */
function promote(state: StepState[]): StepState[] {
  const i = activeIndex(state);
  if (i === -1 || state[i].status !== 'pending') return state;
  return state.map((s, j) => (j === i ? { status: 'active' } : s));
}

export type TickResult =
  | { ok: true; state: StepState[]; outcome: 'advanced' | 'awaiting_approval' | 'finished' }
  | { ok: false; error: string };

/** What the agent writes into a step's record when it ticks it. */
export interface TickRecord {
  summary: string;
  decisions: StepDecision[];
  openQuestions: string[];
}

/**
 * The agent says the active step is done. Only the active step can be ticked:
 * a checklist that lets a later step go first stops being a checklist.
 */
export function tick(
  steps: HarnessStep[], state: StepState[], stepId: string, record: TickRecord, now: number,
): TickResult {
  const i = activeIndex(state);
  if (i === -1) return { ok: false, error: 'Every step is already done.' };
  const index = steps.findIndex((s) => s.id === stepId);
  if (index === -1) return { ok: false, error: `No step "${stepId}". The active step is "${steps[i].id}".` };
  if (index !== i) return { ok: false, error: `Step "${stepId}" is not the active step. The active step is "${steps[i].id}".` };
  if (state[i].status === 'awaiting_approval') {
    return { ok: false, error: `Step "${stepId}" is already done and waits for the user's approval.` };
  }
  const gate = steps[i].mode === 'gate';
  // What Orbital recorded when the step began (heads, the message) stays.
  const ticked: StepState = { ...state[i], ...record, status: gate ? 'awaiting_approval' : 'done', completedAt: now };
  const next = promote(state.map((s, j) => (j === i ? ticked : s)));
  if (gate) return { ok: true, state: next, outcome: 'awaiting_approval' };
  return { ok: true, state: next, outcome: activeIndex(next) === -1 ? 'finished' : 'advanced' };
}

/** A step leaving its gate: whatever was going on around the review is over. */
function offGate(s: StepState): StepState {
  const { reviewing: _reviewing, reviewerOff: _off, ...rest } = s;
  return rest;
}

/** A gate step the agent finished is approved — by the user, or by the reviewer. */
export function approve(state: StepState[], index: number, by: 'user' | 'reviewer' = 'user'): StepState[] | null {
  if (state[index]?.status !== 'awaiting_approval') return null;
  return promote(state.map((s, j) => (j === index ? { ...offGate(s), status: 'done', approvedBy: by } : s)));
}

/**
 * The reviewer sends a gate step back to the agent. It keeps the step's
 * record — the reviews are the point — and touches no other step: nothing
 * after a gate has started yet.
 */
export function reviewerReopen(state: StepState[], index: number): StepState[] | null {
  if (state[index]?.status !== 'awaiting_approval') return null;
  return state.map((s, j) =>
    j === index ? { ...offGate(s), status: 'active', reviewerReopens: (s.reviewerReopens ?? 0) + 1 } : s,
  );
}

/** The step's runs so far with this one set aside, when it was worked on at all. */
function setAside(s: StepState, now: number, reason: PreviousRun['reason']): PreviousRun[] | undefined {
  const { previousRuns, reviewing: _r, reviewerOff: _o, unsentFindings: _u, ...run } = s;
  const runs = previousRuns ?? [];
  if (s.status === 'pending') return runs.length ? runs : undefined;
  return [...runs, { ...run, endedAt: now, reason }];
}

function withRuns(s: StepState, runs: PreviousRun[] | undefined): StepState {
  return runs ? { ...s, previousRuns: runs } : s;
}

/**
 * The user reopens a gate waiting for them: the step is active again and
 * nothing is sent — they write what to change. The record it had is kept as a
 * previous run; where the step began (its message, its HEAD) stays.
 */
export function userReopen(state: StepState[], index: number, now: number): StepState[] | null {
  const s = state[index];
  if (s?.status !== 'awaiting_approval') return null;
  const begun: StepState = {
    status: 'active',
    ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
    ...(s.startHead ? { startHead: s.startHead } : {}),
    ...(s.startMessageUuid ? { startMessageUuid: s.startMessageUuid } : {}),
  };
  return state.map((x, j) => (j === index ? withRuns(begun, setAside(s, now, 'reopened')) : x));
}

/**
 * "Go back here": the checklist reopens from a step the agent finished. It
 * becomes active again and every step after it pending — what followed was
 * built on it — and each one's record so far is kept as a previous run,
 * "before going back" (spec 2026-10-02-harness-redesign-design § 6).
 */
export function goBack(state: StepState[], index: number, now: number): StepState[] | null {
  const target = state[index];
  if (!target || target.status === 'pending' || target.status === 'active') return null;
  return state.map((s, j) =>
    j < index ? s : withRuns({ status: j === index ? 'active' : 'pending' }, setAside(s, now, 'went_back')),
  );
}

/** The gate the session's state shows, or null when no step waits at one. */
export function gateOf(h: Pick<SessionHarness, 'state' | 'removedAt'>): HarnessGate | null {
  if (h.removedAt !== null) return null;
  const i = activeIndex(h.state);
  if (i === -1 || h.state[i].status !== 'awaiting_approval') return null;
  return h.state[i].reviewing ? 'reviewing' : 'waiting';
}

/** A review, added to the step's record. */
export function withReview(state: StepState[], index: number, review: StepReview): StepState[] {
  return state.map((s, j) => (j === index ? { ...s, reviews: [...(s.reviews ?? []), review] } : s));
}

/** Merges what Orbital learns about a step as it begins or ends (heads, the message that began it). */
export function patchStep(state: StepState[], index: number, patch: Partial<StepState>): StepState[] {
  return state.map((s, j) => (j === index ? { ...s, ...patch } : s));
}

export interface TurnFacts {
  /** A permission question or plan approval is parked in the session. */
  decisionPending: boolean;
  /** Subagents or background tasks are still running. */
  backgroundWork: boolean;
  /** The agent ticked at least one step during the turn that just ended. */
  tickedThisTurn: boolean;
  /**
   * The agent wrote prose after its last tick. It may have moved on and hit a
   * real question in the next step, which a blind advance would talk over.
   */
  spokeAfterTick: boolean;
}

export type TurnDecision =
  | { kind: 'wait'; reason: 'paused' | 'busy' | 'finished' | 'awaiting_approval' | 'reviewing' }
  | { kind: 'pause'; reason: string; pauseKind: Extract<PauseKind, 'nudge_cap' | 'message_cap'> }
  | { kind: 'review'; index: number }
  | { kind: 'advance'; index: number }
  | { kind: 'ask_watcher'; index: number; afterTick: boolean };

/**
 * Whether the reviewer takes the gate at `index`: lucky is on, the user has
 * not taken the gate back, and it has not sent the step back as often as
 * allowed. Paused or not — a pause stops sending, not reviewing (spec
 * 2026-10-02-harness-redesign-design § 5).
 */
export function reviewerTakes(h: SessionHarness, index: number): boolean {
  const s = h.state[index];
  return h.options.lucky && s?.status === 'awaiting_approval' && !s.reviewerOff && !s.reviewing
    && (s.reviewerReopens ?? 0) < h.options.maxReviewerReopens;
}

/** What the harness does when a turn of its session ends (spec § At the end of a turn). */
export function decideTurnEnd(h: SessionHarness, facts: TurnFacts): TurnDecision {
  const i = activeIndex(h.state);
  // A gate ticked by hand while paused is still reviewed; nothing else happens while paused.
  if (h.paused) {
    return i !== -1 && reviewerTakes(h, i) && !facts.decisionPending ? { kind: 'review', index: i } : { kind: 'wait', reason: 'paused' };
  }
  if (facts.decisionPending || facts.backgroundWork) return { kind: 'wait', reason: 'busy' };
  if (i === -1) return { kind: 'wait', reason: 'finished' };
  const { options } = h;
  if (h.state[i].status === 'awaiting_approval') {
    if (h.state[i].reviewing) return { kind: 'wait', reason: 'reviewing' };
    return reviewerTakes(h, i) ? { kind: 'review', index: i } : { kind: 'wait', reason: 'awaiting_approval' };
  }
  // Lucky means "run until it is done": no cap on rounds, only on getting stuck.
  if (!options.lucky && h.autoRounds >= options.maxAutoRounds) {
    return {
      kind: 'pause', pauseKind: 'message_cap',
      reason: `Sent on its own ${options.maxAutoRounds} times, the cap for this harness. Look at the record before letting it continue.`,
    };
  }
  if (facts.tickedThisTurn) {
    return facts.spokeAfterTick ? { kind: 'ask_watcher', index: i, afterTick: true } : { kind: 'advance', index: i };
  }
  if (h.idleNudges >= options.maxIdleNudges) {
    return {
      kind: 'pause', pauseKind: 'nudge_cap',
      reason: `Stuck: ${options.maxIdleNudges} nudges without a tick. The agent keeps ending its turn on step ${i + 1} without ticking it.`,
    };
  }
  return { kind: 'ask_watcher', index: i, afterTick: false };
}

export function checklistLines(steps: HarnessStep[], state: StepState[]): string {
  return steps
    .map((step, i) => {
      const s = state[i]?.status ?? 'pending';
      const mark = s === 'done' ? '[x]' : s === 'awaiting_approval' ? '[~]' : s === 'active' ? '[>]' : '[ ]';
      const gate = step.mode === 'gate' ? ' (gate: the user approves it)' : '';
      return `${mark} ${i + 1}. ${step.title} — id \`${step.id}\`${gate}`;
    })
    .join('\n');
}

function stepBlock(step: HarnessStep, index: number): string {
  const verify = step.verify ? `\nBefore it can be ticked, Orbital runs: \`${step.verify}\` (must exit 0).` : '';
  return `## Step ${index + 1}: ${step.title}\n\n${step.instructions}\n\nDone when: ${step.doneWhen}${verify}`;
}

function howToTick(options: HarnessOptions): string {
  const commit = options.commitPerStep
    ? ' Before ticking, commit the step\'s work locally with a message naming the step (never push); Orbital refuses the tick while the working tree has uncommitted changes.'
    : '';
  return `When a step is done, call the \`harness_complete_step\` tool with its id, a summary of what you did, the decisions you made (what, why, what else you considered) and anything the user should still look at. That record is what the user reads later, so make the reasons real.${commit} Tick only the active step. Do not stop to ask whether to continue with the next step: Orbital sends you on. Stop and ask only when you need a real decision or information only the user has, or before anything outward (push, merge, PR, deleting data).`;
}

export function kickoffMessage(h: SessionHarness, inputs: HarnessInput[]): string {
  const given = inputs
    .filter((input) => h.inputs[input.key]?.trim())
    .map((input) => `- ${input.label}: ${h.inputs[input.key]}`)
    .join('\n');
  const i = Math.max(activeIndex(h.state), 0);
  // A harness carried into a new session may stand at a gate the user has not decided yet.
  const tail = h.state[i]?.status === 'awaiting_approval'
    ? `Step ${i + 1} "${h.steps[i].title}" is done and waits for the user's approval. Do not start the next step until Orbital sends it.`
    : stepBlock(h.steps[i], i);
  return [
    `This session follows the Orbital harness "${h.name}". The checklist:`,
    checklistLines(h.steps, h.state),
    given ? `Inputs:\n${given}` : '',
    howToTick(h.options),
    tail,
  ].filter(Boolean).join('\n\n');
}

export function advanceMessage(h: SessionHarness, index: number): string {
  return [
    `Harness "${h.name}": continue with step ${index + 1} of ${h.steps.length}.`,
    stepBlock(h.steps[index], index),
    `Checklist:\n${checklistLines(h.steps, h.state)}`,
  ].join('\n\n');
}

/** The reviewer sent a gate step back: what it found goes to the agent as it is. */
export function reviewerReopenMessage(h: SessionHarness, index: number, review: StepReview): string {
  const findings = review.findings.length > 0 ? review.findings.map((f) => `- ${f}`).join('\n') : `- ${review.reasoning}`;
  return [
    `Harness "${h.name}": a reviewer looked at step ${index + 1} "${h.steps[index].title}" and sent it back.`,
    `Findings:\n${findings}`,
    `Reasoning: ${review.reasoning}`,
    `Fix these, then tick the step again with \`harness_complete_step\` (id \`${h.steps[index].id}\`).`,
  ].join('\n\n');
}

export function nudgeMessage(h: SessionHarness, index: number): string {
  const step = h.steps[index];
  return `Harness "${h.name}": step ${index + 1} "${step.title}" is not ticked yet. Nothing in the checklist needs the user here, so carry on with it. Done when: ${step.doneWhen}. When it is done, call \`harness_complete_step\` with id \`${step.id}\`.`;
}

/** What `harness_status` answers: the checklist and the active step in full. */
export function statusText(h: SessionHarness): string {
  const i = activeIndex(h.state);
  const tail =
    i === -1
      ? 'Every step is done.'
      : h.state[i].status === 'awaiting_approval'
        ? `Step ${i + 1} is done and waits for the user's approval.`
        : stepBlock(h.steps[i], i);
  return `Harness "${h.name}"${h.paused ? ' (paused)' : ''}\n\n${checklistLines(h.steps, h.state)}\n\n${tail}`;
}

/** A template scope as a request names it: global, or a project by its absolute root. */
export function isScope(v: unknown): v is { kind: 'global' } | { kind: 'project'; root: string } {
  if (!v || typeof v !== 'object') return false;
  const { kind, root } = v as Record<string, unknown>;
  return kind === 'global' || (kind === 'project' && typeof root === 'string' && root.startsWith('/'));
}

/** Why a template cannot be saved, or null. The editor shows it as is. */
export function validateTemplate(t: { name?: unknown; inputs?: unknown; steps?: unknown; tags?: unknown; options?: unknown; scope?: unknown }): string | null {
  if (t.options !== undefined && (t.options === null || typeof t.options !== 'object')) return 'options must be an object';
  if (t.scope !== undefined && !isScope(t.scope)) {
    return 'scope must be { kind: "global" } or { kind: "project", root: <absolute path> }';
  }
  if (typeof t.name !== 'string' || !t.name.trim()) return 'name is required';
  if (!Array.isArray(t.tags) || t.tags.some((tag) => typeof tag !== 'string')) return 'tags must be a list of strings';
  if (!Array.isArray(t.inputs)) return 'inputs must be a list';
  const keys = new Set<string>();
  for (const input of t.inputs as Partial<HarnessInput>[]) {
    if (typeof input?.key !== 'string' || !/^[\w-]+$/.test(input.key)) return 'every input needs a key of letters, digits, - or _';
    if (keys.has(input.key)) return `input key "${input.key}" is used twice`;
    keys.add(input.key);
    if (typeof input.label !== 'string' || !input.label.trim()) return `input "${input.key}" needs a label`;
  }
  if (!Array.isArray(t.steps) || t.steps.length === 0) return 'a template needs at least one step';
  const ids = new Set<string>();
  for (const step of t.steps as Partial<HarnessStep>[]) {
    if (typeof step?.id !== 'string' || !step.id.trim()) return 'every step needs an id';
    if (ids.has(step.id)) return `step id "${step.id}" is used twice`;
    ids.add(step.id);
    if (typeof step.title !== 'string' || !step.title.trim()) return `step "${step.id}" needs a title`;
    if (typeof step.instructions !== 'string') return `step "${step.id}" needs instructions`;
    if (step.mode !== 'auto' && step.mode !== 'gate') return `step "${step.id}" mode must be auto or gate`;
    if (typeof step.doneWhen !== 'string') return `step "${step.id}" needs done criteria`;
    if (step.verify !== undefined && typeof step.verify !== 'string') return `step "${step.id}" verify must be a command`;
  }
  return null;
}
