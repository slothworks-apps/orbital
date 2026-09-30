import type { NarrationFailure, NarrationIntent, Walkthrough } from './types.js';

/**
 * A fenced block whose fences open lines: its language tag and its body.
 * Matched globally, so each block's closing fence is consumed with it and
 * never mistaken for the opening of the next.
 */
const FENCE = /^```[ \t]*([^\n`]*?)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;

/** The body of the first bare or json-tagged fenced block that parses and holds an `intents` array. */
function intentsBlock(answer: string): unknown[] | null {
  for (const m of answer.matchAll(FENCE)) {
    const lang = m[1].toLowerCase();
    if (lang !== '' && lang !== 'json') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(m[2]); } catch { continue; }
    const intents = parsed && typeof parsed === 'object' ? (parsed as { intents?: unknown }).intents : undefined;
    if (Array.isArray(intents)) return intents;
  }
  return null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * The narrate query's answer, read tolerantly (spec 2026-09-23-walkthrough-design
 * § Narration, "Reading it back"): the first bare or json-tagged fenced block
 * that parses with an `intents` array wins; unknown step ids are dropped; a step
 * the model did not name becomes its own intent with no summary, in
 * transcript order; a step named twice stays with the first intent. Null
 * means there was nothing parsable — which the page shows as a failure.
 */
export function parseNarration(answer: string, knownStepIds: string[]): NarrationIntent[] | null {
  const raw = intentsBlock(answer);
  if (!raw) return null;
  const named: NarrationIntent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    named.push({
      title: typeof r.title === 'string' ? r.title : '',
      summary: typeof r.summary === 'string' ? r.summary : '',
      steps: strings(r.steps),
      considered: strings(r.considered),
      abandoned: r.abandoned === true,
    });
  }
  return placeIntents(named, knownStepIds);
}

/**
 * Intents laid over the steps there are: ids no step has are dropped, a step
 * named twice stays with the first intent, an intent left with no step goes,
 * and a step no intent names becomes its own untitled intent. Ordered by
 * each intent's first step.
 */
function placeIntents(intents: NarrationIntent[], knownStepIds: string[]): NarrationIntent[] {
  const known = new Set(knownStepIds);
  const taken = new Set<string>();
  const named: NarrationIntent[] = [];
  for (const intent of intents) {
    const steps = intent.steps.filter((id) => known.has(id) && !taken.has(id));
    for (const id of steps) taken.add(id);
    if (steps.length > 0) named.push({ ...intent, steps });
  }
  // Interleave: walk the known steps in order; a step opens its intent the first time it is met.
  const out: NarrationIntent[] = [];
  const placed = new Set<NarrationIntent>();
  for (const id of knownStepIds) {
    const intent = named.find((i) => i.steps.includes(id));
    if (intent) {
      if (!placed.has(intent)) { placed.add(intent); out.push(intent); }
    } else {
      out.push({ title: '', summary: '', steps: [id], considered: [], abandoned: false });
    }
  }
  return out;
}

/** A session's stored narration, as `NarrationStore` reads it back. */
export interface NarrationState {
  status: 'running' | 'done' | 'failed';
  /** The last `done` run's intents — kept while a newer run is `running`. */
  intents: NarrationIntent[] | null;
  failure: NarrationFailure | null;
}

export type NarrationFields = Pick<Walkthrough, 'narration' | 'narrationFailed' | 'narrationPending' | 'narrationFailure'>;

/**
 * The walkthrough's narration fields from the stored row (spec
 * 2026-09-30-narrate-out-of-band-design § Storage and state). The stored
 * intents are laid over the steps the transcript has NOW: a step a rewind
 * took away drops out, and a step added since stands as its own untitled
 * intent and counts in `staleSteps`. A narration none of whose steps are
 * left is no narration.
 */
export function narrationFields(state: NarrationState | null, stepIds: string[]): NarrationFields {
  let narration: Walkthrough['narration'] = null;
  if (state?.intents) {
    const named = new Set(state.intents.flatMap((i) => i.steps));
    const staleSteps = stepIds.filter((id) => !named.has(id)).length;
    if (staleSteps < stepIds.length) narration = { intents: placeIntents(state.intents, stepIds), staleSteps };
  }
  const failed = state?.status === 'failed';
  return {
    narration,
    narrationFailed: failed,
    narrationPending: state?.status === 'running',
    narrationFailure: failed ? (state.failure ?? 'error') : null,
  };
}
