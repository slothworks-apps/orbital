---
id: 2026-09-30-session-instructions
title: Session instructions — implementation plan
status: done
type: plan
domain: sessions
related:
  - 2026-09-30-session-instructions-design
  - 2026-09-30-narrate-out-of-band-design
  - 2026-09-21-settings-sections-design
tags:
  - server
  - runner
  - settings
  - system-prompt
---
# Session Instructions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every session Orbital starts gets a system-prompt appendix composed of Orbital's shipped tips and the user's own text, both switchable from Settings › Sessions.

**Architecture:** A new pure module on the server holds the tip list and composes the appendix from settings; the runner takes one `appendix` dep in place of today's `commentary` dep and passes its result as the `append` of the `claude_code` preset. A GET route serves the tip list so the Settings preview shows what the running server sends. Three settings rows carry the switches and the text.

**Tech Stack:** TypeScript, Fastify, drizzle/SQLite (server); React 18, zustand, Tailwind (web); vitest everywhere. `@anthropic-ai/claude-agent-sdk` `systemPrompt` option, preset form.

**Spec:** `docs/superpowers/specs/2026-09-30-session-instructions-design.md`

## Global Constraints

- The system prompt is always `{ type: 'preset', preset: 'claude_code' }` plus an optional `append`; never a replacement. `settingSources` stays `['user', 'project', 'local']`.
- Block order in the appendix: tips (array order), Narrate commentary, user text. Blocks separated by one blank line (`\n\n`).
- When no block survives the composer returns `null` and the runner sends the bare preset object, byte-identical to today.
- Tip `id`s are stable once shipped: `ask-user-question`, `paths-in-code-spans`, `long-commands-in-background`. No `order` field; the array is the order.
- Settings keys and defaults, seeded in `DEFAULT_SETTINGS`: `session_instructions_tips` `'true'`, `session_instructions_custom` `'true'`, `session_instructions_custom_text` `''`. Default-on booleans are read server-side as `!== 'false'`.
- No server-side cap on the custom text.
- Settings UI lives in *Sessions*, a third group `INSTRUCTIONS` after `CLEAR & LIFECYCLE`, built from the existing `Row`, `Toggle`, `TextArea` and the collapsible-preview pattern. No new artboard; no new colours.
- Copy in the dialog says a change applies from the next start.
- Tests only where the spec § 5 lists them: composer, tip list uniqueness, route, runner append. No web tests.
- Documents in English; `atlas validate` passes before every commit. Stage only the files this plan names — other sessions edit the same checkout.
- The titler and narrator keep their own system prompts and are not touched.

## Review Focus

1. **Custom text with only whitespace or newlines** — must count as empty and produce no block, not an appendix of blank lines. Pinned in Task 1.
2. **Custom text with Windows line endings or trailing newlines pasted in** — stored verbatim, trimmed only at compose time so the field shows what was typed. Pinned in Task 1 (compose trims); the no-trim-on-write half is by inspection of the PATCH in `Settings.tsx`, since the plan adds no web tests.
3. **`tipsOff` naming an id that no tip has** — ignored, every tip still emitted. Pinned in Task 1.
4. **Settings row missing from an old database** — `get` returns `''` for an unknown key; `''` must read as "on" for the two booleans and "empty" for the text, so an upgraded install behaves exactly as a fresh one. Covered by `server/test/database.test.ts`, which asserts the three keys are seeded into a pre-existing database on boot, and by inspection of the `!== 'false'` reads in `index.ts`; the closure is glue with no branching and gets no test of its own.
5. **The tips route and the composer drifting apart** — the route must return the same ids in the same order the composer emits. Pinned in Task 3.

---

### Task 1: The composer module and the tip list

**Files:**
- Create: `server/src/runner/sessionInstructions.ts`
- Create: `server/test/sessionInstructions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface SessionTip { id: string; title: string; text: string }`
  - `export const SESSION_TIPS: readonly SessionTip[]`
  - `export const NARRATE_COMMENTARY_PROMPT: string` (moved here from `runner.ts` in Task 2; defined here now with the identical string)
  - `export interface AppendixInput { tipsOn: boolean; tipsOff?: readonly string[]; commentary: boolean; customOn: boolean; customText: string }`
  - `export function composeAppendix(input: AppendixInput): string | null`

- [x] **Step 1: Write the failing tests**

```ts
// server/test/sessionInstructions.test.ts
import { describe, it, expect } from 'vitest';
import {
  SESSION_TIPS,
  NARRATE_COMMENTARY_PROMPT,
  composeAppendix,
} from '../src/runner/sessionInstructions.js';

// Spec 2026-09-30-session-instructions-design § 1, § 2, § 5.
const allOff = { tipsOn: false, commentary: false, customOn: false, customText: '' };
const tipsText = SESSION_TIPS.map((t) => t.text).join('\n\n');

describe('SESSION_TIPS', () => {
  it('has unique ids', () => {
    const ids = SESSION_TIPS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ships the three tips the spec names, in its order', () => {
    expect(SESSION_TIPS.map((t) => t.id)).toEqual([
      'ask-user-question',
      'paths-in-code-spans',
      'long-commands-in-background',
    ]);
  });
});

describe('composeAppendix', () => {
  it('returns null when nothing survives', () => {
    expect(composeAppendix(allOff)).toBeNull();
    expect(composeAppendix({ ...allOff, customOn: true, customText: '' })).toBeNull();
    expect(composeAppendix({ ...allOff, customOn: true, customText: '  \n\r\n\t ' })).toBeNull();
  });

  it('emits the tips alone, in array order', () => {
    expect(composeAppendix({ ...allOff, tipsOn: true })).toBe(tipsText);
  });

  it('emits the commentary alone', () => {
    expect(composeAppendix({ ...allOff, commentary: true })).toBe(NARRATE_COMMENTARY_PROMPT);
  });

  it('emits the custom text alone, trimmed', () => {
    expect(composeAppendix({ ...allOff, customOn: true, customText: '\n Answer in Czech. \n' }))
      .toBe('Answer in Czech.');
  });

  it('drops the custom text while its switch is off even if it has content', () => {
    expect(composeAppendix({ ...allOff, customOn: false, customText: 'Answer in Czech.' })).toBeNull();
  });

  it('orders tips, commentary, custom text with a blank line between blocks', () => {
    const out = composeAppendix({
      tipsOn: true, commentary: true, customOn: true, customText: 'Answer in Czech.',
    });
    expect(out).toBe(`${tipsText}\n\n${NARRATE_COMMENTARY_PROMPT}\n\nAnswer in Czech.`);
  });

  it('honours tipsOff for a known id and ignores an unknown one', () => {
    const [first, ...rest] = SESSION_TIPS;
    expect(composeAppendix({ ...allOff, tipsOn: true, tipsOff: [first.id, 'no-such-tip'] }))
      .toBe(rest.map((t) => t.text).join('\n\n'));
    expect(composeAppendix({ ...allOff, tipsOn: true, tipsOff: ['no-such-tip'] })).toBe(tipsText);
  });

  it('returns null when every tip is off and nothing else is on', () => {
    expect(composeAppendix({ ...allOff, tipsOn: true, tipsOff: SESSION_TIPS.map((t) => t.id) }))
      .toBeNull();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/tomin/Projects/slothworks/orbital && npm test -w server -- sessionInstructions`
Expected: FAIL — cannot resolve `../src/runner/sessionInstructions.js`.

- [x] **Step 3: Write the module**

```ts
// server/src/runner/sessionInstructions.ts

/**
 * The appendix every session Orbital starts carries after the `claude_code`
 * preset (spec 2026-09-30-session-instructions-design). Two layers the user
 * switches from Settings › Sessions › INSTRUCTIONS — Orbital's tips and the
 * user's own text — plus the Narrate commentary switch from Experimental.
 * Pure: the runner gets a closure over the settings store that calls
 * `composeAppendix`, and nothing here reads a database.
 */

export interface SessionTip {
  /** Stable once shipped: a later per-tip switch stores it (spec § 6). */
  id: string;
  /** Heads the tip in the Settings preview. */
  title: string;
  /** What the model reads. */
  text: string;
}

/**
 * Orbital's tips, shipped with the app rather than stored: they change
 * with the version and the user never edits them (spec § 2). The array's
 * order is the order they reach the session. Each says "do X, because
 * Orbital does Y" and nothing more.
 */
export const SESSION_TIPS: readonly SessionTip[] = [
  {
    id: 'ask-user-question',
    title: 'Choices through AskUserQuestion',
    text:
      'When you offer the user a choice between options, call the AskUserQuestion tool. ' +
      'Do not write a numbered list and ask for a number: Orbital shows the tool call as a card ' +
      'with buttons, and a list in prose is not clickable.',
  },
  {
    id: 'paths-in-code-spans',
    title: 'Clickable file paths',
    text:
      'Refer to a file as its path, optionally with `:line`, alone inside an inline code span. ' +
      'Orbital turns such a span into a link that opens the file; a path inside a sentence or a ' +
      'command is plain text.',
  },
  {
    id: 'long-commands-in-background',
    title: 'Long commands in the background',
    text:
      'Run commands that take more than a moment — test suites, builds, dev servers, watchers — ' +
      'in the background. Orbital lists background tasks with their live output and lets the user ' +
      'stop each one; a foreground command shows nothing until it ends.',
  },
];

/**
 * Appended while Settings › Experimental › "Comment for Narrate" is on
 * (spec 2026-09-30-narrate-out-of-band-design § Settings › Experimental).
 * It asks for visible prose and nothing else, so the why of a change is in
 * the record the narrate query reads.
 */
export const NARRATE_COMMENTARY_PROMPT =
  'Before you change a file, say in a sentence or two what you are changing and why. ' +
  'If you considered another way and rejected it, name it and say why in the same place.';

export interface AppendixInput {
  /** `session_instructions_tips` */
  tipsOn: boolean;
  /**
   * Ids of tips to leave out. Reserved for the per-tip switch (spec § 6):
   * nothing passes it yet, and an id no tip carries is ignored.
   */
  tipsOff?: readonly string[];
  /** `narrate_commentary` */
  commentary: boolean;
  /** `session_instructions_custom` */
  customOn: boolean;
  /** `session_instructions_custom_text`, as stored — trimmed here, not on write. */
  customText: string;
}

/**
 * Tips, then the commentary, then the user's text, a blank line between
 * blocks; the user's text goes last so that where it contradicts a tip it
 * wins. `null` when no block survives, so the runner sends the bare preset.
 */
export function composeAppendix(input: AppendixInput): string | null {
  const blocks: string[] = [];
  if (input.tipsOn) {
    const off = new Set(input.tipsOff ?? []);
    for (const tip of SESSION_TIPS) if (!off.has(tip.id)) blocks.push(tip.text);
  }
  if (input.commentary) blocks.push(NARRATE_COMMENTARY_PROMPT);
  if (input.customOn) {
    const text = input.customText.trim();
    if (text) blocks.push(text);
  }
  return blocks.length ? blocks.join('\n\n') : null;
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/tomin/Projects/slothworks/orbital && npm test -w server -- sessionInstructions`
Expected: PASS, all cases.

- [x] **Step 5: Commit**

```bash
cd /Users/tomin/Projects/slothworks/orbital
git add server/src/runner/sessionInstructions.ts server/test/sessionInstructions.test.ts
git commit -m "feat(server): session instructions composer — Orbital's tips and the user's text"
```

---

### Task 2: The runner takes `appendix` in place of `commentary`

**Files:**
- Modify: `server/src/runner/runner.ts` — the `NARRATE_COMMENTARY_PROMPT` constant (~line 85–93), the `commentary` field (~line 744), the deps interface entry (~line 930–935), the constructor assignment (~line 961), the `systemPrompt` option (~line 1213–1215)
- Modify: `server/src/index.ts` — the `commentary:` line in the `new Runner({...})` call (~line 495)
- Modify: `server/test/runner.test.ts` — the `NARRATE_COMMENTARY_PROMPT` import (line 5) and the `describe('Comment for Narrate')` block (~line 3505–3530)

**Interfaces:**
- Consumes: `composeAppendix`, `NARRATE_COMMENTARY_PROMPT` from Task 1.
- Produces: runner dep `appendix?: () => string | null`. `index.ts` wires it as `() => composeAppendix({...})` over `settingsStore`.

- [x] **Step 1: Rewrite the runner test block**

Replace the whole `describe('Comment for Narrate', …)` block in `server/test/runner.test.ts` with:

```ts
describe('system prompt appendix', () => {
  // Spec 2026-09-30-session-instructions-design § 1: the runner passes the
  // dep's return as the preset's `append` and sends the bare preset on null.
  async function systemPromptOf(appendix: (() => string | null) | undefined, resume?: string) {
    const seen: any[] = [];
    const { fn } = capturingQueryFn();
    const runner = new Runner({
      hub: new Hub(), newSessionId: () => 'web-1',
      queryFn: ((args: any) => { seen.push(args.options); return fn(args); }) as any,
      ...(appendix === undefined ? {} : { appendix }),
    });
    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan', resume });
    return seen[0].systemPrompt;
  }

  it('appends the composed text to the preset, spawn and revive alike', async () => {
    const on = { type: 'preset', preset: 'claude_code', append: 'Answer in Czech.' };
    expect(await systemPromptOf(() => 'Answer in Czech.')).toEqual(on);
    expect(await systemPromptOf(() => 'Answer in Czech.', 's-old')).toEqual(on);
  });

  it('leaves the preset alone on null or unwired', async () => {
    expect(await systemPromptOf(() => null)).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(await systemPromptOf(undefined, 's-old')).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('reads the dep at every start, not once', async () => {
    let text: string | null = null;
    const seen: any[] = [];
    const { fn } = capturingQueryFn();
    const runner = new Runner({
      hub: new Hub(), newSessionId: () => 'web-1',
      queryFn: ((args: any) => { seen.push(args.options); return fn(args); }) as any,
      appendix: () => text,
    });
    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan' });
    text = 'later';
    await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan', resume: 's-old' });
    expect(seen[0].systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(seen[1].systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'later' });
  });
});
```

Then remove `NARRATE_COMMENTARY_PROMPT` from the import list at the top of `server/test/runner.test.ts` (line 5); nothing in the file uses it after this block.

- [x] **Step 2: Run the runner tests to verify the new block fails**

Run: `cd /Users/tomin/Projects/slothworks/orbital && npm test -w server -- runner -t "system prompt appendix"`
Expected: FAIL — the two `append` assertions get the bare preset, because the runner still reads `commentary`.

- [x] **Step 3: Change the runner**

In `server/src/runner/runner.ts`:

1. Delete the `NARRATE_COMMENTARY_PROMPT` constant and its doc comment (~lines 85–93). Search the file for any other use; there should be only the one in the options object.
2. Replace the field `private commentary?: () => boolean;` with:

```ts
  /** See the `appendix` dep. */
  private appendix?: () => string | null;
```

3. In the constructor's deps interface, replace the `commentary` entry with:

```ts
    /**
     * The system-prompt appendix — Orbital's tips, the Narrate commentary
     * and the user's own text, composed from settings by
     * `composeAppendix` (spec 2026-09-30-session-instructions-design § 1).
     * Read at every start — spawn and revive alike — so it holds for a
     * query from the moment it starts and a change counts from the next
     * one. Unwired or null, the bare preset goes out.
     */
    appendix?: () => string | null;
```

4. Replace `this.commentary = deps.commentary;` with `this.appendix = deps.appendix;`.
5. Replace the `systemPrompt` option:

```ts
      systemPrompt: systemPromptOption(this.appendix?.() ?? null),
```

and add, near the other module-level helpers (after `OUTPUT_PATH_IN_RESULT` is fine):

```ts
/**
 * Always the `claude_code` preset — replacing it would drop the CLI's own
 * instructions and its CLAUDE.md loading — with the appendix as `append`
 * when there is one. Bare (no `append` key at all) otherwise, so a
 * database that has never seen the Instructions rows sends exactly what it
 * sent before them.
 */
function systemPromptOption(append: string | null) {
  return append
    ? { type: 'preset', preset: 'claude_code', append }
    : { type: 'preset', preset: 'claude_code' };
}
```

- [x] **Step 4: Wire `index.ts`**

In `server/src/index.ts`, add to the imports:

```ts
import { composeAppendix } from './runner/sessionInstructions.js';
```

and replace the `commentary: () => settingsStore.get('narrate_commentary') === 'true',` line (and its two-line comment above it) with:

```ts
    // Read per start, never captured: every switch and the text hold for a
    // session from its next spawn or revive (spec
    // 2026-09-30-session-instructions-design § 1). Default-on rows read
    // `!== 'false'` so an unknown key — an install from before the rows —
    // counts as on, exactly like a fresh database.
    appendix: () =>
      composeAppendix({
        tipsOn: settingsStore.get('session_instructions_tips') !== 'false',
        commentary: settingsStore.get('narrate_commentary') === 'true',
        customOn: settingsStore.get('session_instructions_custom') !== 'false',
        customText: settingsStore.get('session_instructions_custom_text'),
      }),
```

- [x] **Step 5: Run the whole server suite and the typecheck**

Run: `cd /Users/tomin/Projects/slothworks/orbital && npm run typecheck -w server && npm test -w server`
Expected: PASS. If `routes.test.ts` or another file imports `NARRATE_COMMENTARY_PROMPT` from `runner.js`, point that import at `../src/runner/sessionInstructions.js` instead.

- [x] **Step 6: Commit**

```bash
cd /Users/tomin/Projects/slothworks/orbital
git add server/src/runner/runner.ts server/src/index.ts server/test/runner.test.ts
git commit -m "feat(server): runner takes the composed appendix in place of the commentary switch"
```

---

### Task 3: Settings defaults and the tips route

**Files:**
- Modify: `server/src/db/database.ts` — `DEFAULT_SETTINGS` (~line 20–110)
- Modify: `server/src/api/routes.ts` — after the `app.patch('/api/settings', …)` handler (~line 1832–1848)
- Modify: `server/test/routes.test.ts` — a new `describe` near the existing settings tests (~line 828)

**Interfaces:**
- Consumes: `SESSION_TIPS` from Task 1.
- Produces: `GET /api/session-instructions/tips` → `{ tips: SessionTip[] }`. Web (Task 4) reads it.

- [x] **Step 1: Write the failing route test**

Add to `server/test/routes.test.ts`, next to the existing `/api/settings` tests:

```ts
describe('GET /api/session-instructions/tips', () => {
  // Spec 2026-09-30-session-instructions-design § 4: the preview shows what
  // the running server sends, so the route and the composer share one list.
  it('returns the shipped tips in the order the composer emits them', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/session-instructions/tips' });
    expect(res.statusCode).toBe(200);
    const { tips } = res.json() as { tips: { id: string; title: string; text: string }[] };
    expect(tips.map((t) => t.id)).toEqual(SESSION_TIPS.map((t) => t.id));
    const appendix = composeAppendix({ tipsOn: true, commentary: false, customOn: false, customText: '' });
    expect(appendix).toBe(tips.map((t) => t.text).join('\n\n'));
    for (const tip of tips) {
      expect(tip.title.length).toBeGreaterThan(0);
      expect(tip.text.length).toBeGreaterThan(0);
    }
  });

  it('seeds the three instruction rows with their defaults', async () => {
    const { app } = makeApp();
    const settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(settings.session_instructions_tips).toBe('true');
    expect(settings.session_instructions_custom).toBe('true');
    expect(settings.session_instructions_custom_text).toBe('');
  });
});
```

and add the import at the top of the file:

```ts
import { SESSION_TIPS, composeAppendix } from '../src/runner/sessionInstructions.js';
```

- [x] **Step 2: Run to verify it fails**

Run: `cd /Users/tomin/Projects/slothworks/orbital && npm test -w server -- routes -t "session-instructions"`
Expected: FAIL — 404 on the route, and the three settings keys undefined.

- [x] **Step 3: Seed the defaults**

In `server/src/db/database.ts`, add to `DEFAULT_SETTINGS` after the `notify_sound` entry:

```ts
  /**
   * Settings › Sessions › INSTRUCTIONS (spec
   * 2026-09-30-session-instructions-design § 4). The two switches are
   * default-on, read server-side as `!== 'false'`; the text is appended to
   * every session Orbital starts, trimmed at compose time and stored as
   * typed. No cap: it is the user's own prompt on their own machine.
   */
  session_instructions_tips: 'true',
  session_instructions_custom: 'true',
  session_instructions_custom_text: '',
```

- [x] **Step 4: Add the route**

In `server/src/api/routes.ts`, import at the top:

```ts
import { SESSION_TIPS } from '../runner/sessionInstructions.js';
```

and after the `app.patch('/api/settings', …)` handler:

```ts
  // Settings › Sessions › INSTRUCTIONS reads the tip list from here, never
  // from a copy in the web bundle: the preview must show what the running
  // server sends (spec 2026-09-30-session-instructions-design § 4).
  app.get('/api/session-instructions/tips', () => ({ tips: SESSION_TIPS }));
```

- [x] **Step 5: Run the tests and the typecheck**

Run: `cd /Users/tomin/Projects/slothworks/orbital && npm run typecheck -w server && npm test -w server -- routes -t "session-instructions"`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
cd /Users/tomin/Projects/slothworks/orbital
git add server/src/db/database.ts server/src/api/routes.ts server/test/routes.test.ts
git commit -m "feat(server): instruction settings rows and the tips route"
```

---

### Task 4: The Settings rows

**Files:**
- Modify: `web/src/lib/api.ts` — the `// Settings API` block (~line 688–696) and the exported types beside `ServerHealth`
- Modify: `web/src/panels/Settings.tsx` — state near the top of `Settings()` (~line 379–400), the debounce effects (~line 596–607), the health fetch effect (~line 612–631), and the *Sessions* section after the last `CLEAR & LIFECYCLE` row (~line 1689–1735)

**Interfaces:**
- Consumes: `GET /api/session-instructions/tips` from Task 3; keys from Task 3.
- Produces: `api.getSessionInstructionTips(): Promise<{ tips: SessionTip[] }>`; `export interface SessionTip { id: string; title: string; text: string }` in `web/src/lib/api.ts`.

- [x] **Step 1: Add the API call**

In `web/src/lib/api.ts`, next to `ServerHealth`, add:

```ts
/** One of Orbital's shipped tips, as `GET /api/session-instructions/tips` returns it. */
export interface SessionTip {
  id: string
  title: string
  text: string
}
```

and in the `// Settings API` block, after `patchSettings`:

```ts
  /**
   * Orbital's tips for Settings › Sessions › INSTRUCTIONS. Fetched from the
   * server rather than bundled, so the preview shows what the running
   * server appends (spec 2026-09-30-session-instructions-design § 4).
   */
  async getSessionInstructionTips(): Promise<{ tips: SessionTip[] }> {
    return request<{ tips: SessionTip[] }>('GET', '/api/session-instructions/tips')
  },
```

- [x] **Step 2: Add the state and effects to `Settings()`**

In `web/src/panels/Settings.tsx`:

1. Extend the `import { api, type ServerHealth } from '../lib/api'` line to `import { api, type ServerHealth, type SessionTip } from '../lib/api'`.
2. Extend the `import { Input } from '../ui/Input'` line to `import { Input, TextArea } from '../ui/Input'`.
3. After `const [claudeDirDraft, setClaudeDirDraft] = useState(settings.claude_directory ?? '')` add:

```tsx
  const [instructionsDraft, setInstructionsDraft] = useState(
    settings.session_instructions_custom_text ?? '',
  )
  /**
   * Orbital's tips, from the server. Null until the fetch lands and after a
   * failure: the list then simply does not draw, for the same reason
   * General's read-only rows wait for `/api/health` — a placeholder list
   * could be read as the real one.
   */
  const [tips, setTips] = useState<SessionTip[] | null>(null)
  const [tipsOpen, setTipsOpen] = useState(false)
```

4. After the `claude_directory` debounce effect (the one ending `}, [claudeDirDraft, open])`) add:

```tsx
  // And the fourth: Sessions' own instructions. Stored as typed — the
  // composer trims at compose time, so the field keeps showing what was
  // written (spec 2026-09-30-session-instructions-design § 3).
  useEffect(() => {
    if (!open) return
    if (instructionsDraft === (settings.session_instructions_custom_text ?? '')) return
    const timer = setTimeout(() => {
      void patchAndSet({ session_instructions_custom_text: instructionsDraft })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instructionsDraft, open])
```

5. After the health fetch effect (the one ending `}, [open])` right after `.catch(() => { /* rows stay unrendered … */ })`) add:

```tsx
  useEffect(() => {
    if (!open) return
    let live = true
    api
      .getSessionInstructionTips()
      .then((answer) => {
        if (live && answer) setTips(answer.tips)
      })
      .catch(() => {
        /* the list stays unrendered; see the state's comment */
      })
    return () => {
      live = false
    }
  }, [open])
```

6. In the effect that reseeds the drafts on open (~line 447, the one that calls `setClaudeDirDraft(settings.claude_directory ?? '')`), add beside it:

```tsx
    setInstructionsDraft(settings.session_instructions_custom_text ?? '')
```

- [x] **Step 3: Add the group to the Sessions section**

In the *Sessions* section, after the last `<Row>` under `CLEAR & LIFECYCLE` (the row whose closing `</Row>` precedes the section's `</>` at ~line 1735), add:

```tsx
                      <SectionLabel>INSTRUCTIONS</SectionLabel>
                      <Row
                        title="Orbital's tips"
                        desc="Short instructions every session Orbital starts receives, so the model uses what Orbital can show: choices as cards, clickable file paths, background tasks. Applies from the next start."
                      >
                        <Toggle
                          aria-label="Orbital's tips"
                          checked={instructionTips}
                          onChange={(checked) =>
                            void patchAndSet({ session_instructions_tips: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>
                      {tips && (
                        <div className="flex flex-col gap-3 border-t border-[rgba(150,205,255,.08)] py-[13px]">
                          <button
                            type="button"
                            aria-expanded={tipsOpen}
                            onClick={() => setTipsOpen((v) => !v)}
                            className="flex items-start gap-2.5 text-left"
                          >
                            <span
                              aria-hidden
                              className="mt-[1px] grid h-4 w-4 flex-none place-items-center text-[9px] text-[rgba(160,190,225,.7)] transition-transform duration-[180ms]"
                              style={{ transform: tipsOpen ? undefined : 'rotate(-90deg)' }}
                            >
                              ▾
                            </span>
                            <span className="flex-1">
                              <span className="flex items-center gap-2">
                                <span className="text-[13.5px] font-semibold text-text-bright">
                                  Show the tips
                                </span>
                                {!tipsOpen && (
                                  <span className="font-mono text-[10px] tracking-[0.1em] text-[rgba(160,190,225,.55)]">
                                    collapsed
                                  </span>
                                )}
                              </span>
                              <span className="mt-1 block text-[12px] leading-[1.5] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
                                The exact text the server appends. Read-only: to change a tip, turn
                                the layer off and write your own version below.
                              </span>
                            </span>
                          </button>
                          {tipsOpen && (
                            <ul
                              className="flex flex-col gap-3 rounded-[10px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.5)] px-5 py-4"
                              style={{ opacity: instructionTips ? 1 : 0.5 }}
                            >
                              {tips.map((tip) => (
                                <li key={tip.id}>
                                  <div className="text-[12.5px] font-semibold text-text-bright">{tip.title}</div>
                                  <div className="mt-1 text-[12px] leading-[1.5] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
                                    {tip.text}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                      <Row
                        title="Your instructions"
                        desc="Your own text, appended to every session Orbital starts, after the tips. Applies from the next start. For one project, use that project's CLAUDE.md instead."
                      >
                        <Toggle
                          aria-label="Your instructions"
                          checked={instructionCustom}
                          onChange={(checked) =>
                            void patchAndSet({ session_instructions_custom: checked ? 'true' : 'false' })
                          }
                        />
                      </Row>
                      <div className="border-t border-[rgba(150,205,255,.08)] py-[13px]">
                        <TextArea
                          aria-label="Your instructions text"
                          size="sm"
                          rows={5}
                          value={instructionsDraft}
                          onChange={(e) => setInstructionsDraft(e.target.value)}
                          placeholder="For example: answer in Czech, keep replies short…"
                          className="resize-y"
                        />
                      </div>
```

and, with the other derived booleans near `const confirmBeforeClear = …` (search for `confirm_before_clear` in the component body), add:

```tsx
  const instructionTips = settings.session_instructions_tips !== 'false'
  const instructionCustom = settings.session_instructions_custom !== 'false'
```

If the `<ul>` opacity and the `Row` border classes look off next to the *Default planet size* preview, copy that preview's exact class strings (~line 1340–1380) rather than inventing new ones — the constraint is no new colours.

- [x] **Step 4: Typecheck, lint and look at it**

Run: `cd /Users/tomin/Projects/slothworks/orbital && npm run typecheck -w web && npm run lint`
Expected: clean.

Then with `npm run dev` running, open Settings › Sessions and check, by eye: the `INSTRUCTIONS` kicker sits after `CLEAR & LIFECYCLE`; the tips row toggles; *Show the tips* expands to the three tips and dims when the toggle is off; typing in the field raises *saved · just now* about half a second after the last keystroke; reloading the page keeps the text and both toggles. Do not add tests for any of this (spec § 5).

- [x] **Step 5: Run the whole web suite**

Run: `cd /Users/tomin/Projects/slothworks/orbital && npm run test:run -w web`
Expected: PASS. If a Settings test in `web/src/test` mocks `api` with a fixed method list and now fails on `getSessionInstructionTips` being undefined, add it to that mock returning `Promise.resolve({ tips: [] })` — see `docs/decisions/test-api-mocks-derive-from-the-real-module.md` for how the mocks are built.

- [x] **Step 6: Commit**

```bash
cd /Users/tomin/Projects/slothworks/orbital
git add web/src/lib/api.ts web/src/panels/Settings.tsx
git commit -m "feat(web): Settings › Sessions › Instructions — Orbital's tips and your own text"
```

---

### Task 5: End-to-end check, docs, version question

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-session-instructions-design.md` — `status`
- Modify: `docs/superpowers/plans/2026-09-30-session-instructions.md` — `status`

- [x] **Step 1: Prove the appendix reaches a real session**

With `npm run dev` running and the tips on, put `Answer every message with the word ORBITAL-CHECK first.` in *Your instructions*, start a new session from the dialog with the prompt `Say hello.`, and confirm the reply begins with `ORBITAL-CHECK`. Then turn *Your instructions* off, start another session with the same prompt, and confirm the word is gone. Clear the field afterwards.

- [x] **Step 2: Full suite and validation**

Run: `cd /Users/tomin/Projects/slothworks/orbital && npm run typecheck && npm test && atlas validate`
Expected: all PASS, `atlas validate: all documents valid`. If the two server tests that break under Orbital's own env vars fail (see the session-env memory), run them outside the Orbital session or unset the `ORBITAL_*` variables first, and say so in the report.

- [x] **Step 3: Set the documents' status**

In both the spec and this plan, change `status: active` to `status: done`. Run `atlas validate` again.

- [x] **Step 4: Commit**

```bash
cd /Users/tomin/Projects/slothworks/orbital
git add docs/superpowers/specs/2026-09-30-session-instructions-design.md docs/superpowers/plans/2026-09-30-session-instructions.md
git commit -m "docs: session instructions spec and plan done"
```

- [x] **Step 5: Ask about the version**

Server and web both changed, so the DMG changes. Before reporting the work done, ask whether to bump `version` in `desktop/package.json`, proposing **minor** (a new user-facing setting and a new behaviour for every Orbital session, nothing breaking). Do not bump without an answer. Check `git status` first — other sessions edit this checkout, and a bump commit must carry only the version files.
