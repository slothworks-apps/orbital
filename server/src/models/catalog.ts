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
 * Longer than `PROBE_TIMEOUT_MS` because validation runs a real (if tiny)
 * turn: a CLI spawn plus one API round trip, not just a control request.
 */
export const VALIDATE_TIMEOUT_MS = 30_000;

/**
 * What `ModelCatalog.validate()` answers. `ok: false` carries a sentence fit
 * to show the user — the CLI's own wording when it gave one.
 */
export type ModelValidation =
  | { ok: true; model: string; resolvedModel: string | null; contextWindow: number | null }
  | { ok: false; model: string; reason: string };

/** Shown when the CLI refused the model without saying why. */
const GENERIC_INVALID_REASON = 'Claude Code could not start on this model';

/**
 * Drops a trailing variant suffix: `claude-opus-5[1m]` -> `claude-opus-5`.
 * The seed table below is keyed by this stripped form, because
 * https://platform.claude.com/docs/en/about-claude/models/overview (checked
 * 2026-09-16) documents plain API ids, not Orbital's `[1m]`-suffixed ones.
 */
function stripVariant(id: string): string {
  return id.replace(/\[[^\]]*]$/, '');
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
    const variantMatch = /\[([^\]]+)]$/.exec(resolvedModel);

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
  /** In-flight validations by id, so a double submit spawns one CLI, not two. */
  private validating = new Map<string, Promise<ModelValidation>>();
  /** Successful validations for the life of the process, by id. */
  private validated = new Map<string, ModelValidation>();

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

  /**
   * The learned map as stored — exact wire id → tokens. Served beside the
   * catalog because a session can resolve to an id no catalog row carries
   * (a revived terminal session's init reports `claude-fable-5`; the SDK's
   * `supportedModels()` spells Fable `claude-fable-5-1`), and the learned
   * map is then the only honest denominator for it
   * (fix: revived-session-shows-no-context-gauge).
   */
  learnedContextWindows(): Record<string, number> {
    return this.contextWindows();
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

  /**
   * Checks that Claude Code will run on `model` — any id, not only the rows
   * `list()` serves. The SDK's `supportedModels()` lists the current
   * generation alone, so an older id the user still wants (and the CLI still
   * accepts) has to be typed in and checked some other way.
   *
   * The API cannot be asked directly: Orbital runs on the user's
   * subscription through the CLI, with no API key to call a models endpoint
   * with. So this runs one real turn instead, stripped to the minimum — no
   * Claude Code system prompt, no tools, no MCP servers, no settings
   * sources — which leaves a request of a few hundred tokens. An id the API
   * rejects costs nothing; the CLI reports it as an error result.
   *
   * Never rejects. Concurrent calls for one id share a single spawn, and a
   * success is remembered for the process lifetime: the launch itself is the
   * final check anyway, so a cached "yes" can only be wrong in a way the
   * launch will surface. Failures are not cached, so a transient outage does
   * not condemn an id.
   *
   * A success also records the turn's `modelUsage`, so the model's context
   * window is learned before its first real session.
   */
  validate(model: string): Promise<ModelValidation> {
    const cached = this.validated.get(model);
    if (cached) return Promise.resolve(cached);
    const inFlight = this.validating.get(model);
    if (inFlight) return inFlight;
    const run = this.runValidation(model)
      .then((result) => {
        if (result.ok) this.validated.set(model, result);
        return result;
      })
      .finally(() => {
        this.validating.delete(model);
      });
    this.validating.set(model, run);
    return run;
  }

  private async runValidation(model: string): Promise<ModelValidation> {
    // Exactly one user message, then the stream ends — the CLI answers it
    // and exits instead of waiting for a second turn. Async only because the
    // SDK takes an async iterable; there is nothing to await.
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* oneMessage(): AsyncGenerator<unknown> {
      yield { type: 'user', message: { role: 'user', content: 'ok' } };
    }
    const options: Record<string, unknown> = {
      cwd: this.cwd,
      model,
      maxTurns: 1,
      tools: [],
      systemPrompt: 'Reply with the single word ok.',
      strictMcpConfig: true,
      mcpServers: {},
      settingSources: [],
    };
    // Same reason as in `probe()`.
    if (this.claudeExecutablePath) options.pathToClaudeCodeExecutable = this.claudeExecutablePath;
    const q = this.queryFn({ prompt: oneMessage(), options });

    let result: Record<string, unknown> | null = null;
    const consume = async (): Promise<void> => {
      try {
        for await (const msg of q) {
          if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'result') {
            result = msg as Record<string, unknown>;
            break;
          }
        }
      } catch (err) {
        // After an error result the SDK throws "Claude Code returned an
        // error result" as the CLI exits. The result already says
        // everything, so only a throw before one is a failed validation.
        if (!result) throw err;
      }
    };

    try {
      await withTimeout(consume(), VALIDATE_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof TimeoutError) return { ok: false, model, reason: 'validation timed out' };
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, model, reason: message || GENERIC_INVALID_REASON };
    } finally {
      try {
        await q.return?.(undefined);
      } catch {
        // Done with the process either way.
      }
    }

    const r = result as Record<string, unknown> | null;
    if (!r) return { ok: false, model, reason: GENERIC_INVALID_REASON };
    if (r.is_error === true || r.api_error_status != null) {
      const text = typeof r.result === 'string' ? r.result.trim() : '';
      return { ok: false, model, reason: text || GENERIC_INVALID_REASON };
    }
    this.recordContextWindows(r.modelUsage);
    const usage =
      r.modelUsage && typeof r.modelUsage === 'object' ? (r.modelUsage as Record<string, unknown>) : {};
    const resolvedModel = Object.keys(usage)[0] ?? null;
    const contextWindow = resolvedModel ? extractContextWindows(usage)[resolvedModel] ?? null : null;
    return { ok: true, model, resolvedModel, contextWindow };
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
        await q.return?.(undefined);
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`model probe timed out after ${ms}ms`)), ms);
  });
  // A race rather than a hand-rolled executor, so a rejection from `promise`
  // reaches the caller as its own reason rather than being re-thrown as a new one.
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/** What `withTimeout` rejects with, so a caller can tell expiry from a failure of its own. */
class TimeoutError extends Error {}
