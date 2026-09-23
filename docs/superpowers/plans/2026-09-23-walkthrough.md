---
id: 2026-09-23-walkthrough
title: Walkthrough — implementation plan
status: done
type: plan
domain: sessions
related:
  - 2026-09-23-walkthrough-design
  - walkthrough-narration-is-a-turn-in-the-session
  - an-orbital-tag-marks-a-walkthrough-turn
tags:
  - walkthrough
---
# Walkthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-screen page at `/walkthrough/<sessionId>` that walks the person who ran an Orbital session through every file change in order, lets them ask the session about a step, and lets the session narrate its own work on request.

**Architecture:** The server builds a mechanical *spine* from the transcript — steps (runs of tool calls that wrote a file), gaps between them, each step's fate — as a pure function over the `ChatMessage[]` the transcript route already produces. Narration and questions are ordinary turns sent into the session, marked with an `<orbital-walkthrough>` tag the parser folds like a command expansion; the transcript is the only store. The web page fetches the spine, draws each step's change with the existing `ChangeView`, and refetches when the session's WS topic delivers a message.

**Tech Stack:** Fastify + drizzle (server), React + zustand + vitest (web). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-walkthrough-design.md` — read it first; canvas `Feature - Walkthrough.dc.html` artboards 21a–21h are the drawing (the main session verifies fidelity; subagents do not have DesignSync).

## Global Constraints

- Server files use semicolons; web files do not. Match the file you are in (`prettier` decides; run `npm run format` on files you touched).
- Never restate a constant's value in a comment; refer to it by name.
- Orbital's own sessions only: narrate/ask refuse a session whose row has `source: 'terminal'` or that the registry reports live in a terminal.
- Nothing is stored for the walkthrough. No new table, no migration.
- Diffs are computed in the browser only (`web/src/lib/fileEdit.ts`, `web/src/lib/diff.ts`). The server ships raw `tool_use`/`tool_result` messages.
- The tag name is `orbital-walkthrough`; attributes `kind` (`narrate` | `ask`), `step` (a `toolUseId`), `n` (ordinal, label only).
- A step's `id` is the `toolUseId` of the first writing call in its run. Never an ordinal.
- Writing tools are exactly `Edit`, `Write`, `NotebookEdit` (server constant `WRITING_TOOLS`), plus an `Agent`/`Task` dispatch whose own messages contain a writing call.
- Deletions by shell command are not detected. Do not parse `rm`.
- No estimates: durations come from timestamps or are `null`.
- Tests only where they catch a regression: pure logic, routes, parsers. Not render-of-props, not styling values.
- Run `atlas validate` before every commit that touches `docs/`.
- Commit after each task with a conventional message (`feat(server/walkthrough): …`, `feat(web/walkthrough): …`, `docs: …`).

## Review Focus

1. A transcript whose first run has no assistant text before it (the agent wrote on the user's first turn) — the step exists with `narration: ''`, not a crash and not a dropped step. Pinned in Task 2.
2. An `Edit` whose `old_string` equals its `new_string` on the same path twice in a row — must not mark itself *reverted*/*revised* (same-step and self-comparison excluded). Pinned in Task 2.
3. A narrate answer that carries prose plus a fenced block with trailing commentary, or two fenced blocks — the first parsable JSON block wins; a block that parses but lacks `intents` is a failure, not an empty narration. Pinned in Task 3.
4. A subagent directory with a `.meta.json` whose `toolUseId` names no `Agent` call in the parent (a resumed agent, a stale file) — ignored, the parent's steps unaffected. Pinned in Task 4.
5. Asking while the session is `working` — the server must refuse (`409 busy`) even if a stale page enables the field. Pinned in Task 5.

---

### Task 1: The wire format — tag builders, tag parser, and the transcript chip

**Files:**
- Create: `server/src/walkthrough/tag.ts`
- Modify: `server/src/transcript/parser.ts` (`NOISE_BLOCK` at line ~94, `splitUserText` at line ~105)
- Test: `server/test/walkthroughTag.test.ts`, `server/test/parser.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const WALKTHROUGH_TAG = 'orbital-walkthrough';
  export type WalkthroughTag =
    | { kind: 'narrate' }
    | { kind: 'ask'; step: string; n: number | null };
  export function parseWalkthroughTag(text: string): WalkthroughTag | null;
  export function walkthroughChipName(tag: WalkthroughTag): string; // 'walkthrough · narrate' | 'walkthrough · ask · step 3' | 'walkthrough · ask'
  export interface NarrateStepLine { id: string; ordinal: number; paths: string[]; firstLine: string }
  export function buildNarrateText(steps: NarrateStepLine[]): string;
  export interface AskContext { step: string; ordinal: number; paths: string[]; calls: Array<{ tool: string; input: unknown }> }
  export function buildAskText(question: string, ctx: AskContext): string;
  export const ASK_CONTEXT_MAX_CHARS = 12_000;
  ```
- `splitUserText` (existing) now returns `command.name` set to `walkthroughChipName(tag)` when the text carries the tag.

- [ ] **Step 1: Write the failing tests for the tag module**

`server/test/walkthroughTag.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  ASK_CONTEXT_MAX_CHARS,
  buildAskText,
  buildNarrateText,
  parseWalkthroughTag,
  walkthroughChipName,
  WALKTHROUGH_TAG,
} from '../src/walkthrough/tag.js';

describe('parseWalkthroughTag', () => {
  it('returns null for text without the tag', () => {
    expect(parseWalkthroughTag('plain question')).toBeNull();
    expect(parseWalkthroughTag('<command-name>/x</command-name>')).toBeNull();
  });

  it('reads a narrate tag', () => {
    expect(parseWalkthroughTag(`<${WALKTHROUGH_TAG} kind="narrate">\nsteps\n</${WALKTHROUGH_TAG}>`))
      .toEqual({ kind: 'narrate' });
  });

  it('reads an ask tag with step and ordinal', () => {
    const text = `Why?\n<${WALKTHROUGH_TAG} kind="ask" step="toolu_1" n="3">ctx</${WALKTHROUGH_TAG}>`;
    expect(parseWalkthroughTag(text)).toEqual({ kind: 'ask', step: 'toolu_1', n: 3 });
  });

  it('tolerates a missing or malformed n', () => {
    expect(parseWalkthroughTag(`<${WALKTHROUGH_TAG} kind="ask" step="toolu_1">x</${WALKTHROUGH_TAG}>`))
      .toEqual({ kind: 'ask', step: 'toolu_1', n: null });
    expect(parseWalkthroughTag(`<${WALKTHROUGH_TAG} kind="ask" step="toolu_1" n="x">x</${WALKTHROUGH_TAG}>`))
      .toEqual({ kind: 'ask', step: 'toolu_1', n: null });
  });

  it('rejects an ask without a step and an unknown kind', () => {
    expect(parseWalkthroughTag(`<${WALKTHROUGH_TAG} kind="ask">x</${WALKTHROUGH_TAG}>`)).toBeNull();
    expect(parseWalkthroughTag(`<${WALKTHROUGH_TAG} kind="other">x</${WALKTHROUGH_TAG}>`)).toBeNull();
  });
});

describe('walkthroughChipName', () => {
  it('names each kind', () => {
    expect(walkthroughChipName({ kind: 'narrate' })).toBe('walkthrough · narrate');
    expect(walkthroughChipName({ kind: 'ask', step: 's', n: 3 })).toBe('walkthrough · ask · step 3');
    expect(walkthroughChipName({ kind: 'ask', step: 's', n: null })).toBe('walkthrough · ask');
  });
});

describe('buildNarrateText', () => {
  it('wraps the step list in a narrate tag and asks for one JSON block', () => {
    const text = buildNarrateText([
      { id: 'toolu_1', ordinal: 1, paths: ['src/a.ts'], firstLine: 'Add a margin' },
      { id: 'toolu_2', ordinal: 2, paths: ['src/b.ts', 'src/c.ts'], firstLine: '' },
    ]);
    expect(parseWalkthroughTag(text)).toEqual({ kind: 'narrate' });
    expect(text).toContain('toolu_1');
    expect(text).toContain('src/b.ts, src/c.ts');
    expect(text).toContain('"intents"');
    // Nothing outside the tag: the chip is the whole turn.
    expect(text.trim().startsWith(`<${WALKTHROUGH_TAG}`)).toBe(true);
    expect(text.trim().endsWith(`</${WALKTHROUGH_TAG}>`)).toBe(true);
  });
});

describe('buildAskText', () => {
  const ctx = {
    step: 'toolu_1', ordinal: 2, paths: ['src/a.ts'],
    calls: [{ tool: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }],
  };

  it('puts the question outside the tag and the context inside it', () => {
    const text = buildAskText('Why the margin?', ctx);
    expect(text.startsWith('Why the margin?')).toBe(true);
    expect(parseWalkthroughTag(text)).toEqual({ kind: 'ask', step: 'toolu_1', n: 2 });
    expect(text).toContain('"old_string": "a"');
  });

  it('caps the context at ASK_CONTEXT_MAX_CHARS and says so', () => {
    const big = { ...ctx, calls: [{ tool: 'Write', input: { file_path: 'x', content: 'y'.repeat(ASK_CONTEXT_MAX_CHARS * 2) } }] };
    const text = buildAskText('q', big);
    const inner = text.slice(text.indexOf('>') + 1, text.lastIndexOf('</'));
    expect(inner.length).toBeLessThanOrEqual(ASK_CONTEXT_MAX_CHARS + 200);
    expect(inner).toContain('truncated');
  });
});
```

Add to `server/test/parser.test.ts`, inside `describe('splitUserText')`:

```ts
  it('names a walkthrough turn by its tag', () => {
    const narrate = '<orbital-walkthrough kind="narrate">\n- toolu_1\n</orbital-walkthrough>';
    expect(splitUserText(narrate)).toEqual({
      text: '',
      command: { name: 'walkthrough · narrate', body: narrate, blocks: 1 },
    });
    const ask = 'Why?\n<orbital-walkthrough kind="ask" step="toolu_1" n="3">ctx</orbital-walkthrough>';
    const split = splitUserText(ask);
    expect(split.text).toBe('Why?');
    expect(split.command?.name).toBe('walkthrough · ask · step 3');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/walkthroughTag.test.ts test/parser.test.ts`
Expected: FAIL — module `../src/walkthrough/tag.js` not found; the parser test fails on `command.name` being `null`.

- [ ] **Step 3: Write the tag module**

`server/src/walkthrough/tag.ts`:

```ts
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
  const lines = steps.map(
    (s) => `- step ${s.ordinal} · id ${s.id} · ${s.paths.join(', ')}${s.firstLine ? ` · "${s.firstLine}"` : ''}`,
  );
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
  let body = ctx.calls
    .map((c) => `${c.tool}:\n${JSON.stringify(c.input, null, 2)}`)
    .join('\n\n');
  if (body.length > ASK_CONTEXT_MAX_CHARS) {
    body = `${body.slice(0, ASK_CONTEXT_MAX_CHARS)}\n… (truncated by Orbital)`;
  }
  return [
    question.trim(),
    '',
    `<${WALKTHROUGH_TAG} kind="ask" step="${ctx.step}" n="${ctx.ordinal}">`,
    `The question above is about step ${ctx.ordinal} of the walkthrough of this session — the change to ${ctx.paths.join(', ')}.`,
    'The calls that made the change, as recorded:',
    '',
    body,
    `</${WALKTHROUGH_TAG}>`,
  ].join('\n');
}
```

- [ ] **Step 4: Teach the parser the tag**

In `server/src/transcript/parser.ts`:

1. Add the import at the top: `import { parseWalkthroughTag, walkthroughChipName } from '../walkthrough/tag.js';`
2. Add `orbital-walkthrough` to the alternation in `NOISE_BLOCK`:
   ```ts
   const NOISE_BLOCK = /<(local-command-caveat|local-command-stdout|local-command-stderr|system-reminder|command-message|command-name|command-args|command-contents|task-notification|orbital-walkthrough)>[\s\S]*?(<\/\1>|$)/g;
   ```
   **Careful:** the existing regex matches the tag name followed immediately by `>`. Our tag has attributes. Change the opening to allow attributes: `<(local-command-caveat|…|orbital-walkthrough)(?:\s[^>]*)?>`. Check the existing tests in `parser.test.ts` still pass — the closing-tag backreference `\1` stays valid because the group still captures only the name.
3. In `splitUserText`, after computing `name` from `<command-name>`, fall back to the walkthrough tag:
   ```ts
   const tag = name === null ? parseWalkthroughTag(text) : null;
   const chipName = name ?? (tag ? walkthroughChipName(tag) : null);
   return {
     text: text.replace(NOISE_BLOCK, '').trim(),
     command: { name: chipName, body: matches.map((m) => m[0]).join('\n'), blocks: matches.length },
   };
   ```

Also check `web/src/panels/MessageView.tsx` line ~163: `commandLineCount` strips a hard-coded tag list before counting lines. Add `orbital-walkthrough(?:\s[^>]*)?` to that regex so the chip's line count does not count the tag lines. (Web file — no semicolons.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/walkthroughTag.test.ts test/parser.test.ts`
Expected: PASS, including every pre-existing `splitUserText` and `NOISE_BLOCK` case.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck -w server && npm run test:run -w web -- transcript`
Expected: clean; the transcript tests still pass.

```bash
git add server/src/walkthrough/tag.ts server/src/transcript/parser.ts server/test/walkthroughTag.test.ts server/test/parser.test.ts web/src/panels/MessageView.tsx
git commit -m "feat(server/walkthrough): the orbital-walkthrough tag, its builders, and the transcript chip"
```

---

### Task 2: The spine — steps, gaps, fate, files, durations

**Files:**
- Create: `server/src/walkthrough/types.ts`, `server/src/walkthrough/spine.ts`
- Test: `server/test/walkthroughSpine.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` from `server/src/types.ts`; `SUBAGENT_TOOLS` from `server/src/transcript/subagents.ts`.
- Produces (`types.ts`, mirrored field-for-field into `web/src/lib/types.ts` in Task 6):
  ```ts
  export type FateKind = 'revised' | 'reverted';
  export interface StepCall { call: ChatMessage; result: ChatMessage | null }
  export interface StepFate { kind: FateKind; byStep: string; path: string }
  export interface StepQuestion { question: string; answer: string | null; messageId: string }
  export interface Step {
    id: string; ordinal: number; narration: string; calls: StepCall[];
    folded: Record<string, number>;
    subagent: { name: string; prompt: string; steps: Step[] } | null;
    fate: StepFate[]; questions: StepQuestion[]; durationMs: number | null;
  }
  export interface Gap { kind: 'gap'; durationMs: number | null; folded: Record<string, number>; subagents: string[]; said: string }
  export type TimelineEntry = { kind: 'step'; id: string } | Gap;
  export interface FileSummary { path: string; steps: string[]; created: boolean; fate: FateKind | null; notApplied: boolean }
  export interface NarrationIntent { title: string; summary: string; steps: string[]; considered: string[]; abandoned: boolean }
  export interface Narration { intents: NarrationIntent[]; /** steps added after the narrate turn */ staleSteps: number }
  export interface Walkthrough {
    steps: Step[]; timeline: TimelineEntry[]; files: FileSummary[];
    narration: Narration | null; narrationFailed: boolean; lastMessageId: string | null;
  }
  ```
- Produces (`spine.ts`):
  ```ts
  export const WRITING_TOOLS: ReadonlySet<string>;   // Edit, Write, NotebookEdit
  export function buildWalkthrough(messages: ChatMessage[], subagents: Map<string, ChatMessage[]>): Walkthrough;
  export function isWritingCall(m: ChatMessage, subagents: Map<string, ChatMessage[]>): boolean;
  ```
  This task leaves `narration: null`, `narrationFailed: false`, and every `questions: []`. Task 3 fills them in.

- [ ] **Step 1: Write the failing tests**

`server/test/walkthroughSpine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../src/types.js';
import { buildWalkthrough } from '../src/walkthrough/spine.js';

let seq = 0;
const ts = (s: number) => new Date(Date.UTC(2026, 8, 9, 14, 0, s)).toISOString();
const user = (text: string, s = seq++): ChatMessage => ({ id: `u${s}:0`, role: 'user', text, timestamp: ts(s) });
const say = (text: string, s = seq++): ChatMessage => ({ id: `a${s}:0`, role: 'assistant', text, timestamp: ts(s) });
const call = (toolName: string, toolInput: unknown, id: string, s = seq++): ChatMessage =>
  ({ id: `a${s}:1`, role: 'tool_use', toolName, toolInput, toolUseId: id, timestamp: ts(s) });
const result = (id: string, text = 'ok', isError = false, s = seq++): ChatMessage =>
  ({ id: `r${s}:0`, role: 'tool_result', toolUseId: id, text, timestamp: ts(s), ...(isError ? { isError: true } : {}) });
const edit = (path: string, from: string, to: string, id: string) =>
  [call('Edit', { file_path: path, old_string: from, new_string: to }, id), result(id)];
const read = (path: string, id: string) => [call('Read', { file_path: path }, id), result(id, 'contents')];

const none = new Map<string, ChatMessage[]>();

describe('buildWalkthrough — steps and gaps', () => {
  it('a run with a write is a step whose narration is the text before it', () => {
    const w = buildWalkthrough([
      user('fix it'), say('Reading first.'), ...read('a.ts', 'r1'),
      say('Adding the margin.'), ...edit('a.ts', 'x', 'y', 'e1'),
    ], none);
    expect(w.steps).toHaveLength(1);
    expect(w.steps[0]).toMatchObject({ id: 'e1', ordinal: 1, narration: 'Adding the margin.' });
    expect(w.steps[0].calls).toHaveLength(1);
    expect(w.steps[0].calls[0].result?.toolUseId).toBe('e1');
  });

  it('reads and searches before the step become a gap; the step\'s own reads fold into it', () => {
    const w = buildWalkthrough([
      user('go'), say('Looking.'), ...read('a.ts', 'r1'), ...read('b.ts', 'r2'),
      say('Now the change.'), ...read('c.ts', 'r3'), ...edit('a.ts', 'x', 'y', 'e1'),
    ], none);
    expect(w.timeline[0]).toMatchObject({ kind: 'gap', folded: { Read: 2 }, said: 'Looking.' });
    expect(w.timeline[1]).toEqual({ kind: 'step', id: 'e1' });
    expect(w.steps[0].folded).toEqual({ Read: 1 });
  });

  it('a run straight after the user turn has empty narration', () => {
    const w = buildWalkthrough([user('edit a.ts'), ...edit('a.ts', 'x', 'y', 'e1')], none);
    expect(w.steps[0].narration).toBe('');
  });

  it('two writes in one run are one step with two calls', () => {
    const w = buildWalkthrough([
      user('go'), say('Both files.'), ...edit('a.ts', 'x', 'y', 'e1'), ...edit('b.ts', 'p', 'q', 'e2'),
    ], none);
    expect(w.steps).toHaveLength(1);
    expect(w.steps[0].calls.map((c) => c.call.toolUseId)).toEqual(['e1', 'e2']);
  });

  it('step ids are stable when messages are appended', () => {
    const base = [user('go'), say('One.'), ...edit('a.ts', 'x', 'y', 'e1')];
    const before = buildWalkthrough(base, none);
    const after = buildWalkthrough([...base, say('Two.'), ...edit('b.ts', 'p', 'q', 'e2')], none);
    expect(after.steps[0].id).toBe(before.steps[0].id);
    expect(after.steps[1]).toMatchObject({ id: 'e2', ordinal: 2 });
  });

  it('a session with no writes has no steps and one gap', () => {
    const w = buildWalkthrough([user('look'), say('Reading.'), ...read('a.ts', 'r1')], none);
    expect(w.steps).toEqual([]);
    expect(w.timeline).toHaveLength(1);
    expect(w.files).toEqual([]);
  });

  it('durations come from timestamps and are null without them', () => {
    const w = buildWalkthrough([
      user('go'), say('x'), call('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' }, 'e1', 10), result('e1', 'ok', false, 14),
    ], none);
    expect(w.steps[0].durationMs).toBe(4000);
    const bare: ChatMessage[] = [
      { id: 'u:0', role: 'user', text: 'go' },
      { id: 'a:1', role: 'tool_use', toolName: 'Edit', toolInput: { file_path: 'a', old_string: 'x', new_string: 'y' }, toolUseId: 'e1' },
      { id: 'r:0', role: 'tool_result', toolUseId: 'e1', text: 'ok' },
    ];
    expect(buildWalkthrough(bare, none).steps[0].durationMs).toBeNull();
  });

  it('lastMessageId is the last message seen', () => {
    const msgs = [user('go'), ...edit('a.ts', 'x', 'y', 'e1')];
    expect(buildWalkthrough(msgs, none).lastMessageId).toBe(msgs[msgs.length - 1].id);
    expect(buildWalkthrough([], none).lastMessageId).toBeNull();
  });
});

describe('buildWalkthrough — fate', () => {
  it('a later edit whose old_string contains this new_string marks revised, both ways', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'const skew = 0;', 'const skew = 30_000;', 'e1'),
      say('2'), ...edit('a.ts', 'const skew = 30_000;', 'const skew = config.skew;', 'e2'),
    ], none);
    expect(w.steps[0].fate).toEqual([{ kind: 'revised', byStep: 'e2', path: 'a.ts' }]);
    expect(w.steps[1].fate).toEqual([]);
  });

  it('a later edit whose new_string equals this old_string marks reverted', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'A', 'B', 'e1'),
      say('2'), ...edit('a.ts', 'B', 'A', 'e2'),
    ], none);
    expect(w.steps[0].fate).toEqual([{ kind: 'reverted', byStep: 'e2', path: 'a.ts' }]);
  });

  it('a Write over a path an earlier step wrote is revised; identical content to the replaced text is reverted', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'A', 'B', 'e1'),
      say('2'), call('Write', { file_path: 'a.ts', content: 'A' }, 'w1'), result('w1', 'The file a.ts has been updated.'),
      say('3'), ...edit('b.ts', 'p', 'q', 'e3'),
      say('4'), call('Write', { file_path: 'b.ts', content: 'zzz' }, 'w2'), result('w2', 'The file b.ts has been updated.'),
    ], none);
    expect(w.steps[0].fate).toEqual([{ kind: 'reverted', byStep: 'w1', path: 'a.ts' }]);
    expect(w.steps[2].fate).toEqual([{ kind: 'revised', byStep: 'w2', path: 'b.ts' }]);
  });

  it('does not compare a step with itself or with an edit on another path', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'A', 'A', 'e1'), ...edit('a.ts', 'A', 'A', 'e2'),
      say('2'), ...edit('b.ts', 'A', 'B', 'e3'),
    ], none);
    expect(w.steps[0].fate).toEqual([]);
    expect(w.steps[1].fate).toEqual([]);
  });
});

describe('buildWalkthrough — files', () => {
  it('lists every path with its steps, creation, fate and failure', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), call('Write', { file_path: 'new.ts', content: 'x' }, 'w1'), result('w1', 'File created successfully at: new.ts'),
      say('2'), ...edit('a.ts', 'A', 'B', 'e1'),
      say('3'), ...edit('a.ts', 'B', 'A', 'e2'),
      say('4'), call('Edit', { file_path: 'cfg.json', old_string: 'q', new_string: 'r' }, 'e3'), result('e3', 'old_string not found', true),
    ], none);
    expect(w.files).toEqual([
      { path: 'new.ts', steps: ['w1'], created: true, fate: null, notApplied: false },
      { path: 'a.ts', steps: ['e1', 'e2'], created: false, fate: 'reverted', notApplied: false },
      { path: 'cfg.json', steps: ['e3'], created: false, fate: null, notApplied: true },
    ]);
  });
});

describe('buildWalkthrough — subagents', () => {
  const agentMsgs = (id: string): ChatMessage[] => [
    { id: `${id}-u:0`, role: 'user', text: 'do it', timestamp: ts(1) },
    { id: `${id}-a:0`, role: 'assistant', text: 'Fixing restore().', timestamp: ts(2) },
    { id: `${id}-a:1`, role: 'tool_use', toolName: 'Edit', toolInput: { file_path: 's.ts', old_string: 'x', new_string: 'y' }, toolUseId: `${id}-e1`, timestamp: ts(3) },
    { id: `${id}-r:0`, role: 'tool_result', toolUseId: `${id}-e1`, text: 'ok', timestamp: ts(4) },
  ];

  it('a dispatch whose transcript wrote is a step with sub-steps', () => {
    const subs = new Map([['ag1', agentMsgs('ag1')]]);
    const w = buildWalkthrough([
      user('go'), say('Dispatching.'),
      call('Agent', { description: 'callers', prompt: 'Update every caller', subagent_type: 'general-purpose' }, 'ag1'),
      result('ag1', 'done'),
    ], subs);
    expect(w.steps).toHaveLength(1);
    expect(w.steps[0].id).toBe('ag1');
    expect(w.steps[0].subagent).toMatchObject({ name: 'callers', prompt: 'Update every caller' });
    expect(w.steps[0].subagent?.steps[0]).toMatchObject({ id: 'ag1-e1', narration: 'Fixing restore().' });
    expect(w.files).toEqual([{ path: 's.ts', steps: ['ag1'], created: false, fate: null, notApplied: false }]);
  });

  it('a dispatch that wrote nothing is a gap fact, by description', () => {
    const subs = new Map([['ag1', agentMsgs('ag1').slice(0, 2)]]);
    const w = buildWalkthrough([
      user('go'), say('Surveying.'),
      call('Agent', { description: 'survey callers', prompt: 'p', subagent_type: 'x' }, 'ag1'), result('ag1', 'done'),
      say('Now.'), ...edit('a.ts', 'x', 'y', 'e1'),
    ], subs);
    expect(w.steps).toHaveLength(1);
    expect(w.timeline[0]).toMatchObject({ kind: 'gap', subagents: ['survey callers'], folded: {} });
  });

  it('a dispatch with no transcript on disk is a gap fact too', () => {
    const w = buildWalkthrough([
      user('go'), call('Agent', { description: 'd', prompt: 'p' }, 'ag1'), result('ag1', 'done'),
    ], none);
    expect(w.steps).toEqual([]);
    expect(w.timeline[0]).toMatchObject({ kind: 'gap', subagents: ['d'] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/walkthroughSpine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the types**

`server/src/walkthrough/types.ts` — exactly the interfaces in **Interfaces** above, each with a one-line doc comment taken from the spec (§ The spine). Add at the top:

```ts
/**
 * The walkthrough's wire shape (spec: 2026-09-23-walkthrough-design § The
 * spine). Mirrored field-for-field in `web/src/lib/types.ts`.
 */
import type { ChatMessage } from '../types.js';
```

- [ ] **Step 4: Write the spine**

`server/src/walkthrough/spine.ts`:

```ts
import type { ChatMessage } from '../types.js';
import { SUBAGENT_TOOLS } from '../transcript/subagents.js';
import type { FileSummary, Gap, Step, StepCall, StepFate, TimelineEntry, Walkthrough } from './types.js';

/** Tools whose call is a change to a file. Mirrors `EDITING_TOOLS` in `web/src/lib/fileEdit.ts`. */
export const WRITING_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit']);

/** The `Write` tool's creation sentence, as the CLI writes it (mirrors `writeOutcome` on the web). */
const WRITE_CREATED = /^File created successfully at:/;

type Segment =
  | { kind: 'user'; message: ChatMessage }
  | { kind: 'text'; message: ChatMessage }
  | { kind: 'run'; calls: StepCall[] };

/**
 * Pass 1: the transcript as user turns, assistant texts and runs — a run being
 * a maximal sequence of tool_use/tool_result messages with no assistant text
 * between them (spec § Vocabulary). Results are joined to their call by
 * `toolUseId`; a result whose call is not in the open run is dropped.
 */
function segment(messages: ChatMessage[]): Segment[] {
  const out: Segment[] = [];
  let run: StepCall[] | null = null;
  const close = () => { if (run) { out.push({ kind: 'run', calls: run }); run = null; } };
  for (const m of messages) {
    if (m.role === 'tool_use') {
      run ??= [];
      run.push({ call: m, result: null });
    } else if (m.role === 'tool_result') {
      const owner = run?.find((c) => c.call.toolUseId === m.toolUseId && c.result === null);
      if (owner) owner.result = m;
    } else if (m.role === 'assistant') {
      close();
      if (m.text?.trim()) out.push({ kind: 'text', message: m });
    } else if (m.role === 'user') {
      close();
      out.push({ kind: 'user', message: m });
    }
    // `notice` rows are the CLI talking to itself; not part of the story.
  }
  close();
  return out;
}

function inputString(input: unknown, key: string): string | null {
  if (!input || typeof input !== 'object') return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

function pathOf(call: ChatMessage): string | null {
  return inputString(call.toolInput, 'file_path') ?? inputString(call.toolInput, 'notebook_path');
}

export function isWritingCall(m: ChatMessage, subagents: Map<string, ChatMessage[]>): boolean {
  if (!m.toolName) return false;
  if (WRITING_TOOLS.has(m.toolName)) return true;
  if (SUBAGENT_TOOLS.has(m.toolName) && m.toolUseId) {
    const own = subagents.get(m.toolUseId);
    return !!own && own.some((x) => x.role === 'tool_use' && !!x.toolName && WRITING_TOOLS.has(x.toolName));
  }
  return false;
}

function millis(ts: string | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function spanMs(calls: StepCall[]): number | null {
  const first = millis(calls[0]?.call.timestamp);
  const lastCall = calls[calls.length - 1];
  const last = millis(lastCall?.result?.timestamp) ?? millis(lastCall?.call.timestamp);
  return first !== null && last !== null ? Math.max(0, last - first) : null;
}

function emptyGap(): Gap {
  return { kind: 'gap', durationMs: null, folded: {}, subagents: [], said: '' };
}

function gapIsEmpty(g: Gap): boolean {
  return Object.keys(g.folded).length === 0 && g.subagents.length === 0 && g.said === '';
}

function subagentName(call: ChatMessage): string {
  return inputString(call.toolInput, 'description') ?? inputString(call.toolInput, 'prompt')?.split('\n')[0] ?? 'subagent';
}

/**
 * Pass 2: runs with a writing call become steps; everything else between two
 * steps accumulates into one gap. The assistant text immediately before a
 * step is its narration and is NOT also said in the gap.
 */
function walk(segments: Segment[], subagents: Map<string, ChatMessage[]>): { steps: Step[]; timeline: TimelineEntry[] } {
  const steps: Step[] = [];
  const timeline: TimelineEntry[] = [];
  let gap = emptyGap();
  let gapStart: number | null = null;
  let gapEnd: number | null = null;
  const flushGap = () => {
    if (!gapIsEmpty(gap)) {
      gap.durationMs = gapStart !== null && gapEnd !== null ? Math.max(0, gapEnd - gapStart) : null;
      timeline.push(gap);
    }
    gap = emptyGap();
    gapStart = gapEnd = null;
  };
  const touch = (ts: string | undefined) => {
    const t = millis(ts);
    if (t === null) return;
    gapStart = gapStart === null ? t : Math.min(gapStart, t);
    gapEnd = gapEnd === null ? t : Math.max(gapEnd, t);
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === 'user') continue;
    if (seg.kind === 'text') {
      const next = segments[i + 1];
      const opensStep = next?.kind === 'run' && next.calls.some((c) => isWritingCall(c.call, subagents));
      if (!opensStep) {
        gap.said = gap.said ? `${gap.said}\n\n${seg.message.text!.trim()}` : seg.message.text!.trim();
        touch(seg.message.timestamp);
      }
      continue;
    }
    const writes = seg.calls.filter((c) => isWritingCall(c.call, subagents));
    if (writes.length === 0) {
      for (const c of seg.calls) {
        if (c.call.toolName && SUBAGENT_TOOLS.has(c.call.toolName)) gap.subagents.push(subagentName(c.call));
        else if (c.call.toolName) gap.folded[c.call.toolName] = (gap.folded[c.call.toolName] ?? 0) + 1;
        touch(c.call.timestamp); touch(c.result?.timestamp);
      }
      continue;
    }
    flushGap();
    const prev = segments[i - 1];
    const narration = prev?.kind === 'text' ? prev.message.text!.trim() : '';
    const first = writes[0].call;
    const folded: Record<string, number> = {};
    for (const c of seg.calls) {
      if (isWritingCall(c.call, subagents)) continue;
      if (c.call.toolName) folded[c.call.toolName] = (folded[c.call.toolName] ?? 0) + 1;
    }
    let subagent: Step['subagent'] = null;
    if (first.toolName && SUBAGENT_TOOLS.has(first.toolName) && first.toolUseId) {
      const own = buildWalkthrough(subagents.get(first.toolUseId) ?? [], new Map());
      // The agent's own reads fold into this step, not into the parent's gap.
      for (const entry of own.timeline) {
        if (entry.kind !== 'gap') continue;
        for (const [tool, n] of Object.entries(entry.folded)) folded[tool] = (folded[tool] ?? 0) + n;
      }
      subagent = { name: subagentName(first), prompt: inputString(first.toolInput, 'prompt') ?? '', steps: own.steps };
    }
    const step: Step = {
      id: first.toolUseId ?? first.id,
      ordinal: steps.length + 1,
      narration,
      calls: writes,
      folded,
      subagent,
      fate: [],
      questions: [],
      durationMs: spanMs(seg.calls),
    };
    steps.push(step);
    timeline.push({ kind: 'step', id: step.id });
  }
  flushGap();
  return { steps, timeline };
}

/** Every file-writing call a step made, sub-steps included, attributed to the TOP-LEVEL step. */
function writesOf(step: Step): Array<{ call: StepCall; step: Step }> {
  if (step.subagent) {
    return step.subagent.steps.flatMap((s) => s.calls.map((call) => ({ call, step })));
  }
  return step.calls.map((call) => ({ call, step }));
}

/**
 * Blind alleys (spec § Blind alleys): what later steps did to this step's
 * work on the same path. Only Edit and Write are compared; a step never
 * compares with itself; a match is recorded once per later step and path.
 */
function assignFate(steps: Step[]): void {
  const all = steps.flatMap(writesOf);
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    const path = pathOf(a.call.call);
    if (!path) continue;
    const aOld = inputString(a.call.call.toolInput, 'old_string');
    const aNew = a.call.call.toolName === 'Write'
      ? inputString(a.call.call.toolInput, 'content')
      : inputString(a.call.call.toolInput, 'new_string');
    if (aNew === null) continue;
    const seen = new Set<string>();
    for (let j = i + 1; j < all.length; j++) {
      const b = all[j];
      if (b.step === a.step || pathOf(b.call.call) !== path || seen.has(b.step.id)) continue;
      let kind: StepFate['kind'] | null = null;
      if (b.call.call.toolName === 'Edit') {
        const bOld = inputString(b.call.call.toolInput, 'old_string') ?? '';
        const bNew = inputString(b.call.call.toolInput, 'new_string') ?? '';
        if (aOld !== null && aOld !== '' && bNew === aOld && bOld === aNew) kind = 'reverted';
        else if (aOld !== null && aOld !== '' && bNew === aOld) kind = 'reverted';
        else if (aNew !== '' && (bOld.includes(aNew) || aNew.includes(bOld)) && bOld !== '') kind = 'revised';
      } else if (b.call.call.toolName === 'Write') {
        const content = inputString(b.call.call.toolInput, 'content') ?? '';
        kind = aOld !== null && aOld !== '' && content === aOld ? 'reverted' : 'revised';
      }
      if (!kind) continue;
      seen.add(b.step.id);
      a.step.fate.push({ kind, byStep: b.step.id, path });
    }
  }
}

function summarizeFiles(steps: Step[]): FileSummary[] {
  const byPath = new Map<string, FileSummary>();
  for (const { call, step } of steps.flatMap(writesOf)) {
    const path = pathOf(call.call);
    if (!path) continue;
    let f = byPath.get(path);
    if (!f) {
      f = { path, steps: [], created: false, fate: null, notApplied: false };
      byPath.set(path, f);
      if (call.call.toolName === 'Write' && call.result?.text && WRITE_CREATED.test(call.result.text)) f.created = true;
    }
    if (!f.steps.includes(step.id)) f.steps.push(step.id);
    if (call.result?.isError) f.notApplied = true;
  }
  // The LAST fate on the path — what the close screen gathers.
  for (const step of steps) {
    for (const fate of step.fate) {
      const f = byPath.get(fate.path);
      if (f) f.fate = fate.kind;
    }
  }
  return [...byPath.values()];
}

export function buildWalkthrough(messages: ChatMessage[], subagents: Map<string, ChatMessage[]>): Walkthrough {
  const { steps, timeline } = walk(segment(messages), subagents);
  assignFate(steps);
  return {
    steps,
    timeline,
    files: summarizeFiles(steps),
    narration: null,
    narrationFailed: false,
    lastMessageId: messages.length ? messages[messages.length - 1].id : null,
  };
}
```

Note on `assignFate`'s two `reverted` branches: the first (both strings swapped) is the strict form; the second (only `bNew === aOld`) is what the spec states. Keep both — the strict one is redundant but documents the intent; if the reviewer prefers, collapse to the second.

- [ ] **Step 5: Run the tests**

Run: `cd server && npx vitest run test/walkthroughSpine.test.ts`
Expected: PASS. If the `files` ordering test fails on order, `Map` insertion order is transcript order — check `writesOf` iterates steps in order.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck -w server`

```bash
git add server/src/walkthrough/types.ts server/src/walkthrough/spine.ts server/test/walkthroughSpine.test.ts
git commit -m "feat(server/walkthrough): the spine — steps, gaps, fate, files"
```

---

### Task 3: Narration and questions read back from the transcript

**Files:**
- Create: `server/src/walkthrough/narration.ts`
- Modify: `server/src/walkthrough/spine.ts` (`buildWalkthrough`)
- Test: `server/test/walkthroughNarration.test.ts`, `server/test/walkthroughSpine.test.ts`

**Interfaces:**
- Consumes: `parseWalkthroughTag` (Task 1), `Walkthrough`/`Step` (Task 2).
- Produces:
  ```ts
  // narration.ts
  export function parseNarration(answer: string, knownStepIds: string[]): NarrationIntent[] | null;
  // spine.ts — buildWalkthrough now also fills narration, narrationFailed and each step's questions.
  ```

- [ ] **Step 1: Write the failing tests**

`server/test/walkthroughNarration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseNarration } from '../src/walkthrough/narration.js';

const known = ['e1', 'e2', 'e3'];
const fence = (json: string) => 'Here it is.\n```json\n' + json + '\n```\nDone.';

describe('parseNarration', () => {
  it('reads intents from the first fenced json block', () => {
    const out = parseNarration(fence('{"intents":[{"title":"T","summary":"S","steps":["e1","e2"],"considered":["x"],"abandoned":false}]}'), known);
    expect(out).toEqual([
      { title: 'T', summary: 'S', steps: ['e1', 'e2'], considered: ['x'], abandoned: false },
      { title: '', summary: '', steps: ['e3'], considered: [], abandoned: false },
    ]);
  });

  it('drops unknown step ids and fills in unnamed steps as their own intents, in order', () => {
    const out = parseNarration(fence('{"intents":[{"title":"T","summary":"S","steps":["e2","nope"]}]}'), known);
    expect(out?.map((i) => i.steps)).toEqual([['e1'], ['e2'], ['e3']]);
    expect(out?.[1].title).toBe('T');
  });

  it('a step named twice belongs to the first intent that names it', () => {
    const out = parseNarration(fence('{"intents":[{"title":"A","summary":"","steps":["e1"]},{"title":"B","summary":"","steps":["e1","e2"]}]}'), known);
    expect(out?.map((i) => i.steps)).toEqual([['e1'], ['e2'], ['e3']]);
  });

  it('returns null with no block, with malformed json, and with a block lacking intents', () => {
    expect(parseNarration('no block here', known)).toBeNull();
    expect(parseNarration(fence('{"intents": ['), known)).toBeNull();
    expect(parseNarration(fence('{"steps": []}'), known)).toBeNull();
    expect(parseNarration(fence('{"intents": "x"}'), known)).toBeNull();
  });

  it('accepts a bare ``` fence and coerces missing fields', () => {
    const out = parseNarration('```\n{"intents":[{"title":1,"steps":["e1"]}]}\n```', known);
    expect(out?.[0]).toEqual({ title: '', summary: '', steps: ['e1'], considered: [], abandoned: false });
  });
});
```

Add to `server/test/walkthroughSpine.test.ts` a new `describe('buildWalkthrough — narration and questions')` using the same helpers:

```ts
describe('buildWalkthrough — narration and questions', () => {
  const narrateTurn = (s = seq++): ChatMessage => ({
    id: `u${s}:0`, role: 'user', text: '', timestamp: ts(s),
    command: { name: 'walkthrough · narrate', body: '<orbital-walkthrough kind="narrate">x</orbital-walkthrough>', blocks: 1 },
  });
  const askTurn = (step: string, q: string, s = seq++): ChatMessage => ({
    id: `u${s}:0`, role: 'user', text: q, timestamp: ts(s),
    command: { name: 'walkthrough · ask · step 1', body: `<orbital-walkthrough kind="ask" step="${step}" n="1">ctx</orbital-walkthrough>`, blocks: 1 },
  });

  it('reads the last narration, counts steps added after it, and keeps its answer out of gaps and narrations', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      narrateTurn(), say('```json\n{"intents":[{"title":"T","summary":"S","steps":["e1"]}]}\n```'),
      user('more'), say('2'), ...edit('b.ts', 'p', 'q', 'e2'),
    ], none);
    expect(w.narration).toEqual({ intents: [{ title: 'T', summary: 'S', steps: ['e1'], considered: [], abandoned: false }, { title: '', summary: '', steps: ['e2'], considered: [], abandoned: false }], staleSteps: 1 });
    expect(w.narrationFailed).toBe(false);
    expect(w.steps[1].narration).toBe('2');
    expect(w.timeline.some((t) => t.kind === 'gap' && t.said.includes('intents'))).toBe(false);
  });

  it('a narration whose answer has no json block is a visible failure', () => {
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      narrateTurn(), say('I cannot do that right now.'),
    ], none);
    expect(w.narration).toBeNull();
    expect(w.narrationFailed).toBe(true);
  });

  it('a narrate turn with no answer yet is neither a narration nor a failure', () => {
    const w = buildWalkthrough([user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'), narrateTurn()], none);
    expect(w.narration).toBeNull();
    expect(w.narrationFailed).toBe(false);
  });

  it('attaches a question and its answer to the step the tag names', () => {
    const ask = askTurn('e1', 'Why?');
    const w = buildWalkthrough([
      user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'),
      ask, say('Because.'),
      askTurn('e1', 'Sure?'),
    ], none);
    expect(w.steps[0].questions).toEqual([
      { question: 'Why?', answer: 'Because.', messageId: ask.id },
      { question: 'Sure?', answer: null, messageId: expect.any(String) },
    ]);
  });

  it('a question about an unknown step is dropped', () => {
    const w = buildWalkthrough([user('go'), say('1'), ...edit('a.ts', 'x', 'y', 'e1'), askTurn('nope', 'Why?'), say('Because.')], none);
    expect(w.steps[0].questions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/walkthroughNarration.test.ts test/walkthroughSpine.test.ts`
Expected: FAIL — `narration.ts` missing; the spine cases fail on `narration: null` / `questions: []`.

- [ ] **Step 3: Write `narration.ts`**

```ts
import type { NarrationIntent } from './types.js';

const FENCE = /```(?:json)?\s*\n([\s\S]*?)\n```/;

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * The narrate turn's answer, read tolerantly (spec § Narration, "Reading it
 * back"): the first fenced block wins; unknown step ids are dropped; a step
 * the model did not name becomes its own intent with no summary, in
 * transcript order; a step named twice stays with the first intent. Null
 * means there was nothing parsable — which the page shows as a failure.
 */
export function parseNarration(answer: string, knownStepIds: string[]): NarrationIntent[] | null {
  const m = FENCE.exec(answer);
  if (!m) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(m[1]); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { intents?: unknown }).intents)) return null;
  const raw = (parsed as { intents: unknown[] }).intents;
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
```

- [ ] **Step 4: Read the tagged turns in the spine**

In `spine.ts`, add `import { parseWalkthroughTag } from './tag.js';` and `import { parseNarration } from './narration.js';`.

Change `segment()` so a `user` segment carries its tag, and so the assistant texts that answer a tagged turn are marked and never become narration or gap text:

```ts
type Segment =
  | { kind: 'user'; message: ChatMessage; tag: WalkthroughTag | null }
  | { kind: 'text'; message: ChatMessage; answers: boolean }
  | { kind: 'run'; calls: StepCall[] };
```

In the loop: on a `user` message, `tag = m.command ? parseWalkthroughTag(m.command.body) : null`; keep `let answering = tag !== null` in the closure; each subsequent `text` segment gets `answers: answering`; a following `run` or `user` clears `answering = false` (a tagged turn's answer is text only — if the model went on to use tools, the text after that is ordinary again).

In `walk()`: a `text` with `answers: true` is skipped entirely (not narration, not `said`), and `prev?.kind === 'text' && !prev.answers` is the narration test.

`walk()` also returns `stepSegment: Map<string, number>` — the segment index each step was built from (`stepSegment.set(step.id, i)` when the step is pushed). A helper collects a tagged turn's answer:

```ts
/** The assistant texts answering the tagged user turn at `i`, up to the next user turn. */
function answerAfter(segs: Segment[], i: number): string | null {
  const parts: string[] = [];
  for (let j = i + 1; j < segs.length; j++) {
    const s = segs[j];
    if (s.kind === 'user') break;
    if (s.kind === 'text' && s.answers) parts.push(s.message.text!.trim());
  }
  return parts.length ? parts.join('\n\n') : null;
}
```

and `buildWalkthrough` becomes:

```ts
export function buildWalkthrough(messages: ChatMessage[], subagents: Map<string, ChatMessage[]>): Walkthrough {
  const segs = segment(messages);
  const { steps, timeline, stepSegment } = walk(segs, subagents);
  assignFate(steps);
  const stepById = new Map(steps.map((s) => [s.id, s]));
  let narration: Walkthrough['narration'] = null;
  let narrationFailed = false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.kind !== 'user' || !seg.tag) continue;
    const answer = answerAfter(segs, i);
    if (seg.tag.kind === 'ask') {
      stepById.get(seg.tag.step)?.questions.push({ question: seg.message.text ?? '', answer, messageId: seg.message.id });
      continue;
    }
    // narrate — the LAST one wins, whatever became of the earlier ones
    if (answer === null) { narration = null; narrationFailed = false; continue; }
    const intents = parseNarration(answer, steps.map((s) => s.id));
    if (!intents) { narration = null; narrationFailed = true; continue; }
    const covered = steps.filter((s) => (stepSegment.get(s.id) ?? Infinity) < i).length;
    narration = { intents, staleSteps: steps.length - covered };
    narrationFailed = false;
  }
  return {
    steps, timeline, files: summarizeFiles(steps), narration, narrationFailed,
    lastMessageId: messages.length ? messages[messages.length - 1].id : null,
  };
}
```

- [ ] **Step 5: Run all three walkthrough test files**

Run: `cd server && npx vitest run test/walkthroughTag.test.ts test/walkthroughSpine.test.ts test/walkthroughNarration.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck -w server
git add server/src/walkthrough server/test/walkthroughNarration.test.ts server/test/walkthroughSpine.test.ts
git commit -m "feat(server/walkthrough): narration and questions are read back from the transcript"
```

---

### Task 4: Subagent transcripts, keyed by the call that dispatched them

**Files:**
- Create: `server/src/walkthrough/subagents.ts`
- Test: `server/test/walkthroughSubagents.test.ts`

**Interfaces:**
- Consumes: `parseTranscript`, `entriesToMessages` (`server/src/transcript/parser.ts`); the layout in `server/src/stats/transcript.ts` (`<session-id>/subagents/agent-<id>.jsonl` beside `agent-<id>.meta.json` with `toolUseId`).
- Produces:
  ```ts
  export function readSubagentMessages(transcriptPath: string, images?: ImageWriter): Map<string, ChatMessage[]>;
  ```
  Note `entriesToMessages` skips `isSidechain` entries — every line of an agent file is a sidechain entry, so the reader must clear that flag (or map with a variant). Do it by mapping `{ ...e, isSidechain: false }` before calling `entriesToMessages`; do not change the parser.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSubagentMessages } from '../src/walkthrough/subagents.js';

function sessionDir() {
  const root = mkdtempSync(join(tmpdir(), 'orbital-wt-'));
  const transcript = join(root, 'sess.jsonl');
  writeFileSync(transcript, '{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}\n');
  const agents = join(root, 'sess', 'subagents');
  mkdirSync(agents, { recursive: true });
  return { transcript, agents };
}

const line = (o: unknown) => JSON.stringify(o) + '\n';

describe('readSubagentMessages', () => {
  it('returns an empty map without a subagents directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'orbital-wt-'));
    const t = join(root, 'x.jsonl');
    writeFileSync(t, '');
    expect(readSubagentMessages(t).size).toBe(0);
  });

  it('keys each agent\'s messages by the meta file\'s toolUseId, sidechain flag cleared', () => {
    const { transcript, agents } = sessionDir();
    writeFileSync(join(agents, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'toolu_A', description: 'd' }));
    writeFileSync(join(agents, 'agent-a1.jsonl'),
      line({ type: 'user', uuid: 'x1', isSidechain: true, agentId: 'a1', message: { role: 'user', content: 'do it' } }) +
      line({ type: 'assistant', uuid: 'x2', isSidechain: true, agentId: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_E', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }] } }));
    const map = readSubagentMessages(transcript);
    expect([...map.keys()]).toEqual(['toolu_A']);
    expect(map.get('toolu_A')?.map((m) => m.role)).toEqual(['user', 'tool_use']);
  });

  it('skips an agent whose meta is missing, unreadable, or has no toolUseId', () => {
    const { transcript, agents } = sessionDir();
    writeFileSync(join(agents, 'agent-b1.jsonl'), line({ type: 'user', uuid: 'y', message: { role: 'user', content: 'x' } }));
    writeFileSync(join(agents, 'agent-b2.meta.json'), '{not json');
    writeFileSync(join(agents, 'agent-b2.jsonl'), '');
    writeFileSync(join(agents, 'agent-b3.meta.json'), JSON.stringify({ description: 'no id' }));
    writeFileSync(join(agents, 'agent-b3.jsonl'), '');
    expect(readSubagentMessages(transcript).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run test/walkthroughSubagents.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Write the reader**

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ChatMessage } from '../types.js';
import { entriesToMessages, parseTranscript, type ImageWriter } from '../transcript/parser.js';

const SUBAGENT_DIR = 'subagents';
const META_FILE = /^(agent-.*)\.meta\.json$/;

/**
 * Each dispatched subagent's messages, keyed by the `toolUseId` of the
 * `Agent` call that dispatched it — the join the walkthrough needs to make
 * an agent's writes a step in the parent's story (spec § The spine). The
 * layout is `docs/domains/subagents-in-transcripts.md`: beside the session
 * file, `<id>/subagents/agent-<x>.jsonl` with `agent-<x>.meta.json` naming
 * the `toolUseId`. An agent with no readable meta, or a meta with no
 * `toolUseId`, is not joinable and is skipped; an unreadable transcript costs
 * that agent only.
 */
export function readSubagentMessages(transcriptPath: string, images?: ImageWriter): Map<string, ChatMessage[]> {
  const dir = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), SUBAGENT_DIR);
  const out = new Map<string, ChatMessage[]>();
  let files: string[];
  try { files = readdirSync(dir); } catch { return out; }
  for (const file of files) {
    const m = META_FILE.exec(file);
    if (!m) continue;
    let toolUseId: string | null = null;
    try {
      const meta = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { toolUseId?: unknown };
      if (typeof meta.toolUseId === 'string' && meta.toolUseId) toolUseId = meta.toolUseId;
    } catch { continue; }
    if (!toolUseId) continue;
    try {
      const entries = parseTranscript(readFileSync(join(dir, `${m[1]}.jsonl`), 'utf8'))
        .map((e) => ({ ...e, isSidechain: false }));
      out.set(toolUseId, entriesToMessages(entries, images));
    } catch {
      // This agent's file is unreadable; the parent's story goes on without it.
    }
  }
  return out;
}
```

Check `ImageWriter` is exported from `parser.ts` (it is used in `entriesToMessages`'s signature; if it is not exported, export the type).

- [ ] **Step 4: Run, typecheck, commit**

```bash
cd server && npx vitest run test/walkthroughSubagents.test.ts && npm run typecheck
git add server/src/walkthrough/subagents.ts server/test/walkthroughSubagents.test.ts server/src/transcript/parser.ts
git commit -m "feat(server/walkthrough): subagent transcripts keyed by their dispatching call"
```

---

### Task 5: The routes — read, summary, narrate, ask

**Files:**
- Modify: `server/src/api/routes.ts` (the messages route at ~line 650 and a new block after it)
- Test: `server/test/routes.test.ts`

**Interfaces:**
- Consumes: `buildWalkthrough`, `readSubagentMessages`, `buildNarrateText`, `buildAskText`, `readTranscriptMessages` (existing closure in `routes.ts`), `toApiSession`.
- Produces:
  - `GET /api/sessions/:id/walkthrough` → `200 { session: ApiSession, walkthrough: Walkthrough }` | `404 { error: 'not found' }`
  - `GET /api/sessions/:id/walkthrough/summary` → `200 { steps: number, files: number, blindAlleys: number, subagents: number }` | `404`
  - `POST /api/sessions/:id/walkthrough/narrate` → `200 { ok: true, revived?: true }` | `404` | `409 { error: 'terminal_session' | 'busy' }` | `400 { error: 'no_steps' }`
  - `POST /api/sessions/:id/walkthrough/ask` body `{ step: string; question: string }` → `200 { ok: true, revived?: true }` | `400 { error: 'missing_question' | 'unknown_step' }` | `404` | `409` as above
  - Internal helper `deliverToSession(id, text): Promise<'sent' | 'revived' | 'not_found' | 'terminal'>` extracted from the messages route so that route, narrate and ask share one revival path.

- [ ] **Step 1: Write the failing route tests**

Append to `server/test/routes.test.ts` (the file's `makeApp` returns `{ app, db, hub, startCalls, sendCalls, … }` — read its return statement and use the same names). A fixture transcript is written into `projectsDir`:

```ts
describe('walkthrough routes', () => {
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  const transcript =
    line({ type: 'user', uuid: 'u1', timestamp: '2026-09-09T14:00:00.000Z', message: { role: 'user', content: 'add margin' } }) +
    line({ type: 'assistant', uuid: 'a1', timestamp: '2026-09-09T14:00:05.000Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Adding a margin.' }, { type: 'tool_use', id: 'toolu_E1', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' } }] } }) +
    line({ type: 'user', uuid: 'u2', timestamp: '2026-09-09T14:00:06.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_E1', content: 'ok' }] } });

  function appWithTranscript(source: 'web' | 'terminal' = 'web') {
    const projectsDir = mkdtempSync(join(tmpdir(), 'orbital-wt-routes-'));
    mkdirSync(join(projectsDir, 'p'), { recursive: true });
    writeFileSync(join(projectsDir, 'p', 'w1.jsonl'), transcript);
    const made = makeApp({ projectsDir });
    made.db.insert(sessions).values({ id: 'w1', projectDir: 'p', cwd: '/w/z', title: 'wt', lastAt: 300, source, permissionMode: 'acceptEdits' }).run();
    return made;
  }

  it('GET /walkthrough returns the spine with the session', async () => {
    const { app } = appWithTranscript();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/w1/walkthrough' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session.id).toBe('w1');
    expect(body.walkthrough.steps).toHaveLength(1);
    expect(body.walkthrough.steps[0]).toMatchObject({ id: 'toolu_E1', narration: 'Adding a margin.' });
  });

  it('GET /walkthrough 404s an unknown session and is empty for a row without a file', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nope/walkthrough' })).statusCode).toBe(404);
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/walkthrough' });
    expect(res.statusCode).toBe(200);
    expect(res.json().walkthrough.steps).toEqual([]);
  });

  it('GET /walkthrough/summary counts', async () => {
    const { app } = appWithTranscript();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/w1/walkthrough/summary' });
    expect(res.json()).toEqual({ steps: 1, files: 1, blindAlleys: 0, subagents: 0 });
  });

  it('POST narrate sends a tagged turn through the messages path', async () => {
    const { app, sendCalls, startCalls } = appWithTranscript();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/w1/walkthrough/narrate' });
    expect(res.statusCode).toBe(200);
    // The stub runner's send() throws "not active", so the route revives.
    expect(res.json()).toEqual({ ok: true, revived: true });
    expect(sendCalls[0].text).toContain('<orbital-walkthrough kind="narrate">');
    expect(sendCalls[0].text).toContain('toolu_E1');
    expect(startCalls[0]).toMatchObject({ resume: 'w1', cwd: '/w/z' });
  });

  it('POST narrate refuses a terminal session and a session with no steps', async () => {
    const { app } = appWithTranscript('terminal');
    const res = await app.inject({ method: 'POST', url: '/api/sessions/w1/walkthrough/narrate' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'terminal_session' });

    const { app: bare, db } = makeApp();
    db.insert(sessions).values({ id: 'w2', projectDir: 'p', cwd: '/w/z', title: 'empty', lastAt: 1, source: 'web', permissionMode: 'acceptEdits' }).run();
    const none = await bare.inject({ method: 'POST', url: '/api/sessions/w2/walkthrough/narrate' });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toEqual({ error: 'no_steps' });
  });

  it('POST ask validates, then sends the question with the step context', async () => {
    const { app, sendCalls } = appWithTranscript();
    expect((await app.inject({ method: 'POST', url: '/api/sessions/w1/walkthrough/ask', payload: { step: 'toolu_E1' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/w1/walkthrough/ask', payload: { step: 'nope', question: 'q' } })).json()).toEqual({ error: 'unknown_step' });
    const res = await app.inject({ method: 'POST', url: '/api/sessions/w1/walkthrough/ask', payload: { step: 'toolu_E1', question: 'Why the margin?' } });
    expect(res.statusCode).toBe(200);
    expect(sendCalls.at(-1).text.startsWith('Why the margin?')).toBe(true);
    expect(sendCalls.at(-1).text).toContain('kind="ask" step="toolu_E1" n="1"');
    expect(sendCalls.at(-1).text).toContain('"old_string": "x"');
  });

  it('POST ask refuses while the session is working', async () => {
    const { app, runner } = appWithTranscript();
    runner.status = () => 'working';
    const res = await app.inject({ method: 'POST', url: '/api/sessions/w1/walkthrough/ask', payload: { step: 'toolu_E1', question: 'q' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'busy' });
  });
});
```

Adjust the "no steps" case properly: insert `{ id: 'w2', projectDir: 'p', cwd: '/w/z', source: 'web', … }` with no transcript file and expect `400 { error: 'no_steps' }`. Make `makeApp` return `runner` if it does not already (check its return statement; add `runner` to it — it is a plain object, so tests can reassign `runner.status`). If `makeApp` does not return `db`, add it too.

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run test/routes.test.ts -t walkthrough` — Expected: FAIL with 404s (routes missing).

- [ ] **Step 3: Extract `deliverToSession` and add the routes**

In `routes.ts`, above the `POST /api/sessions/:id/messages` handler, add:

```ts
  /**
   * One delivery path for anything Orbital says INTO a session: the composer's
   * text, and the walkthrough's narrate and ask turns. Sends if the runner
   * holds the session; otherwise revives it by resuming — unless a terminal
   * owns it, which cannot be taken over.
   */
  async function deliverToSession(
    id: string, text: string, attachments?: string[],
  ): Promise<'sent' | 'revived' | 'not_found' | 'terminal'> {
    db.update(sessions).set({ mapDismissedAt: null }).where(eq(sessions.id, id)).run();
    try {
      ctx.runner.send(id, text, attachments);
      return 'sent';
    } catch {
      const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow | undefined;
      if (!row) return 'not_found';
      if (ctx.registry.get(id)) return 'terminal';
      const permissionMode = (row.permission_mode ?? ctx.settings.get('default_permission_mode')) as PermissionMode;
      await ctx.runner.start({ cwd: row.cwd, prompt: text, permissionMode, resume: id, model: row.model ?? undefined, attachments });
      db.update(sessions).set({ source: 'web' }).where(eq(sessions.id, id)).run();
      const revivedRow = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
      ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, revivedRow) });
      return 'revived';
    }
  }
```

Rewrite the body of `POST /api/sessions/:id/messages` to call it, keeping its exact responses (`404 not found`, `409 session is live in a terminal`, `{ ok: true }`, `{ ok: true, revived: true }`) and its attachment validation. Move the existing comments onto the helper. Run the whole `routes.test.ts` afterwards — the messages-route tests must be unchanged.

Then add, after the messages route:

```ts
  // ---- Walkthrough (spec: 2026-09-23-walkthrough-design) ----------------

  function walkthroughFor(id: string): { row: SessionRow; walkthrough: Walkthrough } | null {
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow | undefined;
    if (!row) return null;
    const messages = readTranscriptMessages(id) ?? [];
    const transcriptPath = join(ctx.projectsDir, row.project_dir, `${id}.jsonl`);
    const subagents = readSubagentMessages(transcriptPath, ctx.images);
    return { row, walkthrough: buildWalkthrough(messages, subagents) };
  }

  app.get('/api/sessions/:id/walkthrough', (req, reply) => {
    const { id } = req.params as { id: string };
    const found = walkthroughFor(id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    return { session: toApiSession(ctx, found.row), walkthrough: found.walkthrough };
  });

  /** The header's entry control asks this; it is the same parse, smaller answer. */
  app.get('/api/sessions/:id/walkthrough/summary', (req, reply) => {
    const { id } = req.params as { id: string };
    const found = walkthroughFor(id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    const w = found.walkthrough;
    return {
      steps: w.steps.length,
      files: w.files.length,
      blindAlleys: w.steps.filter((s) => s.fate.some((f) => f.kind === 'reverted')).length,
      subagents: w.steps.filter((s) => s.subagent !== null).length,
    };
  });

  /**
   * Both turn-sending routes refuse the same two things: a session Orbital did
   * not run (a terminal owns it, or the row says so), and a session mid-turn —
   * a question injected into a running turn is not the question it appears to
   * be (spec § Asking).
   */
  function refuseTurn(row: SessionRow, id: string): { code: number; error: string } | null {
    if (row.source === 'terminal' || ctx.registry.get(id)) return { code: 409, error: 'terminal_session' };
    const status = ctx.runner.status(id);
    if (status === 'working' || status === 'needs_input') return { code: 409, error: 'busy' };
    return null;
  }

  async function sendTurn(id: string, text: string, reply: FastifyReply) {
    const outcome = await deliverToSession(id, text);
    if (outcome === 'not_found') return reply.code(404).send({ error: 'not found' });
    if (outcome === 'terminal') return reply.code(409).send({ error: 'terminal_session' });
    return outcome === 'revived' ? { ok: true, revived: true } : { ok: true };
  }

  app.post('/api/sessions/:id/walkthrough/narrate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = walkthroughFor(id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    const refused = refuseTurn(found.row, id);
    if (refused) return reply.code(refused.code).send({ error: refused.error });
    if (found.walkthrough.steps.length === 0) return reply.code(400).send({ error: 'no_steps' });
    const text = buildNarrateText(found.walkthrough.steps.map((s) => ({
      id: s.id, ordinal: s.ordinal,
      paths: [...new Set(stepPaths(s))],
      firstLine: s.narration.split('\n')[0] ?? '',
    })));
    return sendTurn(id, text, reply);
  });

  app.post('/api/sessions/:id/walkthrough/ask', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { step?: unknown; question?: unknown };
    if (typeof body.question !== 'string' || !body.question.trim()) return reply.code(400).send({ error: 'missing_question' });
    const found = walkthroughFor(id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    const step = found.walkthrough.steps.find((s) => s.id === body.step);
    if (!step) return reply.code(400).send({ error: 'unknown_step' });
    const refused = refuseTurn(found.row, id);
    if (refused) return reply.code(refused.code).send({ error: refused.error });
    const text = buildAskText(body.question, {
      step: step.id, ordinal: step.ordinal, paths: [...new Set(stepPaths(step))],
      calls: stepCalls(step).map((c) => ({ tool: c.call.toolName ?? '', input: c.call.toolInput })),
    });
    return sendTurn(id, text, reply);
  });
```

with two tiny helpers next to them:

```ts
  /** A step's writing calls, a subagent step's sub-steps included. */
  function stepCalls(step: Step): StepCall[] {
    return step.subagent ? step.subagent.steps.flatMap(stepCalls) : step.calls;
  }
  function stepPaths(step: Step): string[] {
    return stepCalls(step)
      .map((c) => {
        const input = c.call.toolInput as Record<string, unknown> | null;
        const p = input?.file_path ?? input?.notebook_path;
        return typeof p === 'string' ? p : null;
      })
      .filter((p): p is string => p !== null);
  }
```

Imports to add at the top of `routes.ts`: `buildWalkthrough` from `../walkthrough/spine.js`, `readSubagentMessages` from `../walkthrough/subagents.js`, `buildAskText, buildNarrateText` from `../walkthrough/tag.js`, types `Step, StepCall, Walkthrough` from `../walkthrough/types.js`, `FastifyReply` from `fastify`. `ctx.runner.status(id)` exists on `Runner` (returns the status or `undefined`); the test stub's `status: () => undefined` already matches.

- [ ] **Step 4: Run the whole server suite**

Run: `npm test -w server` — Expected: PASS, including every pre-existing messages-route test.

- [ ] **Step 5: Typecheck, format, commit**

```bash
npm run typecheck -w server && npx prettier --write server/src/api/routes.ts server/test/routes.test.ts
git add server/src/api/routes.ts server/test/routes.test.ts
git commit -m "feat(server/walkthrough): read, summary, narrate and ask routes; one delivery path into a session"
```

---

### Task 6: Web plumbing — route, types, API client, transcript chip line count

**Files:**
- Create: `web/src/walkthrough/route.ts`
- Modify: `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/main.tsx`
- Test: `web/src/test/walkthroughroute.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // web/src/walkthrough/route.ts
  export const WALKTHROUGH_PATH = '/walkthrough'
  export function parseWalkthroughRoute(pathname: string): string | null   // the session id
  export function walkthroughPath(id: string): string
  // web/src/lib/types.ts — mirrors server/src/walkthrough/types.ts field-for-field:
  export type FateKind, StepCall, StepFate, StepQuestion, WalkthroughStep (server `Step`), Gap, TimelineEntry, FileSummary, NarrationIntent, Narration, Walkthrough
  export interface WalkthroughSummary { steps: number; files: number; blindAlleys: number; subagents: number }
  // web/src/lib/api.ts
  api.getWalkthrough(id): Promise<{ session: ApiSession; walkthrough: Walkthrough }>
  api.walkthroughSummary(id): Promise<WalkthroughSummary>
  api.narrateWalkthrough(id): Promise<{ ok: boolean; revived?: boolean }>
  api.askWalkthrough(id, step: string, question: string): Promise<{ ok: boolean; revived?: boolean }>
  ```
  The web's step type is named `WalkthroughStep` to avoid colliding with anything else called `Step`.

- [ ] **Step 1: Write the failing route test**

`web/src/test/walkthroughroute.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseWalkthroughRoute, walkthroughPath } from '../walkthrough/route'

describe('parseWalkthroughRoute', () => {
  it('names the session for exactly one segment', () => {
    expect(parseWalkthroughRoute('/walkthrough/abc')).toBe('abc')
    expect(parseWalkthroughRoute('/walkthrough/abc/')).toBe('abc')
    expect(parseWalkthroughRoute('/walkthrough/a%20b')).toBe('a b')
  })
  it('is null for anything else', () => {
    expect(parseWalkthroughRoute('/')).toBeNull()
    expect(parseWalkthroughRoute('/walkthrough')).toBeNull()
    expect(parseWalkthroughRoute('/walkthrough/')).toBeNull()
    expect(parseWalkthroughRoute('/walkthrough/a/b')).toBeNull()
    expect(parseWalkthroughRoute('/walkthroughs/a')).toBeNull()
    expect(parseWalkthroughRoute('/walkthrough/%E0%A4%A')).toBeNull()
  })
  it('round-trips through walkthroughPath', () => {
    expect(parseWalkthroughRoute(walkthroughPath('id with space'))).toBe('id with space')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd web && npx vitest run src/test/walkthroughroute.test.ts`

- [ ] **Step 3: Write the route module**

Model it on `web/src/lib/sessionWindowRoute.ts` (same strictness, same decode guard):

```ts
/**
 * `/walkthrough/<sessionId>` — the walkthrough page (spec:
 * 2026-09-23-walkthrough-design § The page). A real path, branched on in
 * `main.tsx` the way `/stats` and `/session/<id>` are; vite's SPA fallback
 * and the server's static route both serve `index.html` for it.
 */
export const WALKTHROUGH_PATH = '/walkthrough'

export function parseWalkthroughRoute(pathname: string): string | null {
  if (!pathname.startsWith(`${WALKTHROUGH_PATH}/`)) return null
  const rest = pathname.slice(WALKTHROUGH_PATH.length + 1).replace(/\/$/, '')
  if (rest === '' || rest.includes('/')) return null
  try {
    const id = decodeURIComponent(rest)
    return id === '' ? null : id
  } catch {
    return null
  }
}

export function walkthroughPath(id: string): string {
  return `${WALKTHROUGH_PATH}/${encodeURIComponent(id)}`
}
```

- [ ] **Step 4: Mirror the types and add the API methods**

In `web/src/lib/types.ts`, after `ChatMessage`, add the mirrored types with a header comment `/** Walkthrough wire shape — mirrors server/src/walkthrough/types.ts (spec: 2026-09-23-walkthrough-design). */`. Rename `Step` → `WalkthroughStep` on the web side only; `subagent.steps` is `WalkthroughStep[]`.

In `web/src/lib/api.ts`, after `getMessages`:

```ts
  async getWalkthrough(id: string): Promise<{ session: ApiSession; walkthrough: Walkthrough }> {
    return request('GET', `/api/sessions/${encodeURIComponent(id)}/walkthrough`)
  },

  async walkthroughSummary(id: string): Promise<WalkthroughSummary> {
    return request('GET', `/api/sessions/${encodeURIComponent(id)}/walkthrough/summary`)
  },

  async narrateWalkthrough(id: string): Promise<{ ok: boolean; revived?: boolean }> {
    return request('POST', `/api/sessions/${encodeURIComponent(id)}/walkthrough/narrate`, {})
  },

  async askWalkthrough(id: string, step: string, question: string): Promise<{ ok: boolean; revived?: boolean }> {
    return request('POST', `/api/sessions/${encodeURIComponent(id)}/walkthrough/ask`, { step, question })
  },
```

(Check how `request` is declared in that file and whether other methods encode the id — follow the file's convention; if none encode, do not encode here either.)

- [ ] **Step 5: Branch in `main.tsx`**

Next to the `/stats` branch:

```ts
/**
 * `/walkthrough/<id>` — the walkthrough page, one more branch of the same kind
 * (spec: 2026-09-23-walkthrough-design § The page).
 */
const walkthroughId = parseWalkthroughRoute(window.location.pathname)
```

and in the render chain, before `<App />`: `walkthroughId !== null ? <WalkthroughPage id={walkthroughId} /> :`. Import `WalkthroughPage` lazily the way the other pages are (`lazy(() => import('./walkthrough/WalkthroughPage').then(m => ({ default: m.WalkthroughPage })))`). Until Task 8 lands, create `web/src/walkthrough/WalkthroughPage.tsx` exporting a component that renders `<div>walkthrough</div>` so the build passes; Task 8 replaces it.

- [ ] **Step 6: Run tests, typecheck, commit**

```bash
cd web && npx vitest run src/test/walkthroughroute.test.ts && npm run typecheck
git add web/src/walkthrough/route.ts web/src/walkthrough/WalkthroughPage.tsx web/src/lib/types.ts web/src/lib/api.ts web/src/main.tsx web/src/test/walkthroughroute.test.ts
git commit -m "feat(web/walkthrough): route, mirrored types, api client, page branch"
```

---

### Task 7: The page's data — `useWalkthrough`

**Files:**
- Create: `web/src/walkthrough/useWalkthrough.ts`
- Test: `web/src/test/usewalkthrough.test.tsx`

**Interfaces:**
- Consumes: `api.getWalkthrough`, `getSocket()` from `web/src/lib/socket.ts`, `SessionEvent` / `SessionsEvent` from `web/src/store/store.ts`, `useOrbital`.
- Produces:
  ```ts
  export const WALKTHROUGH_REFETCH_DEBOUNCE_MS = 400
  export interface WalkthroughData {
    session: ApiSession | null
    walkthrough: Walkthrough | null
    error: 'not_found' | 'failed' | null
    loading: boolean
    refetch(): void
  }
  export function useWalkthrough(id: string): WalkthroughData
  ```
  Behaviour: fetch on mount; subscribe to `session:<id>` and refetch (debounced by `WALKTHROUGH_REFETCH_DEBOUNCE_MS`) on every `message` event and on a `status` event; subscribe to `sessions` and update `session` when an `upsert` names this id (status, ide, title change without a refetch). Only the newest request may write (a `requestSeq` ref, as `StatsDashboard` does). A `404` sets `error: 'not_found'`; anything else `'failed'`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { ApiSession, Walkthrough } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

const handlers = new Map<string, (msg: unknown) => void>()
vi.mock('../lib/socket', () => ({
  getSocket: () => ({
    subscribe: (topic: string, cb: (msg: unknown) => void) => { handlers.set(topic, cb); return () => handlers.delete(topic) },
    onStatusChange: () => () => {},
  }),
}))

import { api, ApiError } from '../lib/api'
import { useWalkthrough, WALKTHROUGH_REFETCH_DEBOUNCE_MS } from '../walkthrough/useWalkthrough'

const session = { id: 'w1', title: 't', status: 'idle', source: 'web', cwd: '/w', ide: null, subagents: [] } as unknown as ApiSession
const empty: Walkthrough = { steps: [], timeline: [], files: [], narration: null, narrationFailed: false, lastMessageId: null }

beforeEach(() => { handlers.clear(); vi.useFakeTimers() })

describe('useWalkthrough', () => {
  it('fetches once on mount and again, debounced, when the session speaks', async () => {
    vi.mocked(api.getWalkthrough).mockResolvedValue({ session, walkthrough: empty })
    const { result } = renderHook(() => useWalkthrough('w1'))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(api.getWalkthrough).toHaveBeenCalledTimes(1)
    expect(result.current.walkthrough).toEqual(empty)

    act(() => {
      handlers.get('session:w1')!({ event: 'message', message: { id: 'm1', role: 'assistant', text: 'x' } })
      handlers.get('session:w1')!({ event: 'message', message: { id: 'm2', role: 'assistant', text: 'y' } })
    })
    expect(api.getWalkthrough).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(WALKTHROUGH_REFETCH_DEBOUNCE_MS + 1); await Promise.resolve() })
    expect(api.getWalkthrough).toHaveBeenCalledTimes(2)
  })

  it('takes a sessions upsert for this id without refetching', async () => {
    vi.mocked(api.getWalkthrough).mockResolvedValue({ session, walkthrough: empty })
    const { result } = renderHook(() => useWalkthrough('w1'))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    act(() => { handlers.get('sessions')!({ event: 'upsert', session: { ...session, status: 'working' } }) })
    expect(result.current.session?.status).toBe('working')
    expect(api.getWalkthrough).toHaveBeenCalledTimes(1)
  })

  it('reports not_found on a 404 and failed otherwise', async () => {
    vi.mocked(api.getWalkthrough).mockRejectedValueOnce(new ApiError('nf', 404))
    const a = renderHook(() => useWalkthrough('w1'))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(a.result.current.error).toBe('not_found')
    vi.mocked(api.getWalkthrough).mockRejectedValueOnce(new Error('boom'))
    const b = renderHook(() => useWalkthrough('w2'))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(b.result.current.error).toBe('failed')
  })
})
```

Check `ApiError`'s constructor signature in `web/src/lib/api.ts` (`(message, status, url?)`) and adjust.

- [ ] **Step 2: Run to verify it fails** — `cd web && npx vitest run src/test/usewalkthrough.test.tsx`

- [ ] **Step 3: Write the hook**

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { getSocket } from '../lib/socket'
import type { ApiSession, Walkthrough } from '../lib/types'
import type { SessionEvent, SessionsEvent } from '../store/store'

/** A burst of WS messages (a turn streaming in) becomes one refetch. */
export const WALKTHROUGH_REFETCH_DEBOUNCE_MS = 400

export interface WalkthroughData {
  session: ApiSession | null
  walkthrough: Walkthrough | null
  error: 'not_found' | 'failed' | null
  loading: boolean
  refetch(): void
}

/**
 * The page's data (spec § The page, "A live session grows under the page").
 * The spine is rebuilt server-side on every request, so the page simply asks
 * again whenever the session's topic delivers something; the row itself
 * (status, editor, title) is taken from the `sessions` topic without a
 * refetch. Only the newest request may write.
 */
export function useWalkthrough(id: string): WalkthroughData {
  const [session, setSession] = useState<ApiSession | null>(null)
  const [walkthrough, setWalkthrough] = useState<Walkthrough | null>(null)
  const [error, setError] = useState<WalkthroughData['error']>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  const refetch = useCallback(() => {
    const mine = ++seq.current
    api.getWalkthrough(id).then(
      (data) => {
        if (seq.current !== mine) return
        setSession(data.session)
        setWalkthrough(data.walkthrough)
        setError(null)
        setLoading(false)
      },
      (err: unknown) => {
        if (seq.current !== mine) return
        setError(err instanceof ApiError && err.status === 404 ? 'not_found' : 'failed')
        setLoading(false)
      },
    )
  }, [id])

  useEffect(() => { refetch() }, [refetch])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; refetch() }, WALKTHROUGH_REFETCH_DEBOUNCE_MS)
    }
    const release = getSocket().subscribe(`session:${id}`, (msg: SessionEvent) => {
      if (msg.event === 'message' || msg.event === 'status') schedule()
    })
    return () => { release(); if (timer) clearTimeout(timer) }
  }, [id, refetch])

  useEffect(() => {
    return getSocket().subscribe('sessions', (msg: SessionsEvent) => {
      if (msg.event === 'upsert' && msg.session.id === id) setSession(msg.session)
    })
  }, [id])

  return { session, walkthrough, error, loading, refetch }
}
```

Check the exact shape of `SessionsEvent` in `store.ts` (`{ event: 'upsert'; session: ApiSession }` and others) and the `ApiError.status` field name.

- [ ] **Step 4: Run, typecheck, commit**

```bash
cd web && npx vitest run src/test/usewalkthrough.test.tsx && npm run typecheck
git add web/src/walkthrough/useWalkthrough.ts web/src/test/usewalkthrough.test.tsx
git commit -m "feat(web/walkthrough): the page's data hook — fetch, refetch on session events"
```

---

### Task 8: The page — cover, steps, gaps, subagent steps, close

**Files:**
- Replace: `web/src/walkthrough/WalkthroughPage.tsx`
- Create: `web/src/walkthrough/Cover.tsx`, `web/src/walkthrough/StepScreen.tsx`, `web/src/walkthrough/StepRail.tsx`, `web/src/walkthrough/StepBody.tsx`, `web/src/walkthrough/GapLine.tsx`, `web/src/walkthrough/AskField.tsx`, `web/src/walkthrough/CloseScreen.tsx`, `web/src/walkthrough/derive.ts`
- Test: `web/src/test/walkthroughderive.test.ts`, `web/src/test/walkthroughpage.test.tsx`

**Interfaces:**
- Consumes: `useWalkthrough` (Task 7), `ChangeView`/`changeSectionLabel` (`web/src/panels/DiffView.tsx`), `describeFileChange`/`changeCounts` (`web/src/lib/fileEdit.ts`), `formatDuration`/`shortenPath` (`web/src/lib/format.ts`), `withSessionParam` (`web/src/lib/sessionUrl.ts`), `api.narrateWalkthrough`, `api.askWalkthrough`, `api.ideOpenFile`, `reportError` (`web/src/lib/errors.ts`).
- Produces (`derive.ts`, pure, tested):
  ```ts
  export interface RailGroup { title: string | null; steps: WalkthroughStep[] }
  export function railGroups(w: Walkthrough): RailGroup[]                      // intents when narrated, one flat group otherwise
  export function intentFor(w: Walkthrough, stepId: string): NarrationIntent | null
  export function gapBefore(w: Walkthrough, stepId: string): Gap | null
  export function trailingGap(w: Walkthrough): Gap | null
  export function foldedLine(folded: Record<string, number>): string          // 'read 4 files · ran 2 commands · 3 other calls'
  export function fileCounts(w: Walkthrough, path: string): { added: number; removed: number } | null   // sum of changeCounts over Edits and created files; null when nothing countable
  export function blindAlleySteps(w: Walkthrough): WalkthroughStep[]          // fate has 'reverted', or its intent is abandoned
  export function stillOpen(w: Walkthrough): Array<{ step: WalkthroughStep; call: StepCall }>   // calls whose result isError
  export type Screen = { kind: 'cover' } | { kind: 'step'; index: number } | { kind: 'close' }
  export function nextScreen(s: Screen, stepCount: number): Screen
  export function prevScreen(s: Screen, stepCount: number): Screen
  ```
- The page takes `{ id: string }`.

- [ ] **Step 1: Write the failing derive tests**

```ts
import { describe, it, expect } from 'vitest'
import type { Walkthrough, WalkthroughStep } from '../lib/types'
import { blindAlleySteps, fileCounts, foldedLine, gapBefore, nextScreen, prevScreen, railGroups, stillOpen } from '../walkthrough/derive'

const step = (id: string, ordinal: number, patch: Partial<WalkthroughStep> = {}): WalkthroughStep => ({
  id, ordinal, narration: '', calls: [], folded: {}, subagent: null, fate: [], questions: [], durationMs: null, ...patch,
})
const editCall = (path: string, from: string, to: string, isError = false) => ({
  call: { id: 'c', role: 'tool_use' as const, toolName: 'Edit', toolInput: { file_path: path, old_string: from, new_string: to }, toolUseId: 'c' },
  result: { id: 'r', role: 'tool_result' as const, toolUseId: 'c', text: isError ? 'old_string not found' : 'ok', ...(isError ? { isError: true } : {}) },
})
const base = (patch: Partial<Walkthrough> = {}): Walkthrough => ({
  steps: [step('a', 1), step('b', 2), step('c', 3)],
  timeline: [{ kind: 'gap', durationMs: null, folded: { Read: 2 }, subagents: [], said: 'hm' }, { kind: 'step', id: 'a' }, { kind: 'step', id: 'b' }, { kind: 'gap', durationMs: null, folded: {}, subagents: ['survey'], said: '' }, { kind: 'step', id: 'c' }],
  files: [], narration: null, narrationFailed: false, lastMessageId: null, ...patch,
})

describe('railGroups', () => {
  it('is one untitled group without narration', () => {
    expect(railGroups(base()).map((g) => [g.title, g.steps.map((s) => s.id)])).toEqual([[null, ['a', 'b', 'c']]])
  })
  it('follows the intents when narrated', () => {
    const w = base({ narration: { staleSteps: 0, intents: [{ title: 'T', summary: '', steps: ['a', 'b'], considered: [], abandoned: false }, { title: '', summary: '', steps: ['c'], considered: [], abandoned: false }] } })
    expect(railGroups(w).map((g) => [g.title, g.steps.map((s) => s.id)])).toEqual([['T', ['a', 'b']], [null, ['c']]])
  })
})

describe('gapBefore', () => {
  it('finds the gap immediately preceding a step, and null when a step precedes it', () => {
    expect(gapBefore(base(), 'a')?.folded).toEqual({ Read: 2 })
    expect(gapBefore(base(), 'b')).toBeNull()
    expect(gapBefore(base(), 'c')?.subagents).toEqual(['survey'])
  })
})

describe('foldedLine', () => {
  it('words the common tools and counts the rest', () => {
    expect(foldedLine({ Read: 4, Bash: 2, Grep: 1, Glob: 2 })).toBe('read 4 files · ran 2 commands · 3 searches')
    expect(foldedLine({ Read: 1 })).toBe('read 1 file')
    expect(foldedLine({ WebFetch: 2 })).toBe('2 other calls')
    expect(foldedLine({})).toBe('')
  })
})

describe('fileCounts / blindAlleySteps / stillOpen', () => {
  it('sums Edit counts per path and refuses paths with nothing countable', () => {
    const w = base({ steps: [step('a', 1, { calls: [editCall('x.ts', 'p\nq', 'p\nr\ns')] }), step('b', 2, { calls: [editCall('x.ts', 'r', 'z')] })] })
    expect(fileCounts(w, 'x.ts')).toEqual({ added: 3, removed: 2 })
    expect(fileCounts(w, 'none.ts')).toBeNull()
  })
  it('a reverted step or an abandoned intent is a blind alley; a failed call is still open', () => {
    const w = base({
      steps: [step('a', 1, { fate: [{ kind: 'reverted', byStep: 'c', path: 'x' }] }), step('b', 2), step('c', 3, { calls: [editCall('cfg', 'q', 'r', true)] })],
      narration: { staleSteps: 0, intents: [{ title: '', summary: '', steps: ['a'], considered: [], abandoned: false }, { title: 'retry', summary: '', steps: ['b'], considered: [], abandoned: true }, { title: '', summary: '', steps: ['c'], considered: [], abandoned: false }] },
    })
    expect(blindAlleySteps(w).map((s) => s.id)).toEqual(['a', 'b'])
    expect(stillOpen(w).map((o) => o.step.id)).toEqual(['c'])
  })
})

describe('screens', () => {
  it('walks cover → steps → close and back, clamped', () => {
    expect(nextScreen({ kind: 'cover' }, 3)).toEqual({ kind: 'step', index: 0 })
    expect(nextScreen({ kind: 'step', index: 2 }, 3)).toEqual({ kind: 'close' })
    expect(nextScreen({ kind: 'close' }, 3)).toEqual({ kind: 'close' })
    expect(prevScreen({ kind: 'step', index: 0 }, 3)).toEqual({ kind: 'cover' })
    expect(prevScreen({ kind: 'close' }, 3)).toEqual({ kind: 'step', index: 2 })
    expect(nextScreen({ kind: 'cover' }, 0)).toEqual({ kind: 'close' })
  })
})
```

`fileCounts` expectation: the diff of `p\nq` → `p\nr\ns` is +2 −1; `r` → `z` is +1 −1; sum +3 −2. Verify with `diffLines` if the numbers differ and correct the expectation, not the algorithm.

- [ ] **Step 2: Run to verify it fails** — `cd web && npx vitest run src/test/walkthroughderive.test.ts`

- [ ] **Step 3: Write `derive.ts`**

```ts
import { changeCounts, describeFileChange } from '../lib/fileEdit'
import type { Gap, NarrationIntent, StepCall, Walkthrough, WalkthroughStep } from '../lib/types'

export interface RailGroup { title: string | null; steps: WalkthroughStep[] }

export function railGroups(w: Walkthrough): RailGroup[] {
  if (!w.narration) return [{ title: null, steps: w.steps }]
  const byId = new Map(w.steps.map((s) => [s.id, s]))
  return w.narration.intents.map((i) => ({
    title: i.title || null,
    steps: i.steps.map((id) => byId.get(id)).filter((s): s is WalkthroughStep => !!s),
  })).filter((g) => g.steps.length > 0)
}

export function intentFor(w: Walkthrough, stepId: string): NarrationIntent | null {
  return w.narration?.intents.find((i) => i.steps.includes(stepId)) ?? null
}

export function gapBefore(w: Walkthrough, stepId: string): Gap | null {
  const i = w.timeline.findIndex((t) => t.kind === 'step' && t.id === stepId)
  const prev = i > 0 ? w.timeline[i - 1] : null
  return prev && prev.kind === 'gap' ? prev : null
}

export function trailingGap(w: Walkthrough): Gap | null {
  const last = w.timeline[w.timeline.length - 1]
  return last && last.kind === 'gap' ? last : null
}

const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch'])

/** The one-line fold of a step's or gap's non-writing calls (canvas 21b/21c). */
export function foldedLine(folded: Record<string, number>): string {
  const parts: string[] = []
  const reads = folded.Read ?? 0
  const commands = folded.Bash ?? 0
  let searches = 0
  let other = 0
  for (const [tool, n] of Object.entries(folded)) {
    if (tool === 'Read' || tool === 'Bash') continue
    if (SEARCH_TOOLS.has(tool)) searches += n
    else other += n
  }
  if (reads) parts.push(`read ${reads} ${reads === 1 ? 'file' : 'files'}`)
  if (commands) parts.push(`ran ${commands} ${commands === 1 ? 'command' : 'commands'}`)
  if (searches) parts.push(`${searches} ${searches === 1 ? 'search' : 'searches'}`)
  if (other) parts.push(`${other} other ${other === 1 ? 'call' : 'calls'}`)
  return parts.join(' · ')
}

/** A step's writing calls, a subagent step's sub-steps included. */
export function callsOf(step: WalkthroughStep): StepCall[] {
  return step.subagent ? step.subagent.steps.flatMap(callsOf) : step.calls
}

function pathOf(c: StepCall): string | null {
  const input = c.call.toolInput as Record<string, unknown> | null
  const p = input?.file_path ?? input?.notebook_path
  return typeof p === 'string' ? p : null
}

export function fileCounts(w: Walkthrough, path: string): { added: number; removed: number } | null {
  let added = 0
  let removed = 0
  let any = false
  for (const step of w.steps) {
    for (const c of callsOf(step)) {
      if (pathOf(c) !== path) continue
      const change = describeFileChange(c.call.toolName, c.call.toolInput, c.result?.text, c.result?.isError === true)
      const counts = change ? changeCounts(change) : null
      if (!counts) continue
      any = true
      added += counts.added
      removed += counts.removed
    }
  }
  return any ? { added, removed } : null
}

export function blindAlleySteps(w: Walkthrough): WalkthroughStep[] {
  return w.steps.filter((s) => s.fate.some((f) => f.kind === 'reverted') || intentFor(w, s.id)?.abandoned === true)
}

export function stillOpen(w: Walkthrough): Array<{ step: WalkthroughStep; call: StepCall }> {
  return w.steps.flatMap((step) => callsOf(step).filter((c) => c.result?.isError === true).map((call) => ({ step, call })))
}

export type Screen = { kind: 'cover' } | { kind: 'step'; index: number } | { kind: 'close' }

export function nextScreen(s: Screen, stepCount: number): Screen {
  if (s.kind === 'cover') return stepCount > 0 ? { kind: 'step', index: 0 } : { kind: 'close' }
  if (s.kind === 'step') return s.index + 1 < stepCount ? { kind: 'step', index: s.index + 1 } : { kind: 'close' }
  return s
}

export function prevScreen(s: Screen, stepCount: number): Screen {
  if (s.kind === 'close') return stepCount > 0 ? { kind: 'step', index: stepCount - 1 } : { kind: 'cover' }
  if (s.kind === 'step') return s.index > 0 ? { kind: 'step', index: s.index - 1 } : { kind: 'cover' }
  return s
}
```

- [ ] **Step 4: Run the derive tests** — Expected: PASS (fix the `fileCounts` expectation only if the diff's counts genuinely differ; print `diffLines` if in doubt).

- [ ] **Step 5: Write the failing page test**

`web/src/test/walkthroughpage.test.tsx` — behaviour only, no pixels:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ApiSession, Walkthrough } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())
vi.mock('../lib/socket', () => ({ getSocket: () => ({ subscribe: () => () => {}, onStatusChange: () => () => {} }) }))

import { api } from '../lib/api'
import { WalkthroughPage } from '../walkthrough/WalkthroughPage'

const session = (patch: Partial<ApiSession> = {}) =>
  ({ id: 'w1', title: 'auth-refactor', status: 'idle', source: 'web', cwd: '/w/auth', ide: null, subagents: [], ...patch }) as unknown as ApiSession

const edit = (id: string, path: string, from: string, to: string) => ({
  call: { id: `${id}:1`, role: 'tool_use' as const, toolName: 'Edit', toolInput: { file_path: path, old_string: from, new_string: to }, toolUseId: id },
  result: { id: `${id}:r`, role: 'tool_result' as const, toolUseId: id, text: 'ok' },
})
const walkthrough: Walkthrough = {
  steps: [
    { id: 'e1', ordinal: 1, narration: 'Adding the margin.', calls: [edit('e1', 'src/refresh.ts', 'skew = 0', 'skew = 30')], folded: { Read: 2 }, subagent: null, fate: [{ kind: 'revised', byStep: 'e2', path: 'src/refresh.ts' }], questions: [{ question: 'Why?', answer: 'Because.', messageId: 'q1' }], durationMs: 14200 },
    { id: 'e2', ordinal: 2, narration: 'Into config.', calls: [edit('e2', 'src/refresh.ts', 'skew = 30', 'skew = cfg')], folded: {}, subagent: null, fate: [], questions: [], durationMs: null },
  ],
  timeline: [{ kind: 'gap', durationMs: 5000, folded: { Read: 4 }, subagents: [], said: 'Looking around.' }, { kind: 'step', id: 'e1' }, { kind: 'step', id: 'e2' }],
  files: [{ path: 'src/refresh.ts', steps: ['e1', 'e2'], created: false, fate: 'revised', notApplied: false }],
  narration: null, narrationFailed: false, lastMessageId: 'x',
}

beforeEach(() => { vi.mocked(api.getWalkthrough).mockResolvedValue({ session: session(), walkthrough }) })

describe('WalkthroughPage', () => {
  it('opens on the cover with the counts, starts into step 1, and shows the diff and the exchange', async () => {
    render(<WalkthroughPage id="w1" />)
    await screen.findByText('auth-refactor')
    expect(screen.getByLabelText('steps')).toHaveTextContent('2')
    expect(screen.getByLabelText('files touched')).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('button', { name: /start/i }))
    // The eyebrow and the top bar both say it; the rail repeats the narration.
    expect((await screen.findAllByText(/step 1 of 2/i)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Adding the margin.').length).toBeGreaterThan(0)
    expect(screen.getByText('Looking around.')).toBeInTheDocument()       // the gap before step 1, said verbatim
    expect(screen.getByText(/revised in/)).toBeInTheDocument()
    expect(screen.getByText('Why?')).toBeInTheDocument()
    expect(screen.getByText('Because.')).toBeInTheDocument()
  })

  it('asks the session from a step', async () => {
    vi.mocked(api.askWalkthrough).mockResolvedValue({ ok: true })
    render(<WalkthroughPage id="w1" />)
    fireEvent.click(await screen.findByRole('button', { name: /start/i }))
    const field = await screen.findByPlaceholderText(/ask the session/i)
    fireEvent.change(field, { target: { value: 'Why the margin?' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(api.askWalkthrough).toHaveBeenCalledWith('w1', 'e1', 'Why the margin?'))
  })

  it('disables the field, with the reason, while the session is working', async () => {
    vi.mocked(api.getWalkthrough).mockResolvedValue({ session: session({ status: 'working' }), walkthrough })
    render(<WalkthroughPage id="w1" />)
    fireEvent.click(await screen.findByRole('button', { name: /start/i }))
    const field = await screen.findByPlaceholderText(/ask the session/i)
    expect((field as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByText(/asking waits until it settles/i)).toBeInTheDocument()
  })

  it('narrates on request from the cover', async () => {
    vi.mocked(api.narrateWalkthrough).mockResolvedValue({ ok: true })
    render(<WalkthroughPage id="w1" />)
    fireEvent.click(await screen.findByRole('button', { name: /^narrate/i }))
    await waitFor(() => expect(api.narrateWalkthrough).toHaveBeenCalledWith('w1'))
  })

  it('says so when the session is unknown', async () => {
    const { ApiError } = await import('../lib/api')
    vi.mocked(api.getWalkthrough).mockRejectedValue(new ApiError('nf', 404))
    render(<WalkthroughPage id="nope" />)
    expect(await screen.findByText(/not known/i)).toBeInTheDocument()
  })
})
```

The second test opens the working session in the same document; simpler: use `cleanup()` between renders or split into two tests. Split it — one test per state.

- [ ] **Step 6: Write the components**

Guidance for every component: dark canvas language as the rest of the app (Tailwind classes already used by `StatsShell`/`DetailPanel`: `bg-space`, `text-text-bright`, `text-text-muted`, `border-panel-border`, `font-mono`); mono eyebrows; no new colours — fate, failure and blind alleys are marks and ink (`↷`, `↶`, dashed frame). Metrics from canvas 21h are a guide; the main session does the fidelity pass afterwards, so do not agonise over pixels. What must be right is the content and behaviour below.

`WalkthroughPage.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useWalkthrough } from './useWalkthrough'
import { Cover } from './Cover'
import { StepScreen } from './StepScreen'
import { CloseScreen } from './CloseScreen'
import { nextScreen, prevScreen, type Screen } from './derive'
import { withSessionParam } from '../lib/sessionUrl'
import { ErrorBoundary } from '../ui/ErrorBoundary'

/** Back to the map with this session selected — the page's only exit. */
export function mapHref(id: string): string {
  return withSessionParam(id, `${window.location.origin}/`)
}

export function WalkthroughPage({ id }: { id: string }) {
  const data = useWalkthrough(id)
  const [screen, setScreen] = useState<Screen>({ kind: 'cover' })
  const stepCount = data.walkthrough?.steps.length ?? 0

  useEffect(() => {
    if (data.session?.title) document.title = `${data.session.title} · walkthrough`
  }, [data.session?.title])

  // ⏎ start · → / ← step · esc back to the map (canvas 21a). Ignored while
  // typing into the question field — the field stops propagation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { window.location.assign(mapHref(id)); return }
      if (e.key === 'ArrowRight' || (e.key === 'Enter' && screen.kind === 'cover')) setScreen((s) => nextScreen(s, stepCount))
      if (e.key === 'ArrowLeft') setScreen((s) => prevScreen(s, stepCount))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, screen.kind, stepCount])

  // The step being read never moves when the spine grows (spec § The page):
  // the screen is an index, and new steps append after it.
  if (data.error === 'not_found') return <Shell><p>This session is not known to Orbital.</p></Shell>
  if (data.error === 'failed') return <Shell><p>The walkthrough could not be loaded. <button onClick={data.refetch}>Try again</button></p></Shell>
  if (!data.walkthrough || !data.session) return <Shell />

  const common = { session: data.session, walkthrough: data.walkthrough, id, onRefetch: data.refetch }
  return (
    <Shell>
      <ErrorBoundary label="Walkthrough">
        {screen.kind === 'cover' && <Cover {...common} onStart={() => setScreen(nextScreen(screen, stepCount))} />}
        {screen.kind === 'step' && (
          <StepScreen {...common} index={Math.min(screen.index, stepCount - 1)}
            onPrev={() => setScreen(prevScreen(screen, stepCount))}
            onNext={() => setScreen(nextScreen(screen, stepCount))}
            onJump={(index) => setScreen({ kind: 'step', index })} />
        )}
        {screen.kind === 'close' && <CloseScreen {...common} onJump={(index) => setScreen({ kind: 'step', index })} onPrev={() => setScreen(prevScreen(screen, stepCount))} />}
      </ErrorBoundary>
    </Shell>
  )
}

function Shell({ children }: { children?: React.ReactNode }) {
  return <div className="min-h-screen w-screen bg-space text-text-bright">{children}</div>
}
```

`Cover.tsx` — props `{ id, session, walkthrough, onStart, onRefetch }`:
- Top bar: `← {session.title}` linking to `mapHref(id)`, crumb `/ WALKTHROUGH`, `shortenPath(session.cwd)`, the status word.
- Title, path; four counts each in an element with `aria-label`: `steps`, `files touched`, `blind alleys`, `subagents that wrote` (values: `walkthrough.steps.length`, `walkthrough.files.length`, `blindAlleySteps(walkthrough).length`, `walkthrough.steps.filter(s => s.subagent).length`).
- Narration block, four states from `walkthrough.narration` / `narrationFailed` / `narration.staleSteps` (canvas 21a NARR table copy: "Narrate this walkthrough · one turn, answered by this session · counts against your subscription", "Narrated · n intents", "n steps since the narration", "the narration did not come back as expected — the steps below are intact, in the agent's own words"). The button is `Narrate` / `Narrate again` / `Try again`; on click `api.narrateWalkthrough(id)` then `onRefetch()`; a `409 busy` shows "the session is working — narrating waits until it settles"; a `409 terminal_session` shows "this session is not Orbital's to continue". Disabled with `pending` while in flight. Hidden entirely when `steps.length === 0` (the cover says "no file changes in this session" instead of Start).
- `Start →` button (`aria-label` not needed; text "Start"). Footer hint: `⏎ start · → / ← step · esc back to the map`.

`StepScreen.tsx` — props `{ id, session, walkthrough, index, onPrev, onNext, onJump, onRefetch }`:
- Top bar with `step {n} of {N}` and, when `session.status === 'working'`, the notice `session working · steps may be added`.
- Left: `<StepRail groups={railGroups(walkthrough)} currentId onJump blindIds notAppliedIds />`.
- Centre: `<GapLine gap={gapBefore(walkthrough, step.id)} prevStep />` above `<StepBody />`.
- Footer: `← Previous` (disabled on the first), `{n} / {N}`, `Next →` (label `Close →` on the last).

`StepRail.tsx`: a `<nav aria-label="step list">` (not "steps" — the cover's count carries that label); each group's title as a mono eyebrow when not null; each step a `<button>` with ordinal, first narration line or intent title, the paths' basenames, and a right mark: `↶ n` for a blind alley (n = the reverting step's ordinal), `not applied` for a failed call. Current step gets `aria-current="step"`. A gap between steps in the flow shows as a dotted band (a `<div role="separator">`).

`StepBody.tsx` — props `{ id, session, walkthrough, step, onJump, onRefetch }`:
- Eyebrow `STEP n OF N · {intent title uppercased}` or `· SUBAGENT`.
- Title: `intentFor(...)?.title || step.narration || (step.subagent ? step.subagent.prompt : '')`; summary from the intent; the agent's own words quoted under it when an intent supplied the title.
- Folded line: `foldedLine(step.folded)` + `inside this step` + `formatDuration(step.durationMs)` when not null.
- For each writing call in `step.calls` (a `FileBlock`): header `{toolName}: {path}` with tag `NEW` (write created) / `NOT APPLIED` (isError, dashed frame), `+n −m` from `changeCounts`, `open in {session.ide.ideName} ↗` only when `session.ide` is not null → `api.ideOpenFile(id, path, null)`; body `<ChangeView change={describeFileChange(...)} isError={...} />` or the raw input JSON when `describeFileChange` returns null; error text from `result.text` when `isError`.
- Fate rows: for each `step.fate`, `↷ revised in step {ordinal}` / `↶ reverted in step {ordinal}` as a button calling `onJump(indexOf(byStep))`. Also the reverse marks: for each other step whose fate names this step, `↷ revises step n` / `↶ reverts step n`.
- Subagent step: `SUBAGENT` eyebrow, the prompt quoted, then each sub-step as a collapsible row (`<details>` is fine) with its own `FileBlock`s and its narration.
- `<AskField />` and the step's `questions` under it: question as a user-style row, answer as assistant text, `answer === null` → "waiting for the answer…".

`AskField.tsx` — props `{ id, step, session, onSent }`:
- A `<textarea placeholder="ask the session about this step…">`; Enter (without Shift) sends via `api.askWalkthrough(id, step.id, text)`, clears, calls `onSent()`; `stopPropagation` on keydown so the page's arrow keys do not fire while typing.
- Disabled when `session.status === 'working' || session.status === 'needs_input'` with the line `the session is working — asking waits until it settles`; hint otherwise `⏎ ask · one turn, answered by this session`.
- Errors: `409 busy` → same working line; `409 terminal_session` → `this session is not Orbital's to continue`; other → `reportError` + inline "could not send".

`GapLine.tsx` — props `{ gap: Gap | null; prevOrdinal: number | null }`: nothing when null; otherwise `BETWEEN {prev} AND {next}` eyebrow with `formatDuration(gap.durationMs)`, `foldedLine(gap.folded)`, each `gap.subagents` as `subagent "{name}" changed nothing`, and `gap.said` as its own text node, verbatim, in a `<blockquote>` (the quote marks are CSS, so a test can find the text; clamp to a few lines with a `more` toggle).

`CloseScreen.tsx` — props `{ id, session, walkthrough, onJump, onPrev }`:
- Headline `{steps} steps, {files} files, {blindAlleys} blind alleys`.
- FILES: each `walkthrough.files` row: glyph `↶` when `fate === 'reverted'`, path, step ordinals as jump buttons, `+n −m` from `fileCounts` (or `created in n` when `created`, `restored in n` when the last fate is reverted).
- ABANDONED: `blindAlleySteps(walkthrough)` grouped by intent when narrated, with the intent summary; each file in the group with its mark.
- STILL OPEN: `stillOpen(walkthrough)` as `NOT APPLIED` rows with the result text and a jump; plus `the session is still working` block when `session.status === 'working'`; plus the trailing gap (`trailingGap`) as "after the last step".
- `← Back to the map` (`mapHref(id)`) and `Open the transcript` (same href — the map opens the panel).

- [ ] **Step 7: Run the page tests and the whole web suite**

```bash
cd web && npx vitest run src/test/walkthroughpage.test.tsx src/test/walkthroughderive.test.ts && npm run test:run && npm run typecheck && npx eslint src/walkthrough
```
Expected: PASS, clean.

- [ ] **Step 8: Commit**

```bash
git add web/src/walkthrough web/src/test/walkthroughderive.test.ts web/src/test/walkthroughpage.test.tsx
git commit -m "feat(web/walkthrough): the page — cover, steps, gaps, subagent steps, close"
```

---

### Task 9: The entry control in the detail panel header

**Files:**
- Modify: `web/src/ui/UtilityButton.tsx` (add `WalkthroughGlyph`), `web/src/panels/DetailPanel.tsx` (row 1 of the header, ~line 660, left of the pin)
- Test: `web/src/test/detail.test.tsx` (one case)

**Interfaces:**
- Consumes: `api.walkthroughSummary`, `walkthroughPath` (Task 6), `UtilityButton`, `Tooltip`.
- Produces: `export function WalkthroughGlyph()` — three bars stepping up (canvas 21f: 3 × 5×1.6 px bars, 3.5 px step), drawn like `ClearGlyph` with absolute `<span>`s and `bg-current`.

- [ ] **Step 1: Write the failing test**

In `web/src/test/detail.test.tsx`, find how the suite renders `DetailPanel` with a selected session and mocks `api` (it uses `mockApiModule`). Add:

```tsx
  it('offers the walkthrough only for an Orbital session with file changes', async () => {
    vi.mocked(api.walkthroughSummary).mockResolvedValue({ steps: 3, files: 2, blindAlleys: 0, subagents: 0 })
    renderWithSession({ source: 'web' })            // use the file's own helper name
    expect(await screen.findByRole('button', { name: 'Walkthrough' })).toBeInTheDocument()
  })

  it('hides the walkthrough control for a terminal session and for a session without changes', async () => {
    vi.mocked(api.walkthroughSummary).mockResolvedValue({ steps: 0, files: 0, blindAlleys: 0, subagents: 0 })
    renderWithSession({ source: 'web' })
    await waitFor(() => expect(api.walkthroughSummary).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Walkthrough' })).toBeNull()
    cleanup()
    renderWithSession({ source: 'terminal' })
    expect(screen.queryByRole('button', { name: 'Walkthrough' })).toBeNull()
    expect(api.walkthroughSummary).toHaveBeenCalledTimes(1)   // not asked for a terminal session
  })
```

- [ ] **Step 2: Run to verify it fails** — `cd web && npx vitest run src/test/detail.test.tsx -t walkthrough`

- [ ] **Step 3: Add the glyph and the control**

`UtilityButton.tsx`:

```tsx
/** Walkthrough: three bars stepping up — the staircase is the walkthrough's mark everywhere (canvas 21f). */
export function WalkthroughGlyph() {
  return (
    <span aria-hidden className="relative block" style={{ width: '11.5px', height: '11.5px' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="absolute block rounded-[1px] bg-current"
          style={{ width: '5px', height: STROKE, left: `${i * 3.25}px`, bottom: `${i * 3.5}px` }}
        />
      ))}
    </span>
  )
}
```

`DetailPanel.tsx`: a small hook near the other effects:

```tsx
  // The walkthrough's entry (spec 2026-09-23-walkthrough-design § The page,
  // canvas 21f): present only for Orbital's own sessions with at least one
  // file change — absent, not disabled. The count comes from the server's
  // summary because the loaded transcript is paged and cannot say whether an
  // older turn wrote. Re-asked when the session settles, so a session that
  // makes its first edit while selected gains the control.
  const [walkthroughSummary, setWalkthroughSummary] = useState<WalkthroughSummary | null>(null)
  const sessionSettled = session?.status === 'idle' || session?.status === 'ended'
  useEffect(() => {
    setWalkthroughSummary(null)
    if (!session || session.source !== 'web') return
    let cancelled = false
    api.walkthroughSummary(session.id)
      .then((s) => { if (!cancelled) setWalkthroughSummary(s) })
      .catch(() => { /* absent is the honest state when the server cannot say */ })
    return () => { cancelled = true }
  }, [session?.id, session?.source, sessionSettled])
```

and in row 1, before the pin:

```tsx
          {session && session.source === 'web' && walkthroughSummary && walkthroughSummary.steps > 0 && (
            <Tooltip
              title="Walkthrough"
              description={`${walkthroughSummary.steps} steps · ${walkthroughSummary.files} files`}
              align="right"
              delayMs={PIN_TOOLTIP_DELAY_MS}
            >
              <UtilityButton aria-label="Walkthrough" onClick={() => window.location.assign(walkthroughPath(session.id))}>
                <WalkthroughGlyph />
              </UtilityButton>
            </Tooltip>
          )}
```

Import `WalkthroughGlyph` alongside the other glyphs, `walkthroughPath` from `../walkthrough/route`, and the `WalkthroughSummary` type.

- [ ] **Step 4: Run the detail tests, the whole web suite, typecheck, lint; commit**

```bash
cd web && npx vitest run src/test/detail.test.tsx && npm run test:run && npm run typecheck && npx eslint src/panels/DetailPanel.tsx src/ui/UtilityButton.tsx
git add web/src/ui/UtilityButton.tsx web/src/panels/DetailPanel.tsx web/src/test/detail.test.tsx
git commit -m "feat(web/walkthrough): the header's entry control, present only when there is something to walk through"
```

---

### Task 10: Documents and the final checks

**Files:**
- Modify: `docs/superpowers/specs/2026-09-23-walkthrough-design.md` (status `draft` → `done`; a `## What is built` section listing the files, as `2026-09-23-ide-bridge-design.md` does), `docs/ideas/walk-me-through-what-the-agent-did.md` (status → `done`), this plan (status → `done`)

- [ ] **Step 1: Update the documents**

In the spec, set `status: done` and append:

```markdown
## What is built

As of <date>:

- `server/src/walkthrough/tag.ts` — the wire format: builders and parser, the chip label.
- `server/src/walkthrough/spine.ts` — `buildWalkthrough`: runs, steps, gaps, fate, files, durations, tagged turns read back.
- `server/src/walkthrough/narration.ts` — `parseNarration`.
- `server/src/walkthrough/subagents.ts` — subagent transcripts keyed by the dispatching call.
- `server/src/walkthrough/types.ts` — the wire shape, mirrored in `web/src/lib/types.ts`.
- `server/src/api/routes.ts` — `GET …/walkthrough`, `GET …/walkthrough/summary`, `POST …/walkthrough/narrate`, `POST …/walkthrough/ask`; `deliverToSession` now serves the composer and the walkthrough alike.
- `web/src/walkthrough/` — `route.ts`, `useWalkthrough.ts`, `derive.ts`, `WalkthroughPage.tsx`, `Cover.tsx`, `StepScreen.tsx`, `StepRail.tsx`, `StepBody.tsx`, `GapLine.tsx`, `AskField.tsx`, `CloseScreen.tsx`.
- `web/src/panels/DetailPanel.tsx` — the entry control; `web/src/ui/UtilityButton.tsx` — `WalkthroughGlyph`.

Not built, by decision: `getDiagnostics` on the close screen; the canvas's `next hunk` paging inherits `ChangeView`'s behaviour.
```

Set the idea's status to `done`. Set this plan's status to `done`.

- [ ] **Step 2: Validate, run everything, commit**

```bash
atlas validate
npm run typecheck && npm test && npm run lint
git add docs
git commit -m "docs: walkthrough spec, idea and plan are done"
```

- [ ] **Step 3: Hand back**

Report to the main session: every task committed, the suite green, and the two things it must do itself — the canvas fidelity pass against `Feature - Walkthrough.dc.html` 21a–21h (subagents have no DesignSync), and asking the owner about the desktop version bump (`desktop/package.json`), which this change requires because `server/` and `web/` both ship in the DMG.
