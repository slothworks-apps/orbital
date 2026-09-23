/**
 * The walkthrough's wire format (adr: an-orbital-tag-marks-a-walkthrough-turn).
 *
 * Orbital does not learn the uuid of a user message it sends — the CLI mints
 * it — so the turns the walkthrough sends into a session carry an explicit
 * tag in their text, and that tag is how they are found again: to read a
 * narration back, to attach a question to its step, and to fold the machinery
 * behind a chip in the transcript. The parser treats the tag as one of its
 * noise blocks (`NOISE_BLOCK` in `transcript/parser.ts`).
 */

export const WALKTHROUGH_TAG = 'orbital-walkthrough';

export type WalkthroughTag =
  | { kind: 'narrate' }
  | { kind: 'ask'; step: string; n: number | null };

/** How much of a step's calls an ask turn carries. Past this the block says it was cut. */
export const ASK_CONTEXT_MAX_CHARS = 12_000;

const OPEN_TAG = new RegExp(`<${WALKTHROUGH_TAG}\\b([^>]*)>`);

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : null;
}

export function parseWalkthroughTag(text: string): WalkthroughTag | null {
  const m = OPEN_TAG.exec(text);
  if (!m) return null;
  const attrs = m[1];
  const kind = attr(attrs, 'kind');
  if (kind === 'narrate') return { kind: 'narrate' };
  if (kind === 'ask') {
    const step = attr(attrs, 'step');
    if (!step) return null;
    const rawN = attr(attrs, 'n');
    const n = rawN !== null && /^\d+$/.test(rawN) ? Number(rawN) : null;
    return { kind: 'ask', step, n };
  }
  return null;
}

/** The chip label the transcript shows for a folded walkthrough turn (canvas 21g). */
export function walkthroughChipName(tag: WalkthroughTag): string {
  if (tag.kind === 'narrate') return 'walkthrough · narrate';
  return tag.n === null ? 'walkthrough · ask' : `walkthrough · ask · step ${tag.n}`;
}

/**
 * Anything embedded inside the tag has its `</` written as `<\/`, so content
 * quoting the closing tag (an edit to this very file, a test fixture) cannot
 * end the block early. In the JSON body `\/` is a valid escape the model reads
 * as `/`; in a path or a narration line it reads the same to a person.
 */
export function escapeInTag(text: string): string {
  return text.replace(/<\//g, '<\\/');
}

export interface NarrateStepLine {
  id: string;
  ordinal: number;
  paths: string[];
  /** The first line of the step's own narration, or empty. */
  firstLine: string;
}

/**
 * The narrate turn. Nothing outside the tag, so the transcript chip is the
 * whole turn. The model is asked for exactly one fenced JSON block; the
 * parser (`narration.ts`) reads the first one it finds.
 */
export function buildNarrateText(steps: NarrateStepLine[]): string {
  const lines = steps.map((s) => {
    const paths = escapeInTag(s.paths.join(', '));
    const said = s.firstLine ? ` · "${escapeInTag(s.firstLine)}"` : '';
    return `- step ${s.ordinal} · id ${s.id} · ${paths}${said}`;
  });
  return [
    `<${WALKTHROUGH_TAG} kind="narrate">`,
    'Orbital is building a walkthrough of what you changed in this session, for the person who ran it to read.',
    'Below are the steps — each is a run of tool calls that changed at least one file, in the order they happened.',
    'Group consecutive steps into intents. For each intent give a short title, a one- or two-sentence summary of what it did and why,',
    'what you considered and did not do (if anything), and whether you abandoned it later.',
    '',
    ...lines,
    '',
    'Answer with exactly one fenced ```json block and nothing else, in this shape:',
    '```json',
    '{"intents": [{"title": "…", "summary": "…", "steps": ["<step id>"], "considered": ["…"], "abandoned": false}]}',
    '```',
    'Use the step ids verbatim. Every step must appear in exactly one intent.',
    `</${WALKTHROUGH_TAG}>`,
  ].join('\n');
}

export interface AskContext {
  step: string;
  ordinal: number;
  paths: string[];
  calls: Array<{ tool: string; input: unknown }>;
}

/**
 * The ask turn. The human question is the visible text; the step's calls ride
 * in the tag so the answer is about the exact edit rather than a memory of it.
 */
export function buildAskText(question: string, ctx: AskContext): string {
  let body = escapeInTag(ctx.calls
    .map((c) => `${c.tool}:\n${JSON.stringify(c.input, null, 2)}`)
    .join('\n\n'));
  if (body.length > ASK_CONTEXT_MAX_CHARS) {
    body = `${body.slice(0, ASK_CONTEXT_MAX_CHARS)}\n… (truncated by Orbital)`;
  }
  return [
    question.trim(),
    '',
    `<${WALKTHROUGH_TAG} kind="ask" step="${ctx.step}" n="${ctx.ordinal}">`,
    `The question above is about step ${ctx.ordinal} of the walkthrough of this session — the change to ${escapeInTag(ctx.paths.join(', '))}.`,
    'The calls that made the change, as recorded:',
    '',
    body,
    `</${WALKTHROUGH_TAG}>`,
  ].join('\n');
}
