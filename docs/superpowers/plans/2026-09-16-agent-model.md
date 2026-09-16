---
id: 2026-09-16-agent-model
title: Agent model implementation plan
status: draft
type: plan
domain: sessions
related:
  - 2026-09-16-agent-model-design
  - models-come-from-the-sdk
tags:
  - models
  - sessions
---
# Agent model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a session's model visible and choosable everywhere Orbital shows a session — detail header, New session dialog, Settings and the map — with the model list and context-window sizes read from the Claude Agent SDK rather than hard-coded.

**Architecture:** A new `ModelCatalog` on the server probes `Query.supportedModels()` through a throwaway SDK query (no user message is ever sent, so no tokens are spent), caches the result in the `settings` table and serves it stale-while-revalidate from `GET /api/models`. Each session row gains a requested model and a resolved model; the resolved one is backfilled from transcripts by the indexer, so terminal sessions carry a model too. The web reads the catalog once at boot and derives every label, the context-bar denominator and the transcript's model dividers from it.

**Tech Stack:** Fastify + Drizzle/better-sqlite3 + `@anthropic-ai/claude-agent-sdk` 0.3.x on the server, React 19 + zustand + Tailwind 4 + react-three-fiber on the web, Vitest on both sides.

**Spec:** `docs/superpowers/specs/2026-09-16-agent-model-design.md`

## Global Constraints

- **Never hard-code a model list.** The only model names allowed in source are `'default'` (the row that is filtered out) and the `default_model` seed value `'sonnet'`.
- **`[…]` suffix rule.** Strip a trailing `[…]` from a model id when matching it to a **display name**; never when looking up a **context window**. Exact match or the 200 000 fallback.
- **The default context window is `200_000`,** used only when no catalog row matches.
- **New settings keys and defaults:** `default_model` = `sonnet`, `remember_model_per_project` = `true`, `map_show_model` = `true`.
- **Settings keys used as caches:** `models_catalog` (JSON array of raw `ModelInfo`), `model_context_windows` (JSON object, model id → tokens).
- **TDD.** Every task writes a failing test first, watches it fail, then implements. Commit at the end of each task.
- **Run from the repo root:** `npm test` (both workspaces), `npm run typecheck`. Single server file: `npx vitest run test/<file> -w server`. Single web file: `npx vitest run src/test/<file> -w web`.
- **Design source:** `Feature - Agent model.dc.html` on the Claude Design canvas, artboards `4a`, `4b`, `4c`, read through the `DesignSync` MCP. The copy of the canvas under `design/` is stale — do not read it.

---

### Task 1: Session rows learn which model ran

**Files:**
- Modify: `server/src/db/schema.ts:24` (after `permissionMode`)
- Modify: `server/src/types.ts:8-24` (`SessionRow`, `ChatMessage`)
- Modify: `server/src/transcript/parser.ts:5-11` (`TranscriptEntry`), `:62-95` (`extractMeta`), `:97-127` (`entriesToMessages`)
- Modify: `server/src/indexer/indexer.ts:55-80`
- Create: `server/drizzle/0001_<generated-name>.sql`
- Test: `server/test/parser.test.ts`, `server/test/indexer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sessions.model` / `sessions.resolved_model` columns; `SessionRow.model: string | null`, `SessionRow.resolved_model: string | null`; `ChatMessage.model?: string`; `extractMeta(...).model: string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/parser.test.ts`:

```ts
describe('model extraction', () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  it('extractMeta reports the last assistant model', () => {
    const text = [
      line({ type: 'user', timestamp: '2026-09-16T10:00:00Z', cwd: '/w', message: { role: 'user', content: 'hi' } }),
      line({ type: 'assistant', timestamp: '2026-09-16T10:00:01Z', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' }] } }),
      line({ type: 'assistant', timestamp: '2026-09-16T10:00:02Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'b' }] } }),
    ].join('\n');
    expect(extractMeta(parseTranscript(text)).model).toBe('claude-opus-5');
  });

  it('extractMeta ignores sidechain models', () => {
    const text = [
      line({ type: 'assistant', timestamp: '2026-09-16T10:00:01Z', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' }] } }),
      line({ type: 'assistant', isSidechain: true, timestamp: '2026-09-16T10:00:02Z', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'sub' }] } }),
    ].join('\n');
    expect(extractMeta(parseTranscript(text)).model).toBe('claude-sonnet-5');
  });

  it('extractMeta reports null when no assistant entry names a model', () => {
    const text = line({ type: 'user', timestamp: '2026-09-16T10:00:00Z', message: { role: 'user', content: 'hi' } });
    expect(extractMeta(parseTranscript(text)).model).toBeNull();
  });

  it('entriesToMessages carries the model on assistant messages only', () => {
    const entries = parseTranscript([
      line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }),
      line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'yo' }] } }),
    ].join('\n'));
    const messages = entriesToMessages(entries);
    expect(messages[0].model).toBeUndefined();
    expect(messages[1].model).toBe('claude-opus-5');
  });
});
```

Append to `server/test/indexer.test.ts` (follow the file's existing fixture helper for writing a transcript into a temp projects dir):

```ts
it('writes the transcript model into resolved_model', () => {
  const { db, projectsDir } = makeFixture();
  writeTranscript(projectsDir, 'proj', 'sess-model', [
    { type: 'user', timestamp: '2026-09-16T10:00:00Z', cwd: '/w/x', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', timestamp: '2026-09-16T10:00:01Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }] } },
  ]);
  indexProjects(db, projectsDir);
  const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'sess-model')).get() as SessionRow;
  expect(row.resolved_model).toBe('claude-opus-5');
});

it('does not erase a known resolved_model when the transcript has no assistant entry', () => {
  const { db, projectsDir } = makeFixture();
  writeTranscript(projectsDir, 'proj', 'sess-empty', [
    { type: 'user', timestamp: '2026-09-16T10:00:00Z', cwd: '/w/x', message: { role: 'user', content: 'hi' } },
  ]);
  db.insert(sessions)
    .values({ id: 'sess-empty', projectDir: 'proj', cwd: '/w/x', resolvedModel: 'claude-sonnet-5' })
    .onConflictDoUpdate({ target: sessions.id, set: { resolvedModel: 'claude-sonnet-5' } })
    .run();
  indexProjects(db, projectsDir);
  const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'sess-empty')).get() as SessionRow;
  expect(row.resolved_model).toBe('claude-sonnet-5');
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/parser.test.ts test/indexer.test.ts -w server`
Expected: FAIL — `model` is not a property of the `extractMeta` result, `resolvedModel` is not a column.

- [ ] **Step 3: Add the columns and regenerate the migration**

In `server/src/db/schema.ts`, inside `sessions`, directly after `permissionMode`:

```ts
    /** The model Orbital ASKED for — an SDK `value` such as `opus[1m]`. Null for terminal sessions. */
    model: text('model'),
    /** The model that actually ran, as the transcript/SDK reports it (`claude-opus-5`). */
    resolvedModel: text('resolved_model'),
```

In `server/src/types.ts`, add to `SessionRow` after `permission_mode`:

```ts
  model: string | null;
  resolved_model: string | null;
```

and to `ChatMessage`:

```ts
  /** Resolved model that produced this assistant message. Absent on user turns. */
  model?: string;
```

Generate the migration:

```bash
npm run db:generate -w server
```

Then append this to the **generated** `server/drizzle/0001_*.sql` (do not re-run the generator afterwards — the migrator hashes the file as it stands):

```sql
--> statement-breakpoint
UPDATE `sessions` SET `indexed_mtime` = 0;
```

The reset makes the indexer re-read every transcript once so `resolved_model` is backfilled for sessions that already exist. Same one-shot trick the title cleanup in `indexer.ts` already uses.

- [ ] **Step 4: Teach the parser about models**

In `server/src/transcript/parser.ts`, widen the entry type:

```ts
  message?: { role: string; model?: string; content: string | Array<Record<string, unknown>> };
```

In `extractMeta`, declare `let model: string | null = null;` beside `let cwd = '';`, and inside the loop — after the `isSidechain` guard — add:

```ts
    if (e.type === 'assistant' && typeof e.message?.model === 'string' && e.message.model) {
      model = e.message.model;
    }
```

Return it: `return { cwd, title: title || fallbackTitle, firstAt, lastAt, messageCount, model };`

In `entriesToMessages`, replace the `base` constant with:

```ts
    const base =
      e.type === 'assistant' && typeof e.message.model === 'string' && e.message.model
        ? { timestamp: e.timestamp, model: e.message.model }
        : { timestamp: e.timestamp };
```

- [ ] **Step 5: Persist it from the indexer**

In `server/src/indexer/indexer.ts`, add `resolvedModel: meta.model` to the `.values({…})` object, and to the `onConflictDoUpdate` `set` object add:

```ts
              // A transcript whose assistant turns haven't been written yet
              // reports null; that must not erase what the runner already
              // recorded for a live web session.
              resolvedModel: sql`COALESCE(${meta.model ?? null}, ${sessions.resolvedModel})`,
```

- [ ] **Step 6: Run the tests and the type check**

Run: `npx vitest run test/parser.test.ts test/indexer.test.ts -w server && npm run typecheck -w server`
Expected: PASS. Other server tests referencing `SessionRow` may need the two new fields in their fixtures — fix any that fail with `npm test -w server`.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/schema.ts server/src/types.ts server/src/transcript/parser.ts server/src/indexer/indexer.ts server/drizzle server/test
git commit -m "feat(models): record the model each session ran on"
```

---

### Task 2: The model catalog

**Files:**
- Create: `server/src/models/catalog.ts`
- Modify: `server/src/runner/runner.ts:38-41` (`QueryFn`)
- Test: `server/test/catalog.test.ts` (create)

**Interfaces:**
- Consumes: `QueryFn` from `server/src/runner/runner.ts`.
- Produces:
  - `interface OrbitalModel { value: string; resolvedModel: string; family: string; version: string; blurb: string; contextWindow: number | null }`
  - `shapeModels(raw: ModelInfoLike[], contextWindows: Record<string, number>): OrbitalModel[]`
  - `extractContextWindows(modelUsage: unknown): Record<string, number>`
  - `class ModelCatalog { constructor(deps: { settings: SettingsStore; queryFn: QueryFn; cwd?: string }); list(): Promise<OrbitalModel[]>; recordContextWindows(modelUsage: unknown): void }`
  - `const CATALOG_KEY = 'models_catalog'`, `const CONTEXT_WINDOWS_KEY = 'model_context_windows'`

- [ ] **Step 1: Write the failing test**

Create `server/test/catalog.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  ModelCatalog,
  shapeModels,
  extractContextWindows,
  CATALOG_KEY,
  CONTEXT_WINDOWS_KEY,
} from '../src/models/catalog.js';

/** The five rows the SDK actually served on 2026-09-16. */
const RAW = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
];

function fakeSettings(seed: Record<string, string> = {}) {
  const store = { ...seed };
  return {
    store,
    get: (k: string) => store[k] ?? '',
    set: (k: string, v: string) => { store[k] = v; },
  };
}

/** A query object that answers supportedModels and records its own closing. */
function fakeQueryFn(models: unknown[] = RAW) {
  const closed = { count: 0 };
  const fn = vi.fn(() => {
    const gen: any = (async function* () {})();
    gen.supportedModels = async () => models;
    const originalReturn = gen.return.bind(gen);
    gen.return = async (v: unknown) => { closed.count += 1; return originalReturn(v); };
    return gen;
  });
  return { fn, closed };
}

describe('shapeModels', () => {
  it('drops the default alias row', () => {
    expect(shapeModels(RAW, {}).map((m) => m.value)).not.toContain('default');
  });

  it('keeps one row per resolved model', () => {
    const resolved = shapeModels(RAW, {}).map((m) => m.resolvedModel);
    expect(new Set(resolved).size).toBe(resolved.length);
    expect(resolved).toHaveLength(4);
  });

  it('splits display name and description into family, version and blurb', () => {
    const opus = shapeModels(RAW, {}).find((m) => m.value === 'opus[1m]')!;
    expect(opus.family).toBe('Opus');
    expect(opus.version).toBe('Opus 5 with 1M context');
    expect(opus.blurb).toBe('Best for everyday, complex tasks');
  });

  it('falls back to the family when the description has no separator', () => {
    const shaped = shapeModels(
      [{ value: 'x', resolvedModel: 'claude-x', displayName: 'Ex', description: 'Just a blurb' }],
      {},
    );
    expect(shaped[0].version).toBe('Ex');
    expect(shaped[0].blurb).toBe('Just a blurb');
  });

  it('attaches a context window only on an exact resolved-model match', () => {
    const shaped = shapeModels(RAW, { 'claude-sonnet-5': 200_000, 'claude-opus-5': 200_000 });
    expect(shaped.find((m) => m.value === 'sonnet')!.contextWindow).toBe(200_000);
    // 'claude-opus-5' must NOT satisfy 'claude-opus-5[1m]'.
    expect(shaped.find((m) => m.value === 'opus[1m]')!.contextWindow).toBeNull();
  });
});

describe('extractContextWindows', () => {
  it('keeps positive numeric windows and nothing else', () => {
    expect(
      extractContextWindows({
        'claude-opus-5[1m]': { contextWindow: 1_000_000, outputTokens: 5 },
        'claude-sonnet-5': { contextWindow: 0 },
        broken: { contextWindow: 'lots' },
        alsoBroken: null,
      }),
    ).toEqual({ 'claude-opus-5[1m]': 1_000_000 });
  });

  it('tolerates junk', () => {
    expect(extractContextWindows(undefined)).toEqual({});
    expect(extractContextWindows('nope')).toEqual({});
  });
});

describe('ModelCatalog', () => {
  it('probes, persists the raw list and closes the query', async () => {
    const settings = fakeSettings();
    const { fn, closed } = fakeQueryFn();
    const catalog = new ModelCatalog({ settings, queryFn: fn as never, cwd: '/w' });

    const models = await catalog.list();

    expect(models.map((m) => m.value)).toEqual(['opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku']);
    expect(JSON.parse(settings.store[CATALOG_KEY])).toHaveLength(5);
    expect(closed.count).toBe(1);
  });

  it('serves the stored list without waiting for a probe', async () => {
    const settings = fakeSettings({ [CATALOG_KEY]: JSON.stringify(RAW) });
    const { fn } = fakeQueryFn();
    const catalog = new ModelCatalog({ settings, queryFn: fn as never });

    const models = await catalog.list();

    expect(models).toHaveLength(4);
    // The refresh runs in the background; the answer did not depend on it.
    await catalog.refresh();
    expect(fn).toHaveBeenCalled();
  });

  it('keeps the stored list when the probe fails', async () => {
    const settings = fakeSettings({ [CATALOG_KEY]: JSON.stringify(RAW) });
    const failing = vi.fn(() => {
      const gen: any = (async function* () {})();
      gen.supportedModels = async () => { throw new Error('offline'); };
      return gen;
    });
    const catalog = new ModelCatalog({ settings, queryFn: failing as never });

    await catalog.refresh();

    expect(await catalog.list()).toHaveLength(4);
  });

  it('returns an empty list when the probe fails and nothing is stored', async () => {
    const settings = fakeSettings();
    const failing = vi.fn(() => {
      const gen: any = (async function* () {})();
      gen.supportedModels = async () => { throw new Error('offline'); };
      return gen;
    });
    const catalog = new ModelCatalog({ settings, queryFn: failing as never });

    expect(await catalog.list()).toEqual([]);
  });

  it('learns context windows from turn usage and merges them', async () => {
    const settings = fakeSettings({ [CATALOG_KEY]: JSON.stringify(RAW) });
    const { fn } = fakeQueryFn();
    const catalog = new ModelCatalog({ settings, queryFn: fn as never });

    catalog.recordContextWindows({ 'claude-sonnet-5': { contextWindow: 200_000 } });
    catalog.recordContextWindows({ 'claude-opus-5[1m]': { contextWindow: 1_000_000 } });

    expect(JSON.parse(settings.store[CONTEXT_WINDOWS_KEY])).toEqual({
      'claude-sonnet-5': 200_000,
      'claude-opus-5[1m]': 1_000_000,
    });
    const models = await catalog.list();
    expect(models.find((m) => m.value === 'opus[1m]')!.contextWindow).toBe(1_000_000);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/catalog.test.ts -w server`
Expected: FAIL — `Cannot find module '../src/models/catalog.js'`.

- [ ] **Step 3: Widen `QueryFn`**

In `server/src/runner/runner.ts`, replace the `QueryFn` type with:

```ts
/**
 * The subset of the SDK's `Query` object Orbital uses. `supportedModels` and
 * `setModel` are optional because a fake in a test may implement only what
 * that test exercises — and because a CLI too old to answer a control
 * request must degrade to "unknown", never to a crash.
 */
export type QueryFn = (args: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => AsyncGenerator<any> & {
  interrupt?: () => Promise<void>;
  setModel?: (model?: string) => Promise<void>;
  supportedModels?: () => Promise<unknown[]>;
};
```

- [ ] **Step 4: Write the catalog**

Create `server/src/models/catalog.ts`:

```ts
import type { QueryFn } from '../runner/runner.js';

/** The fields of the SDK's `ModelInfo` Orbital reads. */
export interface ModelInfoLike {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
}

/** One model as every Orbital surface consumes it. */
export interface OrbitalModel {
  /** What gets sent to the SDK as `options.model` — e.g. `opus[1m]`. */
  value: string;
  /** Canonical wire id — e.g. `claude-opus-5[1m]`. */
  resolvedModel: string;
  /** Family alone, for the planet label — `Opus`. */
  family: string;
  /** Family plus version, for the detail badge and the picker — `Opus 5 with 1M context`. */
  version: string;
  /** One-line capability blurb. */
  blurb: string;
  /** Tokens, learned from turn usage. Null until a turn on this model has been seen. */
  contextWindow: number | null;
}

export interface SettingsStore {
  get(key: string): string;
  set(key: string, value: string): void;
}

export const CATALOG_KEY = 'models_catalog';
export const CONTEXT_WINDOWS_KEY = 'model_context_windows';

/**
 * Turns the SDK's rows into Orbital's. Two rules, both from
 * `docs/decisions/models-come-from-the-sdk.md`:
 *
 * - `default` is dropped. It resolves to the same model as a named row, and
 *   two cards for one model read as a bug. Orbital always sends an explicit
 *   model, so the alias is never needed.
 * - `contextWindow` is looked up by EXACT `resolvedModel`. `claude-opus-5`
 *   must not satisfy `claude-opus-5[1m]`: mislabelling a family is harmless,
 *   drawing a 200k session's usage against a 1M denominator is not.
 */
export function shapeModels(
  raw: ModelInfoLike[],
  contextWindows: Record<string, number>,
): OrbitalModel[] {
  const out: OrbitalModel[] = [];
  const seen = new Set<string>();
  for (const info of raw) {
    if (!info || typeof info.value !== 'string' || !info.value || info.value === 'default') continue;
    const resolvedModel =
      typeof info.resolvedModel === 'string' && info.resolvedModel ? info.resolvedModel : info.value;
    if (seen.has(resolvedModel)) continue;
    seen.add(resolvedModel);

    const displayName = String(info.displayName ?? info.value);
    const description = String(info.description ?? '');
    const family = displayName.split('(')[0].trim() || info.value;
    // "Opus 5 with 1M context · Best for everyday, complex tasks"
    const [head, ...rest] = description.split('·');
    const blurb = rest.join('·').trim();

    out.push({
      value: info.value,
      resolvedModel,
      family,
      version: blurb ? head.trim() : family,
      blurb: blurb || description.trim(),
      contextWindow: contextWindows[resolvedModel] ?? null,
    });
  }
  return out;
}

/** Picks the usable `contextWindow` figures out of a result message's `modelUsage`. */
export function extractContextWindows(modelUsage: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!modelUsage || typeof modelUsage !== 'object') return out;
  for (const [model, usage] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (!usage || typeof usage !== 'object') continue;
    const value = (usage as Record<string, unknown>).contextWindow;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[model] = value;
  }
  return out;
}

/**
 * Serves the list of models the installed CLI offers.
 *
 * The list is only reachable through a live `Query`, so this spawns one whose
 * prompt stream never yields: the CLI sits on stdin, answers the control
 * request, and is closed again. No user message is ever sent, so the probe
 * costs about a second of process time and zero tokens. Measured at ~1.0 s
 * against SDK 0.3.272.
 *
 * `list()` answers from the persisted copy and refreshes behind the request,
 * so only the very first run ever waits — and a failed probe leaves the last
 * good list standing rather than emptying the pickers.
 */
export class ModelCatalog {
  private settings: SettingsStore;
  private queryFn: QueryFn;
  private cwd: string;
  private refreshing: Promise<void> | null = null;

  constructor(deps: { settings: SettingsStore; queryFn: QueryFn; cwd?: string }) {
    this.settings = deps.settings;
    this.queryFn = deps.queryFn;
    this.cwd = deps.cwd ?? process.cwd();
  }

  async list(): Promise<OrbitalModel[]> {
    const stored = this.storedRaw();
    if (stored.length) {
      void this.refresh();
      return shapeModels(stored, this.contextWindows());
    }
    await this.refresh();
    return shapeModels(this.storedRaw(), this.contextWindows());
  }

  /** Merges what a turn reported into the stored model → context-window map. */
  recordContextWindows(modelUsage: unknown): void {
    const learned = extractContextWindows(modelUsage);
    if (!Object.keys(learned).length) return;
    const current = this.contextWindows();
    let changed = false;
    for (const [model, tokens] of Object.entries(learned)) {
      if (current[model] !== tokens) {
        current[model] = tokens;
        changed = true;
      }
    }
    if (changed) this.settings.set(CONTEXT_WINDOWS_KEY, JSON.stringify(current));
  }

  /** Re-probes. Concurrent callers share one probe; never rejects. */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.probe()
        .then((models) => {
          if (models.length) this.settings.set(CATALOG_KEY, JSON.stringify(models));
        })
        .catch((err) => {
          // Offline, logged out, CLI missing — all mean "keep what we have".
          console.warn('orbital: model probe failed:', err);
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  private storedRaw(): ModelInfoLike[] {
    return this.readJson<ModelInfoLike[]>(CATALOG_KEY, []);
  }

  private contextWindows(): Record<string, number> {
    return this.readJson<Record<string, number>>(CONTEXT_WINDOWS_KEY, {});
  }

  private readJson<T>(key: string, fallback: T): T {
    try {
      const raw = this.settings.get(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as T;
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async probe(): Promise<ModelInfoLike[]> {
    // Never yields, so the CLI parks on stdin and no turn is ever billed.
    async function* silent(): AsyncGenerator<never> {
      await new Promise<never>(() => {});
    }
    const q = this.queryFn({
      prompt: silent(),
      options: { cwd: this.cwd, permissionMode: 'plan' },
    });
    try {
      const models = await q.supportedModels?.();
      return Array.isArray(models) ? (models as ModelInfoLike[]) : [];
    } finally {
      // `Query extends AsyncGenerator`, so return() is how it is closed.
      // Verified against SDK 0.3.272: the child exits and the event loop
      // is not held open.
      try {
        await q.return?.(undefined as never);
      } catch {
        // The probe process is done with either way.
      }
    }
  }
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/catalog.test.ts -w server && npm run typecheck -w server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/models server/src/runner/runner.ts server/test/catalog.test.ts
git commit -m "feat(models): catalog that probes the SDK and learns context windows"
```

---

### Task 3: Serve the catalog and feed it from turns

**Files:**
- Modify: `server/src/api/routes.ts:25-31` (`RouteContext`), and add the route beside `GET /api/settings`
- Modify: `server/src/runner/runner.ts` (constructor deps, `pump`)
- Modify: `server/src/index.ts:123-129` (Runner construction), `registerRoutes` call
- Test: `server/test/routes.test.ts`, `server/test/runner.test.ts`

**Interfaces:**
- Consumes: `ModelCatalog` from Task 2.
- Produces: `RouteContext.models: ModelCatalog`; `GET /api/models` → `{ models: OrbitalModel[] }`; `Runner` dep `onTurnUsage?: (modelUsage: unknown) => void`.

- [ ] **Step 1: Write the failing tests**

In `server/test/routes.test.ts`, extend `makeApp()` to pass a catalog stub and return it:

```ts
  const modelCatalog = {
    list: async () => [
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', blurb: 'Efficient', contextWindow: 200_000 },
    ],
    recordContextWindows: () => {},
  };
```

pass `models: modelCatalog as any` into `registerRoutes`, add `modelCatalog` to the returned object, and add the test:

```ts
it('GET /api/models serves the catalog', async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: 'GET', url: '/api/models' });
  expect(res.statusCode).toBe(200);
  expect(res.json().models[0]).toMatchObject({ value: 'sonnet', family: 'Sonnet', contextWindow: 200_000 });
});
```

In `server/test/runner.test.ts`:

```ts
it('hands each turn result modelUsage to its consumer', async () => {
  const hub = new Hub();
  const seen: unknown[] = [];
  const { fn } = fakeQueryFnWithModelUsage();
  const runner = new Runner({ hub, queryFn: fn, onTurnUsage: (u) => seen.push(u) });
  await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'acceptEdits' });
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0]).toEqual({ 'claude-sonnet-5': { contextWindow: 200_000 } });
});
```

with a fake beside the existing `fakeQueryFn`:

```ts
/** Like fakeQueryFn, but its result message also carries modelUsage. */
function fakeQueryFnWithModelUsage() {
  const fn = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    const sid = sessionIdOf(options);
    async function* gen() {
      for await (const _msg of prompt) {
        yield {
          type: 'result', subtype: 'success', session_id: sid,
          usage: { output_tokens: 5 },
          modelUsage: { 'claude-sonnet-5': { contextWindow: 200_000 } },
        };
      }
    }
    return gen() as any;
  };
  return { fn };
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/routes.test.ts test/runner.test.ts -w server`
Expected: FAIL — 404 on `/api/models`, and `onTurnUsage` is not a `Runner` dependency.

- [ ] **Step 3: Add the route**

In `server/src/api/routes.ts`, import the type and extend the context:

```ts
import type { ModelCatalog } from '../models/catalog.js';
```

```ts
export interface RouteContext {
  db: OrbitalDb;
  registry: SessionRegistry;
  runner: Runner;
  projectsDir: string;
  hub: Hub;
  models: ModelCatalog;
  settings: { get(key: string): string; set(key: string, value: string): void };
}
```

Add the route immediately above `GET /api/settings`:

```ts
  app.get('/api/models', async () => ({ models: await ctx.models.list() }));
```

- [ ] **Step 4: Report turn usage from the Runner**

In `server/src/runner/runner.ts`, add to the constructor deps type and the class:

```ts
    /** Receives each turn result's `modelUsage`, which is where context-window sizes come from. */
    onTurnUsage?: (modelUsage: unknown) => void;
```

```ts
  private onTurnUsage?: (modelUsage: unknown) => void;
```

assign it in the constructor (`this.onTurnUsage = deps.onTurnUsage;`), and in `pump`'s `result` branch, directly after the existing `hub.publish(...'turn_result'...)` line:

```ts
          this.onTurnUsage?.(msg.modelUsage);
```

- [ ] **Step 5: Wire it up in index.ts**

In `server/src/index.ts`, import the catalog and build it before the Runner:

```ts
import { ModelCatalog } from './models/catalog.js';
```

```ts
  const settingsStore = {
    get: (key: string) =>
      db.select({ value: settingsTable.value }).from(settingsTable)
        .where(eq(settingsTable.key, key)).get()?.value ?? '',
    set: (key: string, value: string) =>
      void db.insert(settingsTable).values({ key, value })
        .onConflictDoUpdate({ target: settingsTable.key, set: { value } }).run(),
  };

  const models = new ModelCatalog({
    settings: settingsStore,
    queryFn: overrides.queryFn ?? ((await import('@anthropic-ai/claude-agent-sdk')).query as unknown as QueryFn),
    cwd: process.cwd(),
  });
```

Pass `onTurnUsage: (modelUsage) => models.recordContextWindows(modelUsage)` into the `new Runner({…})` call, and `models` into the `registerRoutes(app, {…})` call. If `index.ts` already builds an inline settings accessor for `registerRoutes`, replace it with `settingsStore` rather than keeping two.

- [ ] **Step 6: Run the tests**

Run: `npm test -w server && npm run typecheck -w server`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src server/test
git commit -m "feat(models): GET /api/models and context windows learned from turns"
```

---

### Task 4: A session carries its model over the wire

**Files:**
- Modify: `server/src/api/shape.ts:22-31` (`ApiSession`), `:47-57` (`toApiSession`)
- Modify: `server/src/api/routes.ts` (`POST /api/sessions`, the revive branch of `POST /:id/messages`, `POST /:id/clear`)
- Modify: `server/src/runner/runner.ts` (`onInit` dep, `pump`, `sdkToChatMessages`)
- Modify: `server/src/db/database.ts:14-31` (`DEFAULT_SETTINGS`)
- Modify: `server/src/index.ts` (wire `onInit`)
- Test: `server/test/routes.test.ts`, `server/test/runner.test.ts`

**Interfaces:**
- Consumes: Task 1's columns, Task 3's `RouteContext.models`.
- Produces: `ApiSession.model: string | null`, `ApiSession.resolvedModel: string | null`; `Runner` dep `onInit?: (sessionId: string, model: string | null) => void`; settings keys `default_model`, `remember_model_per_project`, `map_show_model`.

- [ ] **Step 1: Write the failing tests**

In `server/test/routes.test.ts`:

```ts
it('stores the requested model when launching a session', async () => {
  const { app, db, startCalls } = makeApp();
  const res = await app.inject({
    method: 'POST', url: '/api/sessions',
    payload: { cwd: '/w/z', prompt: 'go', permissionMode: 'acceptEdits', model: 'opus[1m]' },
  });
  expect(res.statusCode).toBe(201);
  expect(startCalls[0].model).toBe('opus[1m]');
  const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'web-9')).get() as SessionRow;
  expect(row.model).toBe('opus[1m]');
});

it('exposes model and resolvedModel on the API shape', async () => {
  const { app, db } = makeApp();
  db.update(sessions).set({ model: 'sonnet', resolvedModel: 'claude-sonnet-5' }).where(eq(sessions.id, 's1')).run();
  const res = await app.inject({ method: 'GET', url: '/api/sessions/s1' });
  expect(res.json().session).toMatchObject({ model: 'sonnet', resolvedModel: 'claude-sonnet-5' });
});

it('revives a session on the model it was launched with', async () => {
  const { app, db, startCalls } = makeApp();
  db.update(sessions).set({ model: 'haiku' }).where(eq(sessions.id, 's2')).run();
  await app.inject({ method: 'POST', url: '/api/sessions/s2/messages', payload: { text: 'again' } });
  expect(startCalls[0]).toMatchObject({ resume: 's2', model: 'haiku' });
});

it('clear + startNew uses the settings default model, not the parent one', async () => {
  const { app, db, startCalls } = makeApp();
  db.update(sessions).set({ model: 'haiku', source: 'web' }).where(eq(sessions.id, 's2')).run();
  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { default_model: 'sonnet' } });
  await app.inject({ method: 'POST', url: '/api/sessions/s2/clear', payload: { startNew: true } });
  expect(startCalls[0].model).toBe('sonnet');
  const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'web-9')).get() as SessionRow;
  expect(row.model).toBe('sonnet');
});
```

In `server/test/runner.test.ts`:

```ts
it('reports the resolved model from system/init', async () => {
  const hub = new Hub();
  const seen: Array<[string, string | null]> = [];
  const fn = ({ prompt, options }: any) => {
    const sid = options.sessionId ?? options.resume;
    async function* gen() {
      for await (const _m of prompt) {
        yield { type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5' };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    return gen() as any;
  };
  const runner = new Runner({ hub, queryFn: fn, onInit: (id, model) => seen.push([id, model]) });
  const id = await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'acceptEdits' });
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0]).toEqual([id, 'claude-opus-5']);
});

it('carries the model on assistant chat messages', () => {
  const msgs = sdkToChatMessages(
    { type: 'assistant', session_id: 's', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }] } },
    (() => { let n = 0; return () => ++n; })(),
  );
  expect(msgs[0].model).toBe('claude-opus-5');
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/routes.test.ts test/runner.test.ts -w server`
Expected: FAIL — `model` missing on the row and on the API shape, `onInit` unknown, `sdkToChatMessages` drops the model.

- [ ] **Step 3: Extend the API shape**

In `server/src/api/shape.ts`, add to `ApiSession` after `permissionMode`:

```ts
  /** The model Orbital asked for (an SDK `value`), or null. */
  model: string | null;
  /** The model that actually ran, as reported by the CLI, or null. */
  resolvedModel: string | null;
```

and to the object `toApiSession` returns:

```ts
    model: row.model, resolvedModel: row.resolved_model,
```

- [ ] **Step 4: Write the model on every creation path**

In `server/src/api/routes.ts`:

`POST /api/sessions` — add `model: body.model ?? null` to the `.values({…})` object.

The revive branch of `POST /api/sessions/:id/messages` — replace the `start` call with:

```ts
      await ctx.runner.start({
        cwd: row.cwd, prompt: text, permissionMode, resume: id,
        // Without this, reviving silently moved the session onto the CLI's
        // default model.
        model: row.model ?? undefined,
      });
```

`POST /api/sessions/:id/clear` — after `permissionMode` is computed:

```ts
    // 4c: the default model is "used by Clear". Deliberately unlike
    // permission mode, there is no inherit toggle — the canvas does not ask
    // for one.
    const model = ctx.settings.get('default_model') || undefined;
```

pass `model` into `ctx.runner.start({ cwd: row.cwd, prompt: '', permissionMode, model })` and add `model: model ?? null` to the new row's `.values({…})`.

- [ ] **Step 5: Report the resolved model from the Runner**

In `server/src/runner/runner.ts`, add the dep (type + field + constructor assignment):

```ts
    /** Receives the resolved model a session actually started on (`system/init`). */
    onInit?: (sessionId: string, model: string | null) => void;
```

In `pump`, add a branch before the `assistant | user` one:

```ts
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.onInit?.(sessionId, typeof msg.model === 'string' ? msg.model : null);
          continue;
        }
```

In `sdkToChatMessages`, capture the model once and attach it to assistant text blocks:

```ts
  const model = typeof sdkMsg.message?.model === 'string' ? sdkMsg.message.model : undefined;
```

then in the `text` branch:

```ts
      out.push({
        id,
        role: sdkMsg.type === 'user' ? 'user' : 'assistant',
        text: block.text,
        ...(sdkMsg.type === 'user' ? {} : { model }),
      });
```

- [ ] **Step 6: Wire `onInit` and seed the new settings**

In `server/src/index.ts`, add to the `new Runner({…})` call:

```ts
    onInit: (sessionId, model) => {
      if (!model) return;
      db.update(sessions).set({ resolvedModel: model }).where(eq(sessions.id, sessionId)).run();
      const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, sessionId)).get() as SessionRow | undefined;
      if (row) hub.publish('sessions', { event: 'upsert', session: toApiSession({ db, registry, runner }, row) });
    },
```

`runner` is referenced inside its own constructor argument, so declare it with `let runner: Runner;` above and assign `runner = new Runner({…})` — the callback only ever fires after construction.

In `server/src/db/database.ts`, add to `DEFAULT_SETTINGS`:

```ts
  /** Pre-selected in the New session dialog and used by Clear (canvas 4c). A
   * value the catalog does not offer falls back to its first row, client-side. */
  default_model: 'sonnet',
  remember_model_per_project: 'true',
  map_show_model: 'true',
```

- [ ] **Step 7: Run the tests**

Run: `npm test -w server && npm run typecheck -w server`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src server/test
git commit -m "feat(models): carry the session model through the API and every launch path"
```

---

### Task 5: Switch a session's model

**Files:**
- Modify: `server/src/runner/runner.ts` (add `setModel`)
- Modify: `server/src/api/routes.ts` (add `POST /api/sessions/:id/model`)
- Test: `server/test/runner.test.ts`, `server/test/routes.test.ts`

**Interfaces:**
- Consumes: Task 4's `ApiSession.model`, Task 2's widened `QueryFn`.
- Produces: `Runner.setModel(sessionId: string, model: string): Promise<void>` (throws `session <id> is not active`); `POST /api/sessions/:id/model` with body `{ model: string }` → `{ ok: true }`, `404`, or `409`.

- [ ] **Step 1: Write the failing tests**

In `server/test/runner.test.ts`:

```ts
it('setModel forwards to the live query', async () => {
  const hub = new Hub();
  const setModel = vi.fn(async () => {});
  const fn = ({ prompt, options }: any) => {
    const sid = options.sessionId ?? options.resume;
    async function* gen() { for await (const _m of prompt) { yield { type: 'result', subtype: 'success', session_id: sid, usage: {} }; } }
    const g = gen() as any;
    g.setModel = setModel;
    return g;
  };
  const runner = new Runner({ hub, queryFn: fn });
  const id = await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'acceptEdits' });
  await runner.setModel(id, 'haiku');
  expect(setModel).toHaveBeenCalledWith('haiku');
});

it('setModel throws for a session it does not run', async () => {
  const runner = new Runner({ hub: new Hub(), queryFn: fakeQueryFn().fn });
  await expect(runner.setModel('nope', 'haiku')).rejects.toThrow('not active');
});
```

In `server/test/routes.test.ts` — note `makeApp()`'s `registry.get` answers only for `s1`, and its `runner.status()` returns `undefined`, so `s2` is the "ended" case:

```ts
it('switches the model of a live session', async () => {
  const { app, db, runner } = makeApp();
  const calls: Array<[string, string]> = [];
  (runner as any).setModel = async (id: string, model: string) => { calls.push([id, model]); };
  (runner as any).status = (id: string) => (id === 's2' ? 'needs_input' : undefined);
  const res = await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: { model: 'haiku' } });
  expect(res.statusCode).toBe(200);
  expect(calls).toEqual([['s2', 'haiku']]);
  const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
  expect(row.model).toBe('haiku');
});

it('records the model of an ended session without touching the runner', async () => {
  const { app, db, runner } = makeApp();
  let called = false;
  (runner as any).setModel = async () => { called = true; };
  const res = await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: { model: 'sonnet' } });
  expect(res.statusCode).toBe(200);
  expect(called).toBe(false);
  const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
  expect(row.model).toBe('sonnet');
});

it('refuses to switch a session that is live in a terminal', async () => {
  const { app, db } = makeApp();
  const res = await app.inject({ method: 'POST', url: '/api/sessions/s1/model', payload: { model: 'haiku' } });
  expect(res.statusCode).toBe(409);
  const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's1')).get() as SessionRow;
  expect(row.model).toBeNull();
});

it('404s for an unknown session', async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: 'POST', url: '/api/sessions/nope/model', payload: { model: 'haiku' } });
  expect(res.statusCode).toBe(404);
});

it('publishes an upsert after a switch', async () => {
  const { app, hub, runner } = makeApp();
  (runner as any).setModel = async () => {};
  const received = subscribeFake(hub, 'sessions');
  await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: { model: 'haiku' } });
  expect(received.at(-1).session).toMatchObject({ id: 's2', model: 'haiku' });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/runner.test.ts test/routes.test.ts -w server`
Expected: FAIL — `runner.setModel is not a function`, 404 on the new route.

- [ ] **Step 3: Implement `Runner.setModel`**

In `server/src/runner/runner.ts`, beside `interrupt`:

```ts
  /**
   * Changes the model for this session's next turn. The SDK keeps the
   * conversation — only what serves it changes — which is why the UI can
   * promise "context is kept".
   */
  async setModel(sessionId: string, model: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === 'ended') throw new Error(`session ${sessionId} is not active`);
    await s.generator?.setModel?.(model);
  }
```

- [ ] **Step 4: Implement the route**

In `server/src/api/routes.ts`, after `POST /api/sessions/:id/interrupt`:

```ts
  app.post('/api/sessions/:id/model', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { model } = req.body as { model: string };
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as
      | SessionRow
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    // A session the terminal owns is not ours to reconfigure — the same rule
    // that stops us from sending it messages.
    if (ctx.registry.get(id)) {
      return reply.code(409).send({ error: 'session is live in a terminal' });
    }
    if (ctx.runner.status(id) && ctx.runner.status(id) !== 'ended') {
      await ctx.runner.setModel(id, model);
    }
    // An ended session keeps the choice too: it is what the revive resumes on.
    db.update(sessions).set({ model }).where(eq(sessions.id, id)).run();
    const updated = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
    ctx.hub.publish('sessions', { event: 'upsert', session: toApiSession(ctx, updated) });
    return { ok: true };
  });
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w server && npm run typecheck -w server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src server/test
git commit -m "feat(models): switch a session's model from the next turn"
```

---

### Task 6: Projects remember their last model

**Files:**
- Modify: `server/src/api/routes.ts` (`GET /api/projects`)
- Test: `server/test/routes.test.ts`

**Interfaces:**
- Consumes: Task 1's columns.
- Produces: `GET /api/projects` → `{ projects: Array<{ cwd: string; lastModel: string | null }> }`.

- [ ] **Step 1: Write the failing test**

```ts
it('reports each project with the model its newest session used', async () => {
  const { app, db } = makeApp();
  db.update(sessions).set({ model: 'opus[1m]' }).where(eq(sessions.id, 's1')).run();
  db.update(sessions).set({ model: null, resolvedModel: 'claude-haiku-4-5-20251001' }).where(eq(sessions.id, 's2')).run();
  const res = await app.inject({ method: 'GET', url: '/api/projects' });
  expect(res.json().projects).toEqual([
    { cwd: '/w/x', lastModel: 'opus[1m]' },
    { cwd: '/w/y', lastModel: 'claude-haiku-4-5-20251001' },
  ]);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/routes.test.ts -w server`
Expected: FAIL — `projects` is an array of strings.

- [ ] **Step 3: Rewrite the endpoint**

```ts
  app.get('/api/projects', () => {
    // Reduced in JS rather than grouped in SQL: the answer needs a *column
    // from* the newest row per cwd, not an aggregate of it, and first-seen
    // over a lastAt-ordered scan is the same thing without a correlated
    // subquery.
    const rows = db
      .select({
        cwd: sessions.cwd,
        model: sessions.model,
        resolvedModel: sessions.resolvedModel,
      })
      .from(sessions)
      .where(ne(sessions.cwd, ''))
      .orderBy(desc(sessions.lastAt))
      .limit(500)
      .all();
    const projects: Array<{ cwd: string; lastModel: string | null }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.cwd)) continue;
      seen.add(row.cwd);
      projects.push({ cwd: row.cwd, lastModel: row.model ?? row.resolvedModel ?? null });
      if (projects.length === 50) break;
    }
    return { projects };
  });
```

Remove the now-unused `max` import if nothing else uses it.

- [ ] **Step 4: Run the tests**

Run: `npm test -w server && npm run typecheck -w server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/routes.ts server/test/routes.test.ts
git commit -m "feat(models): GET /api/projects reports each project's last model"
```

---

### Task 7: Web plumbing — types, client, store, helpers

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/format.ts`
- Create: `web/src/lib/models.ts`
- Modify: `web/src/store/store.ts:56-73` (`OrbitalState`), `:140-175` (`loadInitial`)
- Modify: `web/src/map/useSceneModel.ts` (the filler state object and the memo deps)
- Modify the api mock in all eight test files listed below
- Test: `web/src/test/models.test.ts` (create), `web/src/test/store.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6's endpoints.
- Produces:
  - `OrbitalModel` (same fields as the server's), `ApiSession.model`/`.resolvedModel`, `ChatMessage.model?`
  - `api.listModels(): Promise<OrbitalModel[]>`, `api.setSessionModel(id: string, model: string): Promise<{ ok: boolean }>`, `api.listProjects(): Promise<Array<{ cwd: string; lastModel: string | null }>>`
  - `useOrbital.getState().models: OrbitalModel[]`
  - `matchModel(session, models): OrbitalModel | undefined`, `contextWindowFor(session, models): number`, `modelByValue(value, models): OrbitalModel | undefined`, `DEFAULT_CONTEXT_WINDOW`
  - `formatContextWindow(n: number): string`

- [ ] **Step 1: Write the failing tests**

Create `web/src/test/models.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { matchModel, contextWindowFor, modelByValue, DEFAULT_CONTEXT_WINDOW } from '../lib/models'
import { formatContextWindow } from '../lib/format'
import type { ApiSession, OrbitalModel } from '../lib/types'

const MODELS: OrbitalModel[] = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', family: 'Opus', version: 'Opus 5 with 1M context', blurb: 'Best for everyday, complex tasks', contextWindow: 1_000_000 },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', blurb: 'Efficient for routine tasks', contextWindow: 200_000 },
]

const session = (over: Partial<ApiSession>): ApiSession => ({
  id: 's', cwd: '/w', title: 't', firstAt: null, lastAt: null, messageCount: 0,
  source: 'web', permissionMode: null, model: null, resolvedModel: null,
  parentId: null, tagIds: [], status: 'ended', ...over,
})

describe('matchModel', () => {
  it('matches the requested value first', () => {
    expect(matchModel(session({ model: 'sonnet' }), MODELS)?.family).toBe('Sonnet')
  })

  it('matches an exact resolved model', () => {
    expect(matchModel(session({ resolvedModel: 'claude-opus-5[1m]' }), MODELS)?.family).toBe('Opus')
  })

  it('matches a resolved model with the variant suffix stripped', () => {
    // The transcript writes `claude-opus-5` even for a `[1m]` session.
    expect(matchModel(session({ resolvedModel: 'claude-opus-5' }), MODELS)?.family).toBe('Opus')
  })

  it('returns undefined for an unknown model', () => {
    expect(matchModel(session({ resolvedModel: 'claude-something-9' }), MODELS)).toBeUndefined()
  })
})

describe('contextWindowFor', () => {
  it('uses the matched model window', () => {
    expect(contextWindowFor(session({ model: 'opus[1m]' }), MODELS)).toBe(1_000_000)
  })

  it('never widens a window through the stripped suffix', () => {
    // `claude-opus-5` is NOT `claude-opus-5[1m]`; guessing 1M here would draw
    // the bar at a fifth of its real fill.
    expect(contextWindowFor(session({ resolvedModel: 'claude-opus-5' }), MODELS)).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('falls back for a session with no model at all', () => {
    expect(contextWindowFor(session({}), MODELS)).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})

describe('modelByValue', () => {
  it('finds a row by its SDK value', () => {
    expect(modelByValue('sonnet', MODELS)?.family).toBe('Sonnet')
    expect(modelByValue(null, MODELS)).toBeUndefined()
  })
})

describe('formatContextWindow', () => {
  it('formats in the canvas notation', () => {
    expect(formatContextWindow(200_000)).toBe('200k')
    expect(formatContextWindow(1_000_000)).toBe('1M')
    expect(formatContextWindow(1_500_000)).toBe('1.5M')
  })
})
```

In `web/src/test/store.test.ts`, add to the `loadInitial` test group:

```ts
it('loads the model catalog', async () => {
  vi.mocked(api.listModels).mockResolvedValue([
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', blurb: 'Efficient', contextWindow: 200_000 },
  ])
  await useOrbital.getState().loadInitial()
  expect(useOrbital.getState().models).toHaveLength(1)
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/test/models.test.ts src/test/store.test.ts -w web`
Expected: FAIL — `Cannot find module '../lib/models'`, `api.listModels is not a function`.

- [ ] **Step 3: Extend the types**

In `web/src/lib/types.ts`, add to `ApiSession` after `permissionMode`:

```ts
  model: string | null;
  resolvedModel: string | null;
```

to `ChatMessage`:

```ts
  /** Resolved model that produced this assistant message. */
  model?: string;
```

and a new exported interface (same fields as the server's `OrbitalModel`):

```ts
export interface OrbitalModel {
  value: string;
  resolvedModel: string;
  family: string;
  version: string;
  blurb: string;
  contextWindow: number | null;
}
```

- [ ] **Step 4: Extend the API client**

In `web/src/lib/api.ts`, import `OrbitalModel`, change `listProjects` and add two methods:

```ts
  async listProjects(): Promise<Array<{ cwd: string; lastModel: string | null }>> {
    const data = await request<{ projects: Array<{ cwd: string; lastModel: string | null }> }>('GET', '/api/projects')
    return data.projects
  },

  async listModels(): Promise<OrbitalModel[]> {
    const data = await request<{ models: OrbitalModel[] }>('GET', '/api/models')
    return data.models
  },

  async setSessionModel(id: string, model: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', `/api/sessions/${id}/model`, { model })
  },
```

Add `OrbitalModel` to the re-export line at the bottom.

- [ ] **Step 5: Write the helpers**

Add to `web/src/lib/format.ts`:

```ts
/**
 * Context-window sizes as the model pickers print them — "200k", "1M".
 * Distinct from `formatTokens`: this formats a round budget, not a measured
 * count, so it never shows a decimal it does not need.
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}
```

Create `web/src/lib/models.ts`:

```ts
import type { ApiSession, OrbitalModel } from './types'

/**
 * Denominator for the context bar when nothing in the catalog matches. The
 * smallest window any current model has — so an unknown model's bar can read
 * as fuller than it is, never as emptier.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Drops a trailing variant suffix: `claude-opus-5[1m]` -> `claude-opus-5`. */
function stripVariant(id: string): string {
  return id.replace(/\[[^\]]*\]$/, '')
}

export function modelByValue(value: string | null | undefined, models: OrbitalModel[]): OrbitalModel | undefined {
  if (!value) return undefined
  return models.find((m) => m.value === value)
}

/**
 * The catalog row a session should be LABELLED with.
 *
 * The suffix-stripping third pass exists because the transcript records
 * `claude-opus-5` even for a session launched as `opus[1m]`, so a terminal
 * session would otherwise have no name at all. It is only ever used for
 * naming — `contextWindowFor` deliberately does not reuse it.
 */
export function matchModel(session: ApiSession, models: OrbitalModel[]): OrbitalModel | undefined {
  const byValue = modelByValue(session.model, models)
  if (byValue) return byValue
  const resolved = session.resolvedModel
  if (!resolved) return undefined
  return (
    models.find((m) => m.resolvedModel === resolved) ??
    models.find((m) => stripVariant(m.resolvedModel) === stripVariant(resolved))
  )
}

/**
 * Tokens the context bar is drawn against. Matches by requested value or by
 * EXACT resolved model only: `claude-opus-5` must not inherit
 * `claude-opus-5[1m]`'s 1M, because that would draw a full 200k session at
 * 20%. When in doubt, the honest 200k fallback.
 */
export function contextWindowFor(session: ApiSession, models: OrbitalModel[]): number {
  const exact =
    modelByValue(session.model, models) ??
    (session.resolvedModel ? models.find((m) => m.resolvedModel === session.resolvedModel) : undefined)
  return exact?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}
```

- [ ] **Step 6: Put the catalog in the store**

In `web/src/store/store.ts`, add `models: OrbitalModel[]` to `OrbitalState` (import the type), initialise it to `[]` beside `tags: []`, and extend `loadInitial`:

```ts
    const [sessions, tags, rules, settings, models] = await Promise.all([
      api.listSessions(),
      api.listTags(),
      api.listTagRules(),
      api.getSettings(),
      // Best-effort: a failed probe with nothing cached yields [], and every
      // surface that reads the catalog has an empty state for exactly that.
      api.listModels().catch(() => [] as OrbitalModel[]),
    ])
```

and add `models,` to the `set({…})` call.

In `web/src/map/useSceneModel.ts`, add `const models = useOrbital((s) => s.models)` beside the other selectors, `models,` to the filler state object, and `models` to the `useMemo` dependency array.

- [ ] **Step 7: Update every api mock**

These eight files mock the whole `api` object with `satisfies Record<keyof typeof actual.api, unknown>`, so each needs `listModels: vi.fn()` and `setSessionModel: vi.fn()` added:

`web/src/test/settings.test.tsx`, `detail.test.tsx`, `sidebar.test.tsx`, `store.test.ts`, `tagsrules.test.tsx`, `app.test.tsx`, `transcript.test.tsx`, `newsession.test.tsx`.

Any `resetStore` helper that spreads a full `OrbitalState` also needs `models: []`, and any `ApiSession` fixture needs `model: null, resolvedModel: null`. Any test that mocks `listProjects` with `['...']` now needs `[{ cwd: '...', lastModel: null }]`.

- [ ] **Step 8: Run the whole web suite**

Run: `npm run test:run -w web && npm run typecheck -w web`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src
git commit -m "feat(models): web plumbing for the model catalog"
```

---

### Task 8: The `ModelCards` primitive

**Files:**
- Create: `web/src/ui/ModelCards.tsx`
- Test: `web/src/test/modelcards.test.tsx` (create)

**Interfaces:**
- Consumes: `OrbitalModel`, `formatContextWindow`.
- Produces: `<ModelCards models value onChange defaultValue? compact? disabled? />` where `value: string | null` and `onChange: (value: string) => void`.

- [ ] **Step 1: Write the failing test**

Create `web/src/test/modelcards.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModelCards } from '../ui/ModelCards'
import type { OrbitalModel } from '../lib/types'

const MODELS: OrbitalModel[] = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', family: 'Opus', version: 'Opus 5 with 1M context', blurb: 'Best for everyday, complex tasks', contextWindow: 1_000_000 },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', blurb: 'Efficient for routine tasks', contextWindow: 200_000 },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', family: 'Haiku', version: 'Haiku 4.5', blurb: 'Fastest for quick answers', contextWindow: null },
]

describe('ModelCards', () => {
  it('renders one radio per model, marked by version', () => {
    render(<ModelCards models={MODELS} value="sonnet" onChange={() => {}} />)
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name: /Opus 5 with 1M context/ })).toBeInTheDocument()
  })

  it('marks the selected model', () => {
    render(<ModelCards models={MODELS} value="sonnet" onChange={() => {}} />)
    expect(screen.getByRole('radio', { name: /Sonnet 5/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('shows the context window when known and nothing when not', () => {
    render(<ModelCards models={MODELS} value="sonnet" onChange={() => {}} />)
    expect(screen.getByText('1M CTX')).toBeInTheDocument()
    expect(screen.getByText('200K CTX')).toBeInTheDocument()
    expect(screen.queryByText(/null/i)).not.toBeInTheDocument()
  })

  it('marks the settings default', () => {
    render(<ModelCards models={MODELS} value="opus[1m]" defaultValue="sonnet" onChange={() => {}} />)
    expect(screen.getByText('DEFAULT')).toBeInTheDocument()
  })

  it('reports the chosen value', () => {
    const onChange = vi.fn()
    render(<ModelCards models={MODELS} value="sonnet" onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: /Haiku 4.5/ }))
    expect(onChange).toHaveBeenCalledWith('haiku')
  })

  it('explains itself when the catalog is empty', () => {
    render(<ModelCards models={[]} value={null} onChange={() => {}} />)
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/test/modelcards.test.tsx -w web`
Expected: FAIL — `Cannot find module '../ui/ModelCards'`.

- [ ] **Step 3: Write the component**

Create `web/src/ui/ModelCards.tsx`:

```tsx
import { formatContextWindow } from '../lib/format'
import type { OrbitalModel } from '../lib/types'

export interface ModelCardsProps {
  models: OrbitalModel[]
  /** SDK `value` of the selected model, or null when nothing is chosen yet. */
  value: string | null
  onChange: (value: string) => void
  /** SDK `value` of the Settings default — marked `DEFAULT` when it is not the selection. */
  defaultValue?: string | null
  disabled?: boolean
  /** Settings variant (canvas 4c): family + one word, no blurb, no context line. */
  compact?: boolean
}

/**
 * Selectable model cards, shared between `NewSessionDialog` (canvas 4b) and
 * `Settings` (4c) — the same "build it once" arrangement `ui/ModeCards.tsx`
 * uses for permission modes.
 *
 * The grid is `auto-fit`, not the canvas's fixed four columns: the list comes
 * from the SDK, so a fifth model must wrap rather than overflow.
 *
 * 4b's `SLOWEST · $$$$` line is replaced by the context window. `ModelInfo`
 * carries no price or speed, and a hand-maintained table of either would be
 * wrong within weeks — see `docs/decisions/models-come-from-the-sdk.md`.
 */
export function ModelCards({
  models,
  value,
  onChange,
  defaultValue = null,
  disabled = false,
  compact = false,
}: ModelCardsProps) {
  if (models.length === 0) {
    return (
      <p className="rounded-[10px] border border-panel-border bg-[rgba(4,8,16,.4)] px-3.5 py-3 text-[11.5px] leading-[1.4] text-[rgba(160,190,225,.7)]">
        The model list could not be read from Claude Code. Sessions still launch — they use whatever
        model Claude Code is configured with.
      </p>
    )
  }

  return (
    <div
      role="radiogroup"
      aria-label="Model"
      className="grid w-full gap-2"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${compact ? 120 : 150}px, 1fr))` }}
    >
      {models.map((model) => {
        const active = value === model.value
        const isDefault = !active && defaultValue === model.value
        return (
          <button
            key={model.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={model.version}
            data-active={active}
            data-model={model.value}
            disabled={disabled}
            onClick={() => onChange(model.value)}
            className={[
              'relative min-w-0 text-left transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-40',
              compact ? 'rounded-[9px] border px-3 py-2.5' : 'rounded-[10px] border px-3.5 py-3',
              active
                ? compact
                  ? 'border-accent/70 bg-accent/8'
                  : 'border-accent/70 bg-accent/8 shadow-[0_0_20px_rgba(89,228,243,.15)]'
                : 'border-panel-border bg-[rgba(4,8,16,.4)] hover:bg-white/5',
            ].join(' ')}
          >
            {active && !compact && (
              <span
                aria-hidden
                className="absolute right-2.5 top-2.5 h-[7px] w-[7px] rounded-full bg-accent shadow-[0_0_8px_rgba(89,228,243,1)]"
              />
            )}
            <span
              className={[
                'block truncate font-mono text-text-bright',
                compact ? 'text-[11.5px]' : 'text-xs',
              ].join(' ')}
            >
              {compact ? model.family : model.version}
            </span>
            <span
              className={[
                'block leading-[1.4] [text-wrap:pretty]',
                compact ? 'mt-1 text-[11px]' : 'mt-[5px] text-[11.5px]',
                active && !compact ? 'text-[rgba(200,220,245,.85)]' : 'text-[rgba(160,190,225,.7)]',
              ].join(' ')}
            >
              {compact ? model.family === model.version ? model.blurb : model.version : model.blurb}
            </span>
            {!compact && (model.contextWindow !== null || isDefault) && (
              <span
                className={[
                  'mt-2 flex items-center gap-2 font-mono text-[9.5px] tracking-[0.1em]',
                  active ? 'text-accent' : 'text-[rgba(160,190,225,.5)]',
                ].join(' ')}
              >
                {isDefault && <span>DEFAULT</span>}
                {model.contextWindow !== null && (
                  <span>{formatContextWindow(model.contextWindow).toUpperCase()} CTX</span>
                )}
              </span>
            )}
            {compact && isDefault && (
              <span className="mt-1 block font-mono text-[9.5px] tracking-[0.1em] text-[rgba(160,190,225,.5)]">
                DEFAULT
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/test/modelcards.test.tsx -w web && npm run typecheck -w web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/ui/ModelCards.tsx web/src/test/modelcards.test.tsx
git commit -m "feat(models): ModelCards primitive shared by the dialog and settings"
```

---

### Task 9: Model picker in the New session dialog (4b)

**Files:**
- Modify: `web/src/panels/NewSessionDialog.tsx`
- Test: `web/src/test/newsession.test.tsx`

**Interfaces:**
- Consumes: `ModelCards`, `modelByValue`, `api.listProjects` (new shape), `api.createSession({ model })`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

```tsx
it('preselects the settings default model', async () => {
  resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'true' }, models: MODELS })
  vi.mocked(api.listProjects).mockResolvedValue([])
  render(<NewSessionDialog open onClose={() => {}} />)
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: /Sonnet 5/ })).toHaveAttribute('aria-checked', 'true')
  )
})

it('falls back to the first catalog row when the default is not offered', async () => {
  resetStore({ settings: { default_model: 'nonexistent' }, models: MODELS })
  vi.mocked(api.listProjects).mockResolvedValue([])
  render(<NewSessionDialog open onClose={() => {}} />)
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: /Opus 5 with 1M context/ })).toHaveAttribute('aria-checked', 'true')
  )
})

it('adopts the project last-used model when the toggle is on', async () => {
  resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'true' }, models: MODELS })
  vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'haiku' }])
  render(<NewSessionDialog open onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: /Haiku 4.5/ })).toHaveAttribute('aria-checked', 'true')
  )
  expect(screen.getByText(/last used here: Haiku/)).toBeInTheDocument()
})

it('ignores the project last-used model when the toggle is off', async () => {
  resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'false' }, models: MODELS })
  vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'haiku' }])
  render(<NewSessionDialog open onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: /Sonnet 5/ })).toHaveAttribute('aria-checked', 'true')
  )
})

it('a manual pick survives a later cwd change', async () => {
  resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'true' }, models: MODELS })
  vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'haiku' }])
  render(<NewSessionDialog open onClose={() => {}} />)
  fireEvent.click(screen.getByRole('radio', { name: /Opus 5 with 1M context/ }))
  fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
  await waitFor(() => expect(screen.getByLabelText('PROJECT DIRECTORY')).toHaveValue('/w/x'))
  expect(screen.getByRole('radio', { name: /Opus 5 with 1M context/ })).toHaveAttribute('aria-checked', 'true')
})

it('launches with the chosen model', async () => {
  resetStore({ settings: { default_model: 'sonnet' }, models: MODELS })
  vi.mocked(api.listProjects).mockResolvedValue([])
  vi.mocked(api.createSession).mockResolvedValue('new-1')
  render(<NewSessionDialog open onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
  fireEvent.click(screen.getByRole('radio', { name: /Haiku 4.5/ }))
  fireEvent.click(screen.getByRole('button', { name: /Launch session/ }))
  await waitFor(() =>
    expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }))
  )
})
```

Add the `MODELS` fixture from Task 8 to the top of the file and `models` to `resetStore`'s state. The cwd `Input` needs `aria-label="PROJECT DIRECTORY"` if `getByLabelText` does not already reach it through the existing `FieldLabel htmlFor`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/test/newsession.test.tsx -w web`
Expected: FAIL — no radios named after models.

- [ ] **Step 3: Implement the group**

In `web/src/panels/NewSessionDialog.tsx`:

Import `ModelCards`, `modelByValue`, and read the catalog:

```tsx
  const models = useOrbital(useShallow((s) => s.models))
```

Add state beside `permissionMode`:

```tsx
  const [model, setModel] = useState<string | null>(null)
  /** Once the user picks a model, a later cwd change must not move it. */
  const [modelOverridden, setModelOverridden] = useState(false)
  const [projects, setProjects] = useState<Array<{ cwd: string; lastModel: string | null }>>([])
```

Replace `recentDirs` with `projects`; the chips map `projects.slice(0, 4).map((p) => p.cwd)`, and `api.listProjects().then(setProjects)`.

In the open-transition effect, seed the model:

```tsx
      setModel(null)
      setModelOverridden(false)
```

Add an effect that resolves the preselection whenever the catalog, cwd or settings change:

```tsx
  // Preselection, in the order 4b describes: this project's last model when
  // the toggle allows it, otherwise the Settings default, otherwise the first
  // row the catalog offers (the default may name a model this install does
  // not have). A manual pick wins over all of it.
  const rememberPerProject = settings.remember_model_per_project !== 'false'
  const lastModelHere = projects.find((p) => p.cwd === cwd.trim())?.lastModel ?? null
  useEffect(() => {
    if (!open || modelOverridden || models.length === 0) return
    const remembered = rememberPerProject ? modelByValue(lastModelHere, models) : undefined
    const fromSettings = modelByValue(settings.default_model, models)
    setModel((remembered ?? fromSettings ?? models[0]).value)
  }, [open, modelOverridden, models, rememberPerProject, lastModelHere, settings.default_model])
```

Render the group between PROJECT DIRECTORY and PERMISSION MODE:

```tsx
        <div className="flex flex-col gap-2">
          <FieldLabel>
            MODEL
            <span aria-hidden className="flex-1" />
            {rememberPerProject && lastModelHere && (
              <span className="tracking-[0.06em] text-[rgba(160,190,225,.5)]">
                last used here: {modelByValue(lastModelHere, models)?.family ?? lastModelHere}
              </span>
            )}
          </FieldLabel>
          <ModelCards
            models={models}
            value={model}
            defaultValue={settings.default_model ?? null}
            onChange={(next) => {
              setModelOverridden(true)
              setModel(next)
            }}
          />
        </div>
```

Pass it to the launch call: `model: model ?? undefined`, and add it to `handleLaunch`'s dependency array.

Extend the footer caption to name the model, matching 4b's `Sonnet 4.5 · acceptEdits · search-indexer` line:

```tsx
        footerCaption={
          <>
            {modelByValue(model, models)?.version ?? 'default model'} · {permissionMode}
            {footerTagName ? <> · <span className="text-text-soft">{footerTagName.toUpperCase()}</span></> : null}
          </>
        }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/test/newsession.test.tsx -w web && npm run typecheck -w web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/panels/NewSessionDialog.tsx web/src/test/newsession.test.tsx
git commit -m "feat(models): choose the model when launching a session"
```

---

### Task 10: Detail badge, switcher and a truthful context bar (4a)

**Files:**
- Create: `web/src/panels/ModelSwitcher.tsx`
- Modify: `web/src/panels/DetailPanel.tsx:38-42` (delete `CONTEXT_BUDGET`), the badge row, the context read-out
- Test: `web/src/test/detail.test.tsx`

**Interfaces:**
- Consumes: `matchModel`, `contextWindowFor`, `formatContextWindow`, `api.setSessionModel`.
- Produces: `<ModelSwitcher session models defaultValue disabledReason? />`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('shows the session model next to the permission badge', () => {
  renderDetail({ session: { ...webSession, model: 'opus[1m]' }, models: MODELS })
  expect(screen.getByRole('button', { name: /Change model/ })).toHaveTextContent('Opus 5 with 1M context')
})

it('names a terminal session from its resolved model', () => {
  renderDetail({ session: { ...terminalSession, resolvedModel: 'claude-opus-5' }, models: MODELS })
  expect(screen.getByText(/Opus 5 with 1M context/)).toBeInTheDocument()
})

it('opens the switcher and marks the current model', () => {
  renderDetail({ session: { ...webSession, model: 'sonnet' }, models: MODELS })
  fireEvent.click(screen.getByRole('button', { name: /Change model/ }))
  expect(screen.getByRole('option', { name: /Sonnet 5/ })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText(/APPLIES FROM NEXT TURN/)).toBeInTheDocument()
})

it('switches the model', async () => {
  vi.mocked(api.setSessionModel).mockResolvedValue({ ok: true })
  renderDetail({ session: { ...webSession, model: 'sonnet' }, models: MODELS })
  fireEvent.click(screen.getByRole('button', { name: /Change model/ }))
  fireEvent.click(screen.getByRole('option', { name: /Haiku 4.5/ }))
  await waitFor(() => expect(api.setSessionModel).toHaveBeenCalledWith(webSession.id, 'haiku'))
})

it('does not offer a switch on a session live in a terminal', () => {
  renderDetail({ session: { ...terminalSession, status: 'working', model: null, resolvedModel: 'claude-sonnet-5' }, models: MODELS })
  expect(screen.queryByRole('button', { name: /Change model/ })).not.toBeInTheDocument()
})

it('scales the context bar to the session model', () => {
  renderDetail({
    session: { ...webSession, model: 'opus[1m]' },
    models: MODELS,
    usage: { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  expect(screen.getByTestId('context-readout')).toHaveTextContent('100k / 1M ctx')
  expect(screen.getByRole('progressbar', { name: 'Context usage' })).toHaveAttribute('aria-valuenow', '10')
})

it('falls back to 200k for a model it cannot place', () => {
  renderDetail({ session: { ...webSession, model: null, resolvedModel: 'claude-mystery-1' }, models: MODELS })
  expect(screen.getByTestId('context-readout')).toHaveTextContent('/ 200k ctx')
})
```

Give the read-out `data-testid="context-readout"` alongside its existing `data-context-readout` attribute, and extend `renderDetail` to seed `models`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/test/detail.test.tsx -w web`
Expected: FAIL — no "Change model" button, read-out still says `200k`.

- [ ] **Step 3: Write the switcher**

Create `web/src/panels/ModelSwitcher.tsx`:

```tsx
import { useState } from 'react'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { matchModel } from '../lib/models'
import { EscapeBoundary, useEscapeLayer } from '../ui/escapeLayer'
import type { ApiSession, OrbitalModel } from '../lib/types'

export interface ModelSwitcherProps {
  session: ApiSession
  models: OrbitalModel[]
  /** SDK `value` of the Settings default, marked `DEFAULT` in the list. */
  defaultValue: string | null
  /** When set, the badge is inert and carries this as its tooltip. */
  disabledReason?: string
}

/**
 * The model chip in the detail header (canvas 4a) and the listbox it opens.
 *
 * Switching takes effect from the next turn — the SDK's `setModel` changes
 * what serves the conversation, not the conversation itself, which is why the
 * footer can promise the context is kept. The transcript's divider is not
 * written here: `Transcript` derives it from the messages themselves, so it
 * survives a reload and also shows switches Orbital never performed.
 */
export function ModelSwitcher({ session, models, defaultValue, disabledReason }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false)
  const current = matchModel(session, models)
  const label = current?.version ?? session.resolvedModel ?? session.model ?? 'unknown model'

  useEscapeLayer(open, () => setOpen(false))

  if (disabledReason) {
    return (
      <span
        title={disabledReason}
        data-model-badge
        className="inline-flex items-center rounded-[5px] border border-panel-border bg-[rgba(4,8,16,.5)] px-[9px] py-1 font-mono text-[10.5px] tracking-[0.04em] text-[rgba(220,235,255,.85)]"
      >
        {label}
      </span>
    )
  }

  function choose(value: string) {
    setOpen(false)
    if (value === session.model) return
    const previous = session.model
    useOrbital.setState((state) => {
      const row = state.sessions[session.id]
      if (!row) return state
      return { sessions: { ...state.sessions, [session.id]: { ...row, model: value } } }
    })
    api.setSessionModel(session.id, value).catch((err) => {
      useOrbital.setState((state) => {
        const row = state.sessions[session.id]
        if (!row) return state
        return { sessions: { ...state.sessions, [session.id]: { ...row, model: previous } } }
      })
      reportError(err, 'Failed to switch model')
    })
  }

  return (
    <span className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Change model (currently ${label})`}
        title="Change model (from next turn)"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-[7px] whitespace-nowrap rounded-[5px] border border-accent/60 bg-accent/8 px-[9px] py-1 font-mono text-[10.5px] tracking-[0.04em] text-text-bright shadow-[0_0_0_3px_rgba(89,228,243,.1)]"
      >
        {label}
        <span aria-hidden className="text-[9px] text-[rgba(160,190,225,.6)]">▾</span>
      </button>
      {open && (
        <EscapeBoundary>
          <div className="absolute right-0 top-[calc(100%+6px)] z-20 w-[300px] rounded-[10px] border border-[rgba(150,205,255,.22)] bg-panel-solid shadow-[0_20px_50px_rgba(0,0,0,.6)]">
            <div className="px-3 pb-1.5 pt-2.5 font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">
              MODEL · APPLIES FROM NEXT TURN
            </div>
            <div role="listbox" aria-label="Model" className="flex flex-col px-1.5 pb-1.5">
              {models.map((model) => {
                const selected = model.value === current?.value
                return (
                  <button
                    key={model.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-label={model.version}
                    onClick={() => choose(model.value)}
                    className={[
                      'grid grid-cols-[1fr_auto] items-center gap-2 rounded-[7px] border px-2 py-[9px] text-left',
                      selected ? 'border-accent/35 bg-accent/10' : 'border-transparent hover:bg-white/5',
                    ].join(' ')}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs text-text-bright">{model.version}</span>
                      <span className="mt-0.5 block text-[11px] text-[rgba(160,190,225,.7)]">{model.blurb}</span>
                    </span>
                    {selected ? (
                      <span className="font-mono text-[9.5px] tracking-[0.1em] text-accent">CURRENT</span>
                    ) : model.value === defaultValue ? (
                      <span className="font-mono text-[9.5px] tracking-[0.1em] text-[rgba(160,190,225,.5)]">DEFAULT</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
            <div className="border-t border-[rgba(150,205,255,.1)] px-3 pb-2.5 pt-2 font-mono text-[10px] leading-[1.6] text-[rgba(160,190,225,.6)] [text-wrap:pretty]">
              Context is kept. A divider marks the switch in the transcript.
            </div>
          </div>
        </EscapeBoundary>
      )}
    </span>
  )
}
```

- [ ] **Step 4: Wire it into the panel**

In `web/src/panels/DetailPanel.tsx`:

Delete the `CONTEXT_BUDGET` constant and its comment. Import `ModelSwitcher`, `contextWindowFor` and `formatContextWindow`, and read `const models = useOrbital(useShallow((s) => s.models))`.

Replace the `contextPercent` computation:

```tsx
  const contextWindow = session ? contextWindowFor(session, models) : DEFAULT_CONTEXT_WINDOW
  const contextPercent =
    usageTokens !== undefined
      ? Math.min(100, Math.round((usageTokens.total / contextWindow) * 100))
      : undefined
```

and the read-out's denominator with `{formatContextWindow(contextWindow)} ctx`.

In the badge row, immediately before `{session.permissionMode && <Badge … />}`:

```tsx
              {(session.model || session.resolvedModel || models.length > 0) && (
                <ModelSwitcher
                  session={session}
                  models={models}
                  defaultValue={settings.default_model ?? null}
                  disabledReason={
                    isTerminalLive ? 'Live in a terminal — Orbital does not own this session' : undefined
                  }
                />
              )}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/test/detail.test.tsx -w web && npm run typecheck -w web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/panels/ModelSwitcher.tsx web/src/panels/DetailPanel.tsx web/src/test/detail.test.tsx
git commit -m "feat(models): detail badge, model switcher and a per-model context bar"
```

---

### Task 11: The transcript divider

**Files:**
- Modify: `web/src/panels/Transcript.tsx` (`TranscriptGroup`, new `insertModelDividers`, the render loop)
- Test: `web/src/test/transcript.test.tsx`

**Interfaces:**
- Consumes: `ChatMessage.model`.
- Produces: `TranscriptGroup` gains `| { kind: 'model-divider'; key: string; from: string; to: string; timestamp?: string }`; `insertModelDividers(groups: TranscriptGroup[]): TranscriptGroup[]`.

- [ ] **Step 1: Write the failing tests**

```tsx
import { insertModelDividers, groupToolRuns, pairMessages } from '../panels/Transcript'

const assistant = (id: string, model?: string, timestamp?: string): ChatMessage => ({
  id, role: 'assistant', text: `m-${id}`, model, timestamp,
})

describe('insertModelDividers', () => {
  const groupsOf = (messages: ChatMessage[]) => groupToolRuns(pairMessages(messages))

  it('marks a change between two assistant messages', () => {
    const groups = insertModelDividers(
      groupsOf([
        assistant('a1', 'claude-sonnet-5'),
        assistant('a2', 'claude-opus-5', '2026-09-16T14:02:00Z'),
      ]),
    )
    const divider = groups.find((g) => g.kind === 'model-divider')
    expect(divider).toMatchObject({ from: 'claude-sonnet-5', to: 'claude-opus-5' })
    expect(groups.indexOf(divider!)).toBe(1)
  })

  it('adds nothing when the model never changes', () => {
    const groups = insertModelDividers(
      groupsOf([assistant('a1', 'claude-opus-5'), assistant('a2', 'claude-opus-5')]),
    )
    expect(groups.some((g) => g.kind === 'model-divider')).toBe(false)
  })

  it('ignores messages with no model and user turns', () => {
    const groups = insertModelDividers(
      groupsOf([
        assistant('a1', 'claude-sonnet-5'),
        { id: 'u1', role: 'user', text: 'and now?' },
        assistant('a2'),
        assistant('a3', 'claude-sonnet-5'),
      ]),
    )
    expect(groups.some((g) => g.kind === 'model-divider')).toBe(false)
  })

  it('does not mark the first model it sees', () => {
    const groups = insertModelDividers(groupsOf([assistant('a1', 'claude-opus-5')]))
    expect(groups.some((g) => g.kind === 'model-divider')).toBe(false)
  })
})

it('renders the divider in the transcript', () => {
  renderTranscript([
    assistant('a1', 'claude-sonnet-5'),
    assistant('a2', 'claude-opus-5', '2026-09-16T14:02:00Z'),
  ])
  expect(screen.getByText(/claude-sonnet-5 → claude-opus-5/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/test/transcript.test.tsx -w web`
Expected: FAIL — `insertModelDividers is not exported`.

- [ ] **Step 3: Implement it**

In `web/src/panels/Transcript.tsx`, extend the union:

```ts
export type TranscriptGroup =
  | { kind: 'tools'; key: string; items: Extract<TranscriptItem, { kind: 'tool' }>[] }
  | { kind: 'message'; key: string; item: Extract<TranscriptItem, { kind: 'message' }> }
  | { kind: 'model-divider'; key: string; from: string; to: string; timestamp?: string }
```

Add below `groupToolRuns`:

```ts
/**
 * Inserts a divider wherever the model behind consecutive assistant messages
 * changes (canvas 4a).
 *
 * Derived from the messages rather than recorded at switch time, so it
 * survives a reload, needs no storage, and also shows a switch made in a
 * terminal that Orbital never performed. Messages with no model at all (user
 * turns, tool rows, transcripts from a CLI too old to record one) are
 * skipped, never treated as a change — an absent model is unknown, not
 * different.
 */
export function insertModelDividers(groups: TranscriptGroup[]): TranscriptGroup[] {
  const out: TranscriptGroup[] = []
  let previousModel: string | undefined
  for (const group of groups) {
    const message = group.kind === 'message' ? group.item.message : undefined
    const model = message?.role === 'assistant' ? message.model : undefined
    if (model && previousModel && model !== previousModel) {
      out.push({
        kind: 'model-divider',
        key: `model:${group.key}`,
        from: previousModel,
        to: model,
        timestamp: message?.timestamp,
      })
    }
    if (model) previousModel = model
    out.push(group)
  }
  return out
}
```

In the render, wrap the grouping and add the branch:

```tsx
      {insertModelDividers(groupToolRuns(items)).map((group, index, groups) =>
        group.kind === 'model-divider' ? (
          <div
            key={group.key}
            data-model-divider
            className="flex items-center gap-2.5 font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.55)]"
          >
            <span aria-hidden className="h-px flex-1 bg-[rgba(150,205,255,.12)]" />
            <span>
              {group.from.toUpperCase()} → {group.to.toUpperCase()}
              {group.timestamp
                ? ` · ${new Date(group.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
                : ''}
            </span>
            <span aria-hidden className="h-px flex-1 bg-[rgba(150,205,255,.12)]" />
          </div>
        ) : group.kind === 'tools' ? (
```

The `streaming` prop on `MessageView` keys off `index === groups.length - 1`; dividers are never last (one is always followed by the message that caused it), so that test is unaffected.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/test/transcript.test.tsx -w web && npm run typecheck -w web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/panels/Transcript.tsx web/src/test/transcript.test.tsx
git commit -m "feat(models): derive the model-switch divider from the transcript"
```

---

### Task 12: Settings rows (4c)

**Files:**
- Modify: `web/src/panels/Settings.tsx`
- Test: `web/src/test/settings.test.tsx`

**Interfaces:**
- Consumes: `ModelCards`, `modelByValue`, the store's `models`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

```tsx
it('shows the default model and saves a change', async () => {
  renderSettings({ settings: { default_model: 'sonnet' }, models: MODELS })
  expect(screen.getByRole('radio', { name: 'Sonnet' })).toHaveAttribute('aria-checked', 'true')
  fireEvent.click(screen.getByRole('radio', { name: 'Haiku' }))
  await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ default_model: 'haiku' }))
})

it('toggles remembering the model per project', async () => {
  renderSettings({ settings: { remember_model_per_project: 'true' }, models: MODELS })
  fireEvent.click(screen.getByLabelText('Remember last model per project'))
  await waitFor(() =>
    expect(api.patchSettings).toHaveBeenCalledWith({ remember_model_per_project: 'false' })
  )
})

it('toggles the model name under the planet label', async () => {
  renderSettings({ settings: { map_show_model: 'true' }, models: MODELS })
  fireEvent.click(screen.getByRole('switch', { name: /Model name under planet label/ }))
  await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ map_show_model: 'false' }))
})

it('says so when the catalog is empty', () => {
  renderSettings({ settings: {}, models: [] })
  expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/test/settings.test.tsx -w web`
Expected: FAIL — no "Default model" row.

- [ ] **Step 3: Add the rows**

In `web/src/panels/Settings.tsx`, import `ModelCards`, read `const models = useOrbital(useShallow((s) => s.models))`, and derive:

```tsx
  const defaultModel = settings.default_model ?? ''
  const rememberModelPerProject = settings.remember_model_per_project !== 'false'
  const mapShowModel = settings.map_show_model !== 'false'
```

In the `NEW SESSIONS` section, directly above the existing "Default permission mode" row:

```tsx
            <Row
              title="Default model"
              desc="Pre-selected in the New session dialog and used by Clear. Never changes a running session."
            >
              <ModelCards
                compact
                models={models}
                value={defaultModel || null}
                onChange={(value) => void patchAndSet({ default_model: value })}
              />
              <Checkbox
                label="Remember last model per project"
                checked={rememberModelPerProject}
                onChange={(checked) =>
                  void patchAndSet({ remember_model_per_project: String(checked) })
                }
              />
            </Row>
```

In the `MAP` section, beside the existing map rows:

```tsx
            <Row
              title="Model name under planet label"
              desc="Family only (no version). Moons show it only when their model differs."
            >
              <Toggle
                aria-label="Model name under planet label"
                checked={mapShowModel}
                onChange={(checked) => void patchAndSet({ map_show_model: String(checked) })}
              />
            </Row>
```

Use whatever `Row`/`Toggle` arrangement the file's existing map rows already use, so the new row matches them rather than the snippet.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/test/settings.test.tsx -w web && npm run typecheck -w web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/panels/Settings.tsx web/src/test/settings.test.tsx
git commit -m "feat(models): default model, per-project memory and the map toggle in Settings"
```

---

### Task 13: The model family under the planet label

**Files:**
- Modify: `web/src/map/sceneModel.ts` (`ScenePlanet`, `buildSceneModel`)
- Modify: `web/src/map/Planet.tsx:204-219` (props), the label group at `:846-876`
- Modify: `web/src/map/SpaceMap.tsx:205-215`
- Test: `web/src/test/spacemap.test.tsx`

**Interfaces:**
- Consumes: `matchModel`, the store's `models` and `settings`.
- Produces: `ScenePlanet.modelFamily: string | null`; `PlanetProps.modelFamily?: string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
it('carries the model family on each planet', () => {
  const model = buildSceneModel(
    stateWith({
      sessions: { s1: session({ id: 's1', model: 'opus[1m]' }) },
      models: MODELS,
      settings: { map_show_model: 'true' },
    }),
    NOW,
  )
  expect(model.planets[0].modelFamily).toBe('Opus')
})

it('omits the family when the map toggle is off', () => {
  const model = buildSceneModel(
    stateWith({
      sessions: { s1: session({ id: 's1', model: 'opus[1m]' }) },
      models: MODELS,
      settings: { map_show_model: 'false' },
    }),
    NOW,
  )
  expect(model.planets[0].modelFamily).toBeNull()
})

it('omits the family for a session whose model is unknown', () => {
  const model = buildSceneModel(
    stateWith({
      sessions: { s1: session({ id: 's1', model: null, resolvedModel: 'claude-mystery-1' }) },
      models: MODELS,
      settings: { map_show_model: 'true' },
    }),
    NOW,
  )
  expect(model.planets[0].modelFamily).toBeNull()
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/test/spacemap.test.tsx -w web`
Expected: FAIL — `modelFamily` is not on `ScenePlanet`.

- [ ] **Step 3: Extend the scene model**

In `web/src/map/sceneModel.ts`, import `matchModel`, add to `ScenePlanet`:

```ts
  /**
   * Family alone (`Opus`), drawn as a second label line — or null when the
   * map toggle is off or the model is not one the catalog knows. Never the
   * version: the map shows what kind of thing is running, not which build.
   */
  modelFamily: string | null
```

In `buildSceneModel`, before the loop:

```ts
  const showModel = state.settings.map_show_model !== 'false'
```

and inside the `planets.push({…})`:

```ts
        modelFamily: showModel ? (matchModel(session, state.models)?.family ?? null) : null,
```

- [ ] **Step 4: Draw it**

In `web/src/map/Planet.tsx`, add `modelFamily?: string | null` to `PlanetProps` and render a second line inside the existing `<Html>` label. Wrap the current `<span>` in a flex column, matching 4a's mono 9.5px / `.1em` tracking:

```tsx
          <span style={{ display: 'block', width: 'max-content', transform: 'translateX(-50%)' }}>
            <span style={{ /* the existing title span's styles, minus transform/width */ }}>
              {truncateLabel(session.title)}
            </span>
            {modelFamily && (
              <span
                style={{
                  display: 'block',
                  marginTop: 5,
                  textAlign: 'center',
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 9.5,
                  letterSpacing: '0.1em',
                  color: LABEL_COLOR_DIMMED,
                  whiteSpace: 'nowrap',
                }}
              >
                {modelFamily.toUpperCase()}
              </span>
            )}
          </span>
```

Keep the `display: block` / `width: max-content` / `transform: translateX(-50%)` trio on the **outer** span only — the comment in that file explains why all three are load-bearing, and moving them would un-centre the label.

In `web/src/map/SpaceMap.tsx`, pass `modelFamily={planet.modelFamily}` to `<Planet>`.

- [ ] **Step 5: Run the tests**

Run: `npm run test:run -w web && npm run typecheck -w web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/map web/src/test/spacemap.test.tsx
git commit -m "feat(models): show the model family under the planet label"
```

---

### Task 14: End-to-end check and documentation status

**Files:**
- Modify: `docs/superpowers/specs/2026-09-16-agent-model-design.md` (frontmatter `status`)
- Modify: `docs/superpowers/plans/2026-09-16-agent-model.md` (frontmatter `status`)

- [ ] **Step 1: Run everything**

```bash
npm test && npm run typecheck && atlas validate
```

Expected: all green.

- [ ] **Step 2: Drive the real app**

```bash
npm run dev
```

Check, in order:

1. Settings → Sessions shows a **Default model** row with real model names (not the canvas's `Opus 4.1`).
2. New session dialog preselects that model and shows a context line on each card.
3. Launch a session on Haiku; the detail header shows `Haiku 4.5` beside `acceptEdits`, and the context read-out says `/ 200k ctx`.
4. Switch it to Opus from the badge; after the next answer a divider appears in the transcript and the read-out's denominator follows the new model.
5. Open a terminal-launched session: the model chip is present and inert.
6. Settings → Map → toggle the model name; the second line appears and disappears under the planet labels.

Report anything that does not behave this way rather than adjusting the tests to match.

- [ ] **Step 3: Set the documents' status**

Set `status: done` on both the spec and this plan.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs(models): mark the agent-model spec and plan done"
```

---

## Self-review

**Spec coverage.** Data model → Task 1 (columns, migration, backfill) and Task 4 (wire shape). Resolution order and the `[…]` rule → Task 7 (`matchModel` / `contextWindowFor`, with a test for each half). Catalog (probe, freshness, shaping, context windows, persistence) → Task 2, served in Task 3. Endpoints → Task 3 (`/api/models`), Task 4 (`POST /api/sessions`, revive, Clear), Task 5 (`POST /:id/model`), Task 6 (`/api/projects`). Transcript and live stream → Task 1 (parser) and Task 4 (`sdkToChatMessages`, `onInit`). `ModelCards` → Task 8; 4a → Task 10; the divider → Task 11; 4b → Task 9; 4c → Task 12; the map → Task 13. Error states → Task 2 (probe failure, both directions), Task 5 (409), Task 8 (empty catalog), Task 7 (no catalog match). Out of scope stays out: no task touches subagents, effort levels or cost.

**Naming consistency.** `OrbitalModel` has the same six fields on both sides of the wire. `matchModel` is the naming lookup, `contextWindowFor` the exact-match one, `modelByValue` the by-`value` one — used under those names in Tasks 9, 10 and 13. `Runner` deps are `onTurnUsage` (Task 3) and `onInit` (Task 4), both distinct from the existing `onStatus`. `CATALOG_KEY` / `CONTEXT_WINDOWS_KEY` are exported from the catalog and used by its test.

**Known cross-cutting churn,** called out where it lands rather than discovered mid-task: Task 1 adds two fields to `SessionRow` (server fixtures), Task 4 adds two to `ApiSession` (web fixtures), Task 6 changes the shape of `listProjects`, and Task 7 adds two methods that all eight web api mocks must declare.
