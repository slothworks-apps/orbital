import { toolKind, type FindingRule, type StatsRollup } from './compute.js';
import { costOf, costOfSubagentUsage } from './pricing.js';
import {
  HIST_BUCKET_BOUNDS_MS,
  HIST_BUCKET_COUNT,
  RESOLVED_CLEAN_SESSIONS,
  RESOLVED_TTL_DAYS,
  SLOW_MCP_MIN_CALLS,
  SLOW_MCP_P50_MS,
  TOOL_LEADERBOARD_LIMIT,
} from './constants.js';

/**
 * One per-session input row the window-level derivations fold over. Task 4
 * assembles these from `session_stats ⋈ sessions`; `wallClockMs` is its own
 * job to compute (`sessions.lastAt − firstAt`) since that pair does not live
 * in `StatsRollup`.
 */
export interface WindowRow {
  sessionId: string;
  /** Epoch ms — the bucketing key for daySeries/cacheRatioSeries and the sort key for resolvedRules. */
  lastAt: number;
  projectDir: string;
  model: string;
  rollup: StatsRollup;
  wallClockMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Elementwise sum; a histogram missing an index (mismatched lengths) contributes zero there. */
export function mergeHistograms(a: number[], b: number[]): number[] {
  const length = Math.max(a.length, b.length);
  const out = new Array<number>(length).fill(0);
  for (let i = 0; i < length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

/**
 * The [lower, upper) bound pair a bucket index represents. The two open-ended
 * buckets (below the first bound, above the last) have no real lower/upper
 * bound to average — extending the same log2 spacing the bounds already use
 * keeps their geometric midpoint meaningful instead of collapsing to zero or
 * infinity.
 */
function bucketRange(index: number): [number, number] {
  const bounds = HIST_BUCKET_BOUNDS_MS;
  if (index <= 0) return [bounds[0] / 2, bounds[0]];
  if (index >= bounds.length) return [bounds[bounds.length - 1], bounds[bounds.length - 1] * 2];
  return [bounds[index - 1], bounds[index]];
}

/**
 * p50 estimated as the geometric midpoint of the bucket holding the median
 * sample — exact enough for the leaderboard and slow-mcp without keeping
 * every individual duration (spec §Data model, `toolBreakdown.buckets`).
 */
export function histogramP50(buckets: number[]): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const target = total / 2;
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    cumulative += buckets[i];
    if (cumulative >= target) {
      const [lower, upper] = bucketRange(i);
      return Math.sqrt(lower * upper);
    }
  }
  const [lower, upper] = bucketRange(buckets.length - 1);
  return Math.sqrt(lower * upper);
}

export interface ToolLeaderboardEntry {
  tool: string;
  isMcp: boolean;
  calls: number;
  errors: number;
  ms: number;
  p50Ms: number | null;
  resultChars: number;
}

export interface ToolLeaderboard {
  slowest: ToolLeaderboardEntry[];
  mostExpensive: ToolLeaderboardEntry[];
}

function aggregateToolBreakdown(rows: WindowRow[]) {
  const agg = new Map<string, { calls: number; errors: number; ms: number; resultChars: number; buckets: number[] }>();
  for (const row of rows) {
    for (const [name, stat] of Object.entries(row.rollup.toolBreakdown)) {
      const entry = agg.get(name) ?? {
        calls: 0,
        errors: 0,
        ms: 0,
        resultChars: 0,
        buckets: new Array<number>(HIST_BUCKET_COUNT).fill(0),
      };
      entry.calls += stat.calls;
      entry.errors += stat.errors;
      entry.ms += stat.ms;
      entry.resultChars += stat.resultChars;
      entry.buckets = mergeHistograms(entry.buckets, stat.buckets);
      agg.set(name, entry);
    }
  }
  return agg;
}

/** Per tool across the window, both rankings capped at TOOL_LEADERBOARD_LIMIT (spec §API, overview endpoint). */
export function toolLeaderboard(rows: WindowRow[]): ToolLeaderboard {
  const agg = aggregateToolBreakdown(rows);
  const entries: ToolLeaderboardEntry[] = Array.from(agg.entries()).map(([tool, v]) => ({
    tool,
    isMcp: toolKind(tool) === 'mcp',
    calls: v.calls,
    errors: v.errors,
    ms: v.ms,
    p50Ms: histogramP50(v.buckets),
    resultChars: v.resultChars,
  }));
  const slowest = [...entries].sort((a, b) => b.ms - a.ms).slice(0, TOOL_LEADERBOARD_LIMIT);
  const mostExpensive = [...entries].sort((a, b) => b.resultChars - a.resultChars).slice(0, TOOL_LEADERBOARD_LIMIT);
  return { slowest, mostExpensive };
}

export interface SlowMcpFinding {
  rule: 'slow-mcp';
  severity: 'info';
  evidence: {
    tool: string;
    p50Ms: number;
    calls: number;
    totalMs: number;
    shareOfMcpTime: number;
    sessionCount: number;
  };
}

/**
 * Window-level, never stored (spec §Heuristic findings): an MCP tool whose
 * merged p50 and call count both clear their thresholds server-wide. Always
 * INFO — this rule never escalates, unlike the priced per-session findings.
 */
export function slowMcpFindings(rows: WindowRow[]): SlowMcpFinding[] {
  let totalMcpMs = 0;
  const agg = new Map<string, { calls: number; ms: number; buckets: number[]; sessions: Set<string> }>();
  for (const row of rows) {
    totalMcpMs += row.rollup.mcpMs;
    for (const [name, stat] of Object.entries(row.rollup.toolBreakdown)) {
      if (toolKind(name) !== 'mcp') continue;
      const entry = agg.get(name) ?? {
        calls: 0,
        ms: 0,
        buckets: new Array<number>(HIST_BUCKET_COUNT).fill(0),
        sessions: new Set<string>(),
      };
      entry.calls += stat.calls;
      entry.ms += stat.ms;
      entry.buckets = mergeHistograms(entry.buckets, stat.buckets);
      if (stat.calls > 0) entry.sessions.add(row.sessionId);
      agg.set(name, entry);
    }
  }

  const out: SlowMcpFinding[] = [];
  for (const [tool, v] of agg) {
    if (v.calls < SLOW_MCP_MIN_CALLS) continue;
    const p50 = histogramP50(v.buckets);
    if (p50 === null || p50 < SLOW_MCP_P50_MS) continue;
    out.push({
      rule: 'slow-mcp',
      severity: 'info',
      evidence: {
        tool,
        p50Ms: p50,
        calls: v.calls,
        totalMs: v.ms,
        shareOfMcpTime: totalMcpMs > 0 ? v.ms / totalMcpMs : 0,
        sessionCount: v.sessions.size,
      },
    });
  }
  return out;
}

export interface ResolvedFinding {
  rule: FindingRule;
  state: 'resolved';
  evidence: {
    sessionId: string;
    firedAt: number;
  };
}

const STORED_FINDING_RULES: FindingRule[] = ['cache-burn', 'obese-tool-result', 'error-loop'];

/**
 * Per stored rule: if it fired at some session and every session since (by
 * `lastAt`) is clean, and that run of clean sessions has reached
 * RESOLVED_CLEAN_SESSIONS, the rule is RESOLVED — unless its last firing is
 * older than RESOLVED_TTL_DAYS, in which case it simply drops off the feed
 * (spec §Heuristic findings: "drops off the feed after 7 days").
 */
export function resolvedRules(rows: WindowRow[], now: number): ResolvedFinding[] {
  const sorted = [...rows].sort((a, b) => a.lastAt - b.lastAt);
  const out: ResolvedFinding[] = [];

  for (const rule of STORED_FINDING_RULES) {
    let lastFiringIndex = -1;
    sorted.forEach((row, i) => {
      if (row.rollup.findings.some((f) => f.rule === rule)) lastFiringIndex = i;
    });
    if (lastFiringIndex === -1) continue; // never fired in the window

    const cleanTail = sorted.slice(lastFiringIndex + 1);
    if (cleanTail.length < RESOLVED_CLEAN_SESSIONS) continue; // still active, or not enough clean sessions yet

    const firingRow = sorted[lastFiringIndex];
    const ageMs = now - firingRow.lastAt;
    if (ageMs > RESOLVED_TTL_DAYS * DAY_MS) continue; // too old: drops off the feed entirely

    out.push({ rule, state: 'resolved', evidence: { sessionId: firingRow.sessionId, firedAt: firingRow.lastAt } });
  }
  return out;
}

/** `YYYY-MM-DD` in local time — the bucketing key daySeries/cacheRatioSeries share. */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface DayBusy {
  day: string;
  apiMs: number;
  localToolMs: number;
  mcpMs: number;
  subagentMs: number;
  busyMs: number;
}

/**
 * Per calendar day, keyed by each session's `lastAt` in local time. A
 * midnight-spanning session is not split across two days — it lands wholly
 * on its `lastAt` day (controller ruling, spec §Web UI dashboard).
 */
export function daySeries(rows: WindowRow[]): DayBusy[] {
  const byDay = new Map<string, DayBusy>();
  for (const row of rows) {
    const day = localDayKey(row.lastAt);
    const entry = byDay.get(day) ?? { day, apiMs: 0, localToolMs: 0, mcpMs: 0, subagentMs: 0, busyMs: 0 };
    entry.apiMs += row.rollup.apiMs;
    entry.localToolMs += row.rollup.localToolMs;
    entry.mcpMs += row.rollup.mcpMs;
    entry.subagentMs += row.rollup.subagentMs;
    entry.busyMs = entry.apiMs + entry.localToolMs + entry.mcpMs + entry.subagentMs;
    byDay.set(day, entry);
  }
  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
}

export interface CacheRatioDay {
  day: string;
  ratio: number | null;
}

/** Per day, cacheRead / (input + cacheRead + cacheCreation) — the trend line behind the ≥80% target guide. */
export function cacheRatioSeries(rows: WindowRow[]): CacheRatioDay[] {
  const byDay = new Map<string, { cacheRead: number; input: number; cacheCreation: number }>();
  for (const row of rows) {
    const day = localDayKey(row.lastAt);
    const entry = byDay.get(day) ?? { cacheRead: 0, input: 0, cacheCreation: 0 };
    entry.cacheRead += row.rollup.cacheReadTokens;
    entry.input += row.rollup.inputTokens;
    entry.cacheCreation += row.rollup.cacheCreationTokens;
    byDay.set(day, entry);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => {
      const total = v.input + v.cacheRead + v.cacheCreation;
      return { day, ratio: total > 0 ? v.cacheRead / total : null };
    });
}

export interface WindowTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** cacheRead / (input + cacheRead + cacheCreation); null when the window priced no tokens at all. */
  cachedRatio: number | null;
  apiMs: number;
  localToolMs: number;
  mcpMs: number;
  subagentMs: number;
  busyMs: number;
  wallClockMs: number;
  costTotal: number;
  costPerSession: number | null;
  sessionCount: number;
}

/** The overview's stat tiles: tokens, busy split, wall clock and cost, each session priced by its own model. */
export function windowTotals(rows: WindowRow[]): WindowTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let apiMs = 0;
  let localToolMs = 0;
  let mcpMs = 0;
  let subagentMs = 0;
  let wallClockMs = 0;
  let costTotal = 0;

  for (const row of rows) {
    inputTokens += row.rollup.inputTokens;
    outputTokens += row.rollup.outputTokens;
    cacheReadTokens += row.rollup.cacheReadTokens;
    cacheCreationTokens += row.rollup.cacheCreationTokens;
    apiMs += row.rollup.apiMs;
    localToolMs += row.rollup.localToolMs;
    mcpMs += row.rollup.mcpMs;
    subagentMs += row.rollup.subagentMs;
    wallClockMs += row.wallClockMs ?? 0;
    // Main thread priced by the session's own model, subagents priced per
    // their own model ids — subagents often run cheaper models (Ruling 11).
    costTotal += costOf(row.rollup, row.model).total + costOfSubagentUsage(row.rollup.subagentUsage);
  }

  const pricedTotal = inputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cachedRatio: pricedTotal > 0 ? cacheReadTokens / pricedTotal : null,
    apiMs,
    localToolMs,
    mcpMs,
    subagentMs,
    busyMs: apiMs + localToolMs + mcpMs + subagentMs,
    wallClockMs,
    costTotal,
    costPerSession: rows.length > 0 ? costTotal / rows.length : null,
    sessionCount: rows.length,
  };
}

/**
 * Percentage change of `current` over `previous`, for the "+18% vs prev 7d"
 * tile line. Null when `previous` is zero and `current` is not — there is no
 * baseline to express a percentage against.
 */
export function deltaVsPrevious(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}
