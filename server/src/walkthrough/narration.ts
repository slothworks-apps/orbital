import type { NarrationIntent } from './types.js';

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
 * The narrate turn's answer, read tolerantly (spec § Narration, "Reading it
 * back"): the first bare or json-tagged fenced block that parses with an
 * `intents` array wins; unknown step ids are dropped; a step
 * the model did not name becomes its own intent with no summary, in
 * transcript order; a step named twice stays with the first intent. Null
 * means there was nothing parsable — which the page shows as a failure.
 */
export function parseNarration(answer: string, knownStepIds: string[]): NarrationIntent[] | null {
  const raw = intentsBlock(answer);
  if (!raw) return null;
  const known = new Set(knownStepIds);
  const taken = new Set<string>();
  const named: NarrationIntent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const steps = strings(r.steps).filter((id) => known.has(id) && !taken.has(id));
    for (const id of steps) taken.add(id);
    if (steps.length === 0) continue;
    named.push({
      title: typeof r.title === 'string' ? r.title : '',
      summary: typeof r.summary === 'string' ? r.summary : '',
      steps,
      considered: strings(r.considered),
      abandoned: r.abandoned === true,
    });
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
