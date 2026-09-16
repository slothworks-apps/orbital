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
