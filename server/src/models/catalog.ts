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
  /** Family plus version as the SDK words it — `Opus 5 with 1M context`. */
  version: string;
  /** `version` trimmed to what fits a chip — `Opus 5`. */
  shortVersion: string;
  /** Variant marker read off the resolved id's `[…]` suffix — `1M`, or null. */
  variant: string | null;
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
 * Minimum time between two probes. `list()` calls `refresh()` on every
 * request — every page load, every new tab — so without this a probe (a full
 * CLI spawn) would fire far more often than the boot-probe the ADR rejected
 * for being wasteful.
 */
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * A probe that neither answers nor exits must not hang `list()` forever: a
 * cold install has nothing stored, so `list()` awaits the probe directly,
 * and everything `loadInitial` fetches on the web waits behind it too.
 */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Drops a trailing variant suffix: `claude-opus-5[1m]` -> `claude-opus-5`.
 * The seed table below is keyed by this stripped form, because
 * https://platform.claude.com/docs/en/about-claude/models/overview (checked
 * 2026-09-16) documents plain API ids, not Orbital's `[1m]`-suffixed ones.
 */
function stripVariant(id: string): string {
  return id.replace(/\[[^\]]*\]$/, '');
}

/**
 * Context windows Anthropic documents, keyed by the stripped model id.
 * Verified by hand against
 * https://platform.claude.com/docs/en/about-claude/models/overview on
 * 2026-09-16 — do not add a row here without checking that page again, and
 * do not trust memory over it.
 *
 * This is a SEED, not an authority: it exists only so a fresh install (which
 * has run no turns, and therefore learned nothing) does not draw a chip
 * reading "Opus 5 (1M)" over a context bar that assumes 200k. `shapeModels`
 * only ever consults it when `recordContextWindows` has not yet stored a
 * real figure for that exact model, and a single turn's measurement
 * overwrites the seed permanently. So a stale row here can delay the truth
 * by one turn; it can never contradict it, which is what keeps this
 * compatible with `docs/decisions/models-come-from-the-sdk.md`'s rejection
 * of a hand-maintained table as the source of truth.
 *
 * The SDK's own `getContextUsage()` control request was tried as a source
 * too: it reports `maxTokens: 1_000_000` for every model, including Haiku,
 * because it describes the session's ceiling rather than the specific
 * model's window — not usable here.
 */
const SEED_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable-5-1': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-haiku-4-5': 200_000,
};

/**
 * Turns the SDK's rows into Orbital's. Two rules, both from
 * `docs/decisions/models-come-from-the-sdk.md`:
 *
 * - `default` is dropped. It resolves to the same model as a named row, and
 *   two cards for one model read as a bug. Orbital always sends an explicit
 *   model, so the alias is never needed.
 * - `contextWindow` is resolved in order: the LEARNED value for the exact
 *   `resolvedModel` (from a real turn's `modelUsage`), else the documented
 *   seed for the stripped id, else `null`. `claude-opus-5` must not satisfy
 *   a LEARNED `claude-opus-5[1m]` entry: mislabelling a family is harmless,
 *   drawing a 200k session's usage against a 1M denominator is not. The seed
 *   lookup strips deliberately — see `SEED_CONTEXT_WINDOWS` above.
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
    const version = blurb ? head.trim() : family;
    // The detail chip sits next to the permission and status badges in a
    // 450px panel, where "Opus 5 with 1M context" wraps the row. Cutting at
    // " with " yields exactly the shape canvas 4a draws ("Opus 4.1"), and if
    // the wording ever changes the worst case is a longer label — not a
    // wrong one, which is why this is allowed where parsing "1M context" out
    // of the same sentence is not.
    const shortVersion = version.split(' with ')[0].trim() || version;
    // `[1m]` on the CANONICAL id. Fable's `value` carries the suffix while
    // its `resolvedModel` does not, and the resolved id is what serves.
    const variantMatch = /\[([^\]]+)\]$/.exec(resolvedModel);

    out.push({
      value: info.value,
      resolvedModel,
      family,
      version,
      shortVersion,
      variant: variantMatch ? variantMatch[1].toUpperCase() : null,
      blurb: blurb || description.trim(),
      contextWindow: contextWindows[resolvedModel] ?? SEED_CONTEXT_WINDOWS[stripVariant(resolvedModel)] ?? null,
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
  private lastProbedAt = 0;
  /** Whether the most recent probe to actually run succeeded — gates the warning to one line per outage. */
  private lastProbeOk = true;
  private claudeExecutablePath?: string | null;

  constructor(deps: {
    settings: SettingsStore;
    queryFn: QueryFn;
    cwd?: string;
    /** Absolute path to the claude CLI to spawn, or null/undefined for the SDK's bundled default. */
    claudeExecutablePath?: string | null;
  }) {
    this.settings = deps.settings;
    this.queryFn = deps.queryFn;
    this.cwd = deps.cwd ?? process.cwd();
    this.claudeExecutablePath = deps.claudeExecutablePath;
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

  /**
   * Re-probes. Concurrent callers share one probe; never rejects.
   *
   * Skips the probe entirely when one completed within `REFRESH_INTERVAL_MS`
   * — `list()` calls this on every request, and without the guard a probe
   * (a CLI spawn) would fire on every page load and every new tab. Pass
   * `force` to bypass the guard regardless of when the last one ran.
   */
  refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (!force && Date.now() - this.lastProbedAt < REFRESH_INTERVAL_MS) {
      return Promise.resolve();
    }
    this.refreshing = this.probe()
      .then((models) => {
        if (models.length) this.settings.set(CATALOG_KEY, JSON.stringify(models));
        this.lastProbeOk = true;
      })
      .catch((err) => {
        // Offline, logged out, CLI missing, timed out — all mean "keep what
        // we have". Logged only on the first failure since the last
        // success, so an extended outage does not spam the log once per
        // request.
        if (this.lastProbeOk) console.warn('orbital: model probe failed:', err);
        this.lastProbeOk = false;
      })
      .finally(() => {
        this.lastProbedAt = Date.now();
        this.refreshing = null;
      });
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
    const options: Record<string, unknown> = { cwd: this.cwd, permissionMode: 'plan' };
    // Absent, the SDK spawns its own bundled binary — which the packaged app
    // cannot have (spec 2026-09-16-electron-wrapper-design § 2). Mirrors
    // Runner's `start()`.
    if (this.claudeExecutablePath) options.pathToClaudeCodeExecutable = this.claudeExecutablePath;
    const q = this.queryFn({
      prompt: silent(),
      options,
    });
    try {
      const models = await withTimeout(
        Promise.resolve(q.supportedModels?.() ?? []),
        PROBE_TIMEOUT_MS,
      );
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

/**
 * Races `promise` against a timer so a probe that neither answers nor exits
 * cannot hold `list()` open forever. Rejects on timeout — the caller's
 * `finally` still closes the query, and `refresh()`'s `.catch` still treats
 * it as an ordinary failed probe (stored list untouched, logged once).
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`model probe timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
