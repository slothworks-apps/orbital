/**
 * Auto-compact between turns (spec 2026-10-10-auto-compact-between-turns-design):
 * Orbital sends `/compact` into a quiet session whose context passed the
 * user's threshold. The pure half lives here; the timer lives in the Runner.
 */

export const AUTO_COMPACT_ENABLED_KEY = 'auto_compact_enabled';
export const AUTO_COMPACT_THRESHOLD_KEY = 'auto_compact_threshold_tokens';
export const AUTO_COMPACT_QUIET_KEY = 'auto_compact_quiet_seconds';

export const DEFAULT_AUTO_COMPACT_THRESHOLD = 200_000;
export const DEFAULT_AUTO_COMPACT_QUIET_SECONDS = 120;
const MIN_THRESHOLD = 50_000;
const MAX_THRESHOLD = 900_000;
/** Below `SLEEP_AFTER_IDLE_MINUTES`: a session that sleeps first is not woken to compact. */
const MAX_QUIET_SECONDS = 1500;

/** The tag that marks a `/compact` as Orbital's own (adr an-orbital-tag-marks-a-walkthrough-turn). */
export const AUTO_COMPACT_TAG = 'orbital-auto-compact';

export interface AutoCompactSettings {
  thresholdTokens: number;
  quietMs: number;
}

function clampedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** The feature's settings, or null while it is off. */
export function parseAutoCompactSettings(get: (key: string) => string | undefined): AutoCompactSettings | null {
  if (get(AUTO_COMPACT_ENABLED_KEY) !== 'true') return null;
  return {
    thresholdTokens: clampedInt(get(AUTO_COMPACT_THRESHOLD_KEY), DEFAULT_AUTO_COMPACT_THRESHOLD, MIN_THRESHOLD, MAX_THRESHOLD),
    quietMs:
      clampedInt(get(AUTO_COMPACT_QUIET_KEY), DEFAULT_AUTO_COMPACT_QUIET_SECONDS, 0, MAX_QUIET_SECONDS) * 1000,
  };
}

export interface AutoCompactCandidate {
  status: string;
  hasDecision: boolean;
  compacting: boolean;
  /** Orbital already compacted it (or a compaction failed) since the last turn someone started. */
  blocked: boolean;
  contextUsedTokens: number | null;
}

export function shouldAutoCompact(s: AutoCompactCandidate, settings: AutoCompactSettings | null): boolean {
  return (
    settings !== null &&
    s.status === 'needs_input' &&
    !s.hasDecision &&
    !s.compacting &&
    !s.blocked &&
    s.contextUsedTokens !== null &&
    s.contextUsedTokens >= settings.thresholdTokens
  );
}

export function autoCompactPrompt(thresholdTokens: number): string {
  return (
    `/compact <${AUTO_COMPACT_TAG} threshold="${thresholdTokens}">` +
    'Orbital is compacting between turns because the context passed the threshold the user set. ' +
    'Keep what the next turn needs to carry on with the current task.' +
    `</${AUTO_COMPACT_TAG}>`
  );
}

/** Whether a prompt is Orbital's own `/compact`. */
export function isAutoCompactPrompt(text: string): boolean {
  return /^\/compact\s/.test(text.trim()) && text.includes(`<${AUTO_COMPACT_TAG}`);
}
