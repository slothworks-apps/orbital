/**
 * The harness's decisions, pure and synchronous: filling a template in, the
 * step state machine, what to do when a turn ends, and the text Orbital
 * sends into the session. Everything with a side effect is in `service.ts`.
 */

import {
  DEFAULT_OPTIONS, type HarnessChanges, type HarnessGate, type HarnessInput, type HarnessOptions, type HarnessStep, type PauseKind,
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

/** The ids a step needs: the ones it names, or the step before it when it names none. */
export function depsOf(steps: HarnessStep[], index: number): string[] {
  return steps[index].dependsOn ?? (index === 0 ? [] : [steps[index - 1].id]);
}

export function initialState(steps: HarnessStep[]): StepState[] {
  return promote(steps, steps.map(() => ({ status: 'pending' })));
}

/** Every step done. */
export function isFinished(state: StepState[]): boolean {
  return state.every((s) => s.status === 'done');
}

/** The steps open for work: every `active` one, in checklist order. */
export function openIndexes(state: StepState[]): number[] {
  return state.flatMap((s, i) => (s.status === 'active' ? [i] : []));
}

/** The steps the agent finished that wait at their gate, in checklist order. */
export function gateIndexes(state: StepState[]): number[] {
  return state.flatMap((s, i) => (s.status === 'awaiting_approval' ? [i] : []));
}

/** The steps that need `index`, directly or through others. */
export function descendantsOf(steps: HarnessStep[], index: number): Set<number> {
  const ids = new Set([steps[index].id]);
  const found = new Set<number>();
  // Steps only depend on earlier ones, so one pass in order finds them all.
  for (let j = index + 1; j < steps.length; j++) {
    if (depsOf(steps, j).some((id) => ids.has(id))) {
      ids.add(steps[j].id);
      found.add(j);
    }
  }
  return found;
}

/** The ids `index` still waits for. */
function waitingFor(steps: HarnessStep[], state: StepState[], index: number): string[] {
  return depsOf(steps, index).filter((id) => state[steps.findIndex((s) => s.id === id)]?.status !== 'done');
}

/** Opens every pending step whose steps it needs are all done. */
function promote(steps: HarnessStep[], state: StepState[]): StepState[] {
  return state.map((s, i) => (s.status === 'pending' && waitingFor(steps, state, i).length === 0 ? { ...s, status: 'active' } : s));
}

export type TickResult =
  | { ok: true; state: StepState[]; outcome: 'advanced' | 'awaiting_approval' | 'finished'; unlocked: number[] }
  | { ok: false; error: string };

/** What the agent writes into a step's record when it ticks it. */
export interface TickRecord {
  summary: string;
  decisions: StepDecision[];
  openQuestions: string[];
}

/** The steps a change opened: active now, not before. */
function opened(before: StepState[], after: StepState[]): number[] {
  return after.flatMap((s, i) => (s.status === 'active' && before[i]?.status !== 'active' ? [i] : []));
}

/**
 * The agent says a step is done. Any open step can be ticked; a step whose
 * steps it needs are not done yet cannot — the graph is still a checklist.
 */
export function tick(
  steps: HarnessStep[], state: StepState[], stepId: string, record: TickRecord, now: number,
): TickResult {
  if (isFinished(state)) return { ok: false, error: 'Every step is already done.' };
  const open = openIndexes(state).map((i) => `"${steps[i].id}"`).join(', ') || 'none';
  const index = steps.findIndex((s) => s.id === stepId);
  if (index === -1) return { ok: false, error: `No step "${stepId}". The open steps are: ${open}.` };
  const status = state[index].status;
  if (status === 'awaiting_approval') {
    return { ok: false, error: `Step "${stepId}" is already done and waits for the user's approval.` };
  }
  if (status === 'done') return { ok: false, error: `Step "${stepId}" is already done. The open steps are: ${open}.` };
  if (status === 'pending') {
    return { ok: false, error: `Step "${stepId}" waits for ${waitingFor(steps, state, index).map((id) => `"${id}"`).join(', ')}. The open steps are: ${open}.` };
  }
  const gate = steps[index].mode === 'gate';
  // What Orbital recorded when the step began (heads, the message) stays.
  const ticked: StepState = { ...state[index], ...record, status: gate ? 'awaiting_approval' : 'done', completedAt: now };
  const next = promote(steps, state.map((s, j) => (j === index ? ticked : s)));
  const unlocked = opened(state, next);
  if (gate) return { ok: true, state: next, outcome: 'awaiting_approval', unlocked };
  return { ok: true, state: next, outcome: isFinished(next) ? 'finished' : 'advanced', unlocked };
}

/** A step leaving its gate: whatever was going on around the review is over. */
function offGate(s: StepState): StepState {
  const { reviewing: _reviewing, reviewerOff: _off, ...rest } = s;
  return rest;
}

/** A gate step the agent finished is approved — by the user, or by the reviewer. */
export function approve(
  steps: HarnessStep[], state: StepState[], index: number, by: 'user' | 'reviewer' = 'user',
): StepState[] | null {
  if (state[index]?.status !== 'awaiting_approval') return null;
  return promote(steps, state.map((s, j) => (j === index ? { ...offGate(s), status: 'done', approvedBy: by } : s)));
}

/**
 * The reviewer sends a gate step back to the agent. It keeps the step's
 * record — the reviews are the point — and touches no other step: nothing
 * that needs the gate has started yet.
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
 * becomes active again and every step that needs it pending — what followed
 * was built on it — and each one's record so far is kept as a previous run,
 * "before going back" (spec 2026-10-02-harness-redesign-design § 6). Other
 * branches keep theirs (spec 2026-10-06-harness-graph-and-proposals-design).
 */
export function goBack(steps: HarnessStep[], state: StepState[], index: number, now: number): StepState[] | null {
  const target = state[index];
  if (!target || target.status === 'pending' || target.status === 'active') return null;
  const after = descendantsOf(steps, index);
  return state.map((s, j) => {
    if (j === index) return withRuns({ status: 'active' }, setAside(s, now, 'went_back'));
    return after.has(j) ? withRuns({ status: 'pending' }, setAside(s, now, 'went_back')) : s;
  });
}

/**
 * What the session's state shows of its harness: a gate waiting for the user,
 * or a proposal waiting for them — both NEEDS YOUR OK — else a gate a
 * reviewer is reading, else null.
 */
export function gateOf(h: Pick<SessionHarness, 'state' | 'removedAt'> | null, proposal = false): HarnessGate | null {
  const live = h && h.removedAt === null ? h : null;
  const gates = live ? gateIndexes(live.state).map((i) => live.state[i]) : [];
  if (gates.some((s) => !s.reviewing)) return 'waiting';
  if (proposal) return 'proposal';
  return gates.length > 0 ? 'reviewing' : null;
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
  const open = openIndexes(h.state);
  const gates = gateIndexes(h.state);
  const reviewable = gates.find((i) => reviewerTakes(h, i));
  // A gate ticked by hand while paused is still reviewed; nothing else happens while paused.
  if (h.paused) {
    return reviewable !== undefined && !facts.decisionPending ? { kind: 'review', index: reviewable } : { kind: 'wait', reason: 'paused' };
  }
  if (facts.decisionPending || facts.backgroundWork) return { kind: 'wait', reason: 'busy' };
  if (isFinished(h.state)) return { kind: 'wait', reason: 'finished' };
  // Only gates are left. With steps still open, the agent goes on with them
  // while a gate waits; the service hands such gates to the reviewer alongside.
  if (open.length === 0) {
    if (gates.some((i) => h.state[i].reviewing)) return { kind: 'wait', reason: 'reviewing' };
    return reviewable !== undefined ? { kind: 'review', index: reviewable } : { kind: 'wait', reason: 'awaiting_approval' };
  }
  const { options } = h;
  const i = open[0];
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
      reason: `Stuck: ${options.maxIdleNudges} nudges without a tick. The agent keeps ending its turn on ${stepNames(h, open)} without ticking it.`,
    };
  }
  return { kind: 'ask_watcher', index: i, afterTick: false };
}

/** "step 3" or "steps 3 and 6". */
function stepNames(h: SessionHarness, indexes: number[]): string {
  const n = indexes.map((i) => String(i + 1));
  return n.length === 1 ? `step ${n[0]}` : `steps ${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
}

export function checklistLines(steps: HarnessStep[], state: StepState[]): string {
  return steps
    .map((step, i) => {
      const s = state[i]?.status ?? 'pending';
      const mark = s === 'done' ? '[x]' : s === 'awaiting_approval' ? '[~]' : s === 'active' ? '[>]' : '[ ]';
      const gate = step.mode === 'gate' ? ' (gate: the user approves it)' : '';
      // Only a step that names its own dependencies says them; the rest follow the one before.
      const needs = step.dependsOn
        ? ` — needs ${step.dependsOn.length ? step.dependsOn.map((id) => steps.findIndex((x) => x.id === id) + 1).join(', ') : 'nothing'}`
        : '';
      return `${mark} ${i + 1}. ${step.title} — id \`${step.id}\`${gate}${needs}`;
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
  return `When a step is done, call the \`harness_complete_step\` tool with its id, a summary of what you did, the decisions you made (what, why, what else you considered) and anything the user should still look at. That record is what the user reads later, so make the reasons real.${commit} Tick only an open step ([>]); a step marked [ ] waits for the steps it needs. Do not stop to ask whether to continue with the next step: Orbital sends you on. Stop and ask only when you need a real decision or information only the user has, or before anything outward (push, merge, PR, deleting data).`;
}

/**
 * Where the checklist stands, for the agent: the gates waiting for the user,
 * then each open step — in full when it has not begun yet, or always when
 * `full` — or that every step is done.
 */
function where(h: SessionHarness, full: boolean): string {
  const open = openIndexes(h.state);
  const gates = gateIndexes(h.state).map((i) => open.length === 0
    ? `Step ${i + 1} "${h.steps[i].title}" is done and waits for the user's approval. Do not start the next step until Orbital sends it.`
    : `Step ${i + 1} "${h.steps[i].title}" is done and waits for the user's approval; the steps that need it wait too.`);
  const blocks = open.map((i) => full || open.length === 1 || h.state[i].startedAt === undefined
    ? stepBlock(h.steps[i], i)
    : `Step ${i + 1} "${h.steps[i].title}" is in progress. Done when: ${h.steps[i].doneWhen}`);
  if (open.length > 1) blocks.unshift(`${stepNames(h, open)[0].toUpperCase()}${stepNames(h, open).slice(1)} are open: work through them one at a time, in any order, and tick each as it is done.`);
  if (gates.length === 0 && blocks.length === 0) return 'Every step is done.';
  return [...gates, ...blocks].join('\n\n');
}

export function kickoffMessage(h: SessionHarness, inputs: HarnessInput[]): string {
  const given = inputs
    .filter((input) => h.inputs[input.key]?.trim())
    .map((input) => `- ${input.label}: ${h.inputs[input.key]}`)
    .join('\n');
  return [
    `This session follows the Orbital harness "${h.name}". The checklist:`,
    checklistLines(h.steps, h.state),
    given ? `Inputs:\n${given}` : '',
    howToTick(h.options),
    where(h, true),
  ].filter(Boolean).join('\n\n');
}

/** Sends the agent on: the open steps, those that have not begun in full. */
export function advanceMessage(h: SessionHarness): string {
  const open = openIndexes(h.state);
  return [
    open.length === 1
      ? `Harness "${h.name}": continue with step ${open[0] + 1} of ${h.steps.length}.`
      : `Harness "${h.name}": continue.`,
    where(h, false),
    `Checklist:\n${checklistLines(h.steps, h.state)}`,
  ].join('\n\n');
}

/** What changed in a checklist, by step id. */
export interface ChecklistDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

/** The checklist changed under the agent: what changed, and where it stands now. */
export function editedMessage(h: SessionHarness, diff: ChecklistDiff, by: 'user' | 'agent'): string {
  const title = (id: string) => {
    const i = h.steps.findIndex((s) => s.id === id);
    return i === -1 ? `\`${id}\`` : `${i + 1} "${h.steps[i].title}"`;
  };
  const parts = [
    diff.added.length ? `added ${diff.added.map(title).join(', ')}` : '',
    diff.changed.length ? `changed ${diff.changed.map(title).join(', ')}` : '',
    diff.removed.length ? `removed ${diff.removed.map((id) => `\`${id}\``).join(', ')}` : '',
  ].filter(Boolean);
  const who = by === 'agent' ? 'The user accepted the changes you proposed' : 'The user changed the checklist';
  return [
    `Harness "${h.name}": ${who}: ${parts.join('; ') || 'nothing'}.`,
    `Checklist:\n${checklistLines(h.steps, h.state)}`,
    where(h, false),
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

export function nudgeMessage(h: SessionHarness): string {
  const open = openIndexes(h.state);
  if (open.length === 1) {
    const step = h.steps[open[0]];
    return `Harness "${h.name}": step ${open[0] + 1} "${step.title}" is not ticked yet. Nothing in the checklist needs the user here, so carry on with it. Done when: ${step.doneWhen}. When it is done, call \`harness_complete_step\` with id \`${step.id}\`.`;
  }
  const list = open.map((i) => `- ${i + 1} "${h.steps[i].title}" (id \`${h.steps[i].id}\`): done when ${h.steps[i].doneWhen}`).join('\n');
  return `Harness "${h.name}": ${stepNames(h, open)} are open and not ticked yet. Nothing in the checklist needs the user here, so carry on with them, one at a time. When one is done, call \`harness_complete_step\` with its id.\n\n${list}`;
}

/** What `harness_status` answers: the checklist and every open step in full. */
export function statusText(h: SessionHarness): string {
  return `Harness "${h.name}"${h.paused ? ' (paused)' : ''}\n\n${checklistLines(h.steps, h.state)}\n\n${where(h, true)}`;
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
    if (step.dependsOn !== undefined && (!Array.isArray(step.dependsOn) || step.dependsOn.some((d) => typeof d !== 'string'))) {
      return `step "${step.id}" dependsOn must be a list of step ids`;
    }
  }
  return validateGraph(t.steps as HarnessStep[]);
}

/**
 * Why the steps do not form a checklist graph, or null. A step may need only
 * steps before it, which also rules out every cycle; the array order stays
 * the order the checklist is read in.
 */
export function validateGraph(steps: HarnessStep[]): string | null {
  const seen = new Set<string>();
  const all = new Set(steps.map((s) => s.id));
  for (const step of steps) {
    for (const id of step.dependsOn ?? []) {
      if (id === step.id) return `step "${step.id}" depends on itself`;
      if (!all.has(id)) return `step "${step.id}" depends on "${id}", which is not a step`;
      if (!seen.has(id)) return `step "${step.id}" depends on "${id}", which comes after it; move it before`;
    }
    seen.add(step.id);
  }
  return null;
}

export type ApplyResult =
  | { ok: true; steps: HarnessStep[]; state: StepState[]; diff: ChecklistDiff; opened: number[] }
  | { ok: false; error: string };

/**
 * Edits a running harness (spec 2026-10-06-harness-graph-and-proposals-design
 * § Edits by the user). A step done or at its gate cannot change; going back
 * to it is how it is redone. Removing a step hands what it needed to the
 * steps that needed it. An open step whose steps it needs are no longer all
 * done waits again, its record so far kept as an `edited` previous run.
 */
export function applyChanges(
  steps: HarnessStep[], state: StepState[], changes: HarnessChanges, now: number,
): ApplyResult {
  const add = changes.add ?? [];
  const update = changes.update ?? [];
  const remove = changes.remove ?? [];
  const index = new Map(steps.map((s, i) => [s.id, i]));
  const locked = (id: string) => {
    const status = state[index.get(id)!].status;
    return status === 'done' || status === 'awaiting_approval';
  };
  for (const id of [...update.map((s) => s.id), ...remove]) {
    if (!index.has(id)) return { ok: false, error: `there is no step "${id}"` };
    if (locked(id)) return { ok: false, error: `step "${id}" is finished; go back to it to change it` };
  }
  for (const step of add) {
    if (index.has(step.id)) return { ok: false, error: `step id "${step.id}" is used already` };
  }
  // Every dependency written out, so removing or adding a step moves none by accident.
  let next: HarnessStep[] = steps.map((s, i) => ({ ...s, dependsOn: depsOf(steps, i) }));
  for (const changed of update) {
    next = next.map((s) => (s.id === changed.id ? { ...changed, dependsOn: changed.dependsOn ?? s.dependsOn } : s));
  }
  for (const id of remove) {
    const gone = next.find((s) => s.id === id)!;
    next = next
      .filter((s) => s.id !== id)
      .map((s) => (s.dependsOn!.includes(id)
        ? { ...s, dependsOn: [...new Set(s.dependsOn!.flatMap((d) => (d === id ? gone.dependsOn! : [d])))] }
        : s));
  }
  for (const step of add) {
    next.push({ ...step, dependsOn: step.dependsOn ?? (next.length ? [next[next.length - 1].id] : []) });
  }
  const error = validateTemplate({ name: 'harness', tags: [], inputs: [], steps: next });
  if (error) return { ok: false, error: error === 'a template needs at least one step' ? 'a harness needs at least one step' : error };
  const byId = new Map(steps.map((s, i) => [s.id, state[i]]));
  const placed: StepState[] = next.map((s) => byId.get(s.id) ?? { status: 'pending' });
  const waiting = placed.map((s, i) => {
    if (s.status !== 'active' || waitingFor(next, placed, i).length === 0) return s;
    return withRuns({ status: 'pending' }, setAside(s, now, 'edited'));
  });
  const promoted = promote(next, waiting);
  return {
    ok: true,
    steps: next,
    state: promoted,
    diff: { added: add.map((s) => s.id), changed: update.map((s) => s.id), removed: [...remove] },
    opened: opened(placed, promoted),
  };
}
