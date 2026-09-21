import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ModelCatalog,
  shapeModels,
  extractContextWindows,
  CATALOG_KEY,
  CONTEXT_WINDOWS_KEY,
  REFRESH_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
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

/** A query object whose `supportedModels()` never settles, to drive the probe timeout. */
function hangingQueryFn() {
  const closed = { count: 0 };
  const fn = vi.fn(() => {
    const gen: any = (async function* () {})();
    gen.supportedModels = () => new Promise(() => {});
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

  it('derives a short version for the places a long one will not fit', () => {
    const shaped = shapeModels(RAW, {});
    expect(shaped.find((m) => m.value === 'opus[1m]')!.shortVersion).toBe('Opus 5');
    expect(shaped.find((m) => m.value === 'sonnet')!.shortVersion).toBe('Sonnet 5');
    expect(shaped.find((m) => m.value === 'haiku')!.shortVersion).toBe('Haiku 4.5');
  });

  it('reads the variant off the resolved model id, not the prose', () => {
    const shaped = shapeModels(RAW, {});
    expect(shaped.find((m) => m.value === 'opus[1m]')!.variant).toBe('1M');
    // Fable's *value* carries [1m] but its resolvedModel does not — the
    // canonical id is what actually serves the turn.
    expect(shaped.find((m) => m.value === 'claude-fable-5-1[1m]')!.variant).toBeNull();
    expect(shaped.find((m) => m.value === 'sonnet')!.variant).toBeNull();
  });

  it('falls back to the family when the description has no separator', () => {
    const shaped = shapeModels(
      [{ value: 'x', resolvedModel: 'claude-x', displayName: 'Ex', description: 'Just a blurb' }],
      {},
    );
    expect(shaped[0].version).toBe('Ex');
    expect(shaped[0].shortVersion).toBe('Ex');
    expect(shaped[0].blurb).toBe('Just a blurb');
  });

  it('attaches a learned context window only on an exact resolved-model match', () => {
    // A model with no seed entry, so a stripped-id match can only be coming
    // from the (deliberately exact-only) learned lookup.
    const raw = [
      { value: 'x', resolvedModel: 'claude-mystery-1[1m]', displayName: 'X', description: 'X · blurb' },
    ];
    // Keyed by the STRIPPED id, which must not satisfy the exact lookup.
    const shaped = shapeModels(raw, { 'claude-mystery-1': 200_000 });
    expect(shaped[0].contextWindow).toBeNull();
  });

  describe('the documented context-window seed', () => {
    it('fills in a documented window when nothing has been learned yet', () => {
      const shaped = shapeModels(RAW, {});
      // Every RAW row resolves (after stripping) to a seeded id.
      expect(shaped.find((m) => m.value === 'opus[1m]')!.contextWindow).toBe(1_000_000);
      expect(shaped.find((m) => m.value === 'claude-fable-5-1[1m]')!.contextWindow).toBe(1_000_000);
      expect(shaped.find((m) => m.value === 'sonnet')!.contextWindow).toBe(1_000_000);
      expect(shaped.find((m) => m.value === 'haiku')!.contextWindow).toBe(200_000);
    });

    it('lets a learned value override the seed for the same resolved model', () => {
      // Sonnet is seeded at 1M; a real turn reporting something else must win.
      const shaped = shapeModels(RAW, { 'claude-sonnet-5': 5 });
      expect(shaped.find((m) => m.value === 'sonnet')!.contextWindow).toBe(5);
    });

    it('stays null for a model the seed does not recognize and nothing has taught it', () => {
      const raw = [
        { value: 'x', resolvedModel: 'claude-mystery-1', displayName: 'X', description: 'X · blurb' },
      ];
      expect(shapeModels(raw, {})[0].contextWindow).toBeNull();
    });
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

  it('serves the learned windows as a map, including ids no catalog row carries', () => {
    // A revived terminal session's init reports `claude-fable-5`, which no
    // catalog row resolves to — the map is the only place that id's measured
    // window lives (fix: revived-session-shows-no-context-gauge).
    const settings = fakeSettings({
      [CONTEXT_WINDOWS_KEY]: JSON.stringify({ 'claude-fable-5': 1_000_000 }),
    });
    const { fn } = fakeQueryFn();
    const catalog = new ModelCatalog({ settings, queryFn: fn as never });

    expect(catalog.learnedContextWindows()).toEqual({ 'claude-fable-5': 1_000_000 });
  });

  it('serves an empty map before anything has been learned', () => {
    const { fn } = fakeQueryFn();
    const catalog = new ModelCatalog({ settings: fakeSettings(), queryFn: fn as never });

    expect(catalog.learnedContextWindows()).toEqual({});
  });

  // F3: the probe was spawning a CLI on every `list()` call — every page
  // load, every new tab — because nothing remembered when it last ran.
  describe('the last-probed-at guard', () => {
    it('skips a second probe inside the refresh window', async () => {
      const settings = fakeSettings({ [CATALOG_KEY]: JSON.stringify(RAW) });
      const { fn } = fakeQueryFn();
      const catalog = new ModelCatalog({ settings, queryFn: fn as never });

      await catalog.refresh();
      expect(fn).toHaveBeenCalledTimes(1);

      await catalog.refresh();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('a forced refresh probes anyway', async () => {
      const settings = fakeSettings({ [CATALOG_KEY]: JSON.stringify(RAW) });
      const { fn } = fakeQueryFn();
      const catalog = new ModelCatalog({ settings, queryFn: fn as never });

      await catalog.refresh();
      await catalog.refresh(true);

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('the probe timeout', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('settles without rejecting, and leaves the stored list standing, when the probe hangs', async () => {
      vi.useFakeTimers();
      const settings = fakeSettings({ [CATALOG_KEY]: JSON.stringify(RAW) });
      const { fn, closed } = hangingQueryFn();
      const catalog = new ModelCatalog({ settings, queryFn: fn as never });

      const refreshing = catalog.refresh();
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1_000);
      await expect(refreshing).resolves.toBeUndefined();

      expect(JSON.parse(settings.store[CATALOG_KEY])).toEqual(RAW);
      // The query is closed even though supportedModels() never answered.
      expect(closed.count).toBe(1);
    });
  });

  it('does not wipe a good stored list when the probe resolves to an empty array', async () => {
    const settings = fakeSettings({ [CATALOG_KEY]: JSON.stringify(RAW) });
    const { fn } = fakeQueryFn([]);
    const catalog = new ModelCatalog({ settings, queryFn: fn as never });

    await catalog.refresh(true);

    expect(JSON.parse(settings.store[CATALOG_KEY])).toEqual(RAW);
  });

  it('never lets the probe prompt stream produce a value', async () => {
    const settings = fakeSettings();
    let capturedPrompt: AsyncIterable<unknown> | undefined;
    const fn = vi.fn((opts: any) => {
      capturedPrompt = opts.prompt;
      const gen: any = (async function* () {})();
      gen.supportedModels = async () => RAW;
      return gen;
    });
    const catalog = new ModelCatalog({ settings, queryFn: fn as never });

    await catalog.list();

    expect(capturedPrompt).toBeDefined();
    const sentinel = Symbol('sentinel');
    // The sentinel promise is already resolved; the prompt's `next()` is
    // driven off a promise that never settles. If the prompt ever yielded a
    // value (even synchronously enqueued), it could win this race.
    const result = await Promise.race([capturedPrompt![Symbol.asyncIterator]().next(), Promise.resolve(sentinel)]);
    expect(result).toBe(sentinel);
  });

  it('logs a probe failure once, then again only after a fresh success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const settings = fakeSettings({ [CATALOG_KEY]: JSON.stringify(RAW) });
    let mode: 'fail' | 'ok' = 'fail';
    const fn = vi.fn(() => {
      const gen: any = (async function* () {})();
      gen.supportedModels = async () => {
        if (mode === 'fail') throw new Error('offline');
        return RAW;
      };
      return gen;
    });
    const catalog = new ModelCatalog({ settings, queryFn: fn as never });

    await catalog.refresh(true);
    await catalog.refresh(true);
    expect(warn).toHaveBeenCalledTimes(1);

    mode = 'ok';
    await catalog.refresh(true);
    mode = 'fail';
    await catalog.refresh(true);
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });

  it('exposes the refresh interval as a named constant', () => {
    expect(REFRESH_INTERVAL_MS).toBeGreaterThan(0);
  });

  // The packaged app spawns the user's own CLI rather than the SDK's bundled
  // binary (spec 2026-09-16-electron-wrapper-design § 2); the probe must
  // mirror the Runner's own use of `pathToClaudeCodeExecutable` (see
  // runner.test.ts's "hands the SDK an explicit claude executable..." case)
  // or the packaged app's probe spawns a binary that was never installed.
  it('hands the probe an explicit claude executable when it was given one, and omits the option otherwise', async () => {
    const capture = () => {
      let captured: any;
      const fn = (args: any) => {
        captured = args.options;
        return fakeQueryFn().fn();
      };
      return { fn, options: () => captured };
    };

    const withPath = capture();
    const withPathCatalog = new ModelCatalog({
      settings: fakeSettings(), queryFn: withPath.fn as never, claudeExecutablePath: '/x/claude',
    });
    await withPathCatalog.list();
    expect(withPath.options().pathToClaudeCodeExecutable).toBe('/x/claude');

    const without = capture();
    const withoutCatalog = new ModelCatalog({ settings: fakeSettings(), queryFn: without.fn as never });
    await withoutCatalog.list();
    expect(without.options()).not.toHaveProperty('pathToClaudeCodeExecutable');
  });
});
