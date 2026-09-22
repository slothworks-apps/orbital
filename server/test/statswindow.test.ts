import { describe, it, expect } from 'vitest';
import {
  mergeHistograms,
  histogramP50,
  toolLeaderboard,
  slowMcpFindings,
  resolvedRules,
  daySeries,
  cacheRatioSeries,
  windowTotals,
  deltaVsPrevious,
  type WindowRow,
} from '../src/stats/window.js';
import {
  HIST_BUCKET_BOUNDS_MS,
  HIST_BUCKET_COUNT,
  SLOW_MCP_MIN_CALLS,
  SLOW_MCP_P50_MS,
  RESOLVED_CLEAN_SESSIONS,
  RESOLVED_TTL_DAYS,
  TOOL_LEADERBOARD_LIMIT,
} from '../src/stats/constants.js';
import type { StatsRollup, ToolStat, Finding, FindingRule, SubagentModelUsage } from '../src/stats/compute.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyBuckets(): number[] {
  return new Array(HIST_BUCKET_COUNT).fill(0);
}

function rollup(overrides: Partial<StatsRollup> = {}): StatsRollup {
  return {
    apiMs: 0, localToolMs: 0, mcpMs: 0, subagentMs: 0, turns: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, thinkingTokens: 0, subagentTokens: 0,
    subagentUsage: {},
    toolCalls: 0, toolErrors: 0, toolBreakdown: {}, findings: [],
    ...overrides,
  };
}

function subagentUsage(overrides: Partial<SubagentModelUsage> = {}): SubagentModelUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0, ...overrides };
}

function row(overrides: Omit<Partial<WindowRow>, 'rollup'> & { rollup?: Partial<StatsRollup> } = {}): WindowRow {
  const { rollup: rollupOverrides, ...rest } = overrides;
  return {
    sessionId: 's1',
    lastAt: Date.parse('2026-09-20T12:00:00.000Z'),
    projectDir: '/proj',
    model: 'claude-sonnet-5',
    rollup: rollup(rollupOverrides),
    ...rest,
  };
}

describe('mergeHistograms', () => {
  it('sums bucket counts element-wise', () => {
    const a = [1, 0, 2, 0, 0, 0, 0, 0, 0, 0];
    const b = [0, 3, 1, 0, 0, 0, 0, 0, 0, 0];
    expect(mergeHistograms(a, b)).toEqual([1, 3, 3, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('treats missing entries on either side as zero', () => {
    expect(mergeHistograms([1, 2], [1, 2, 3])).toEqual([2, 4, 3]);
  });
});

describe('histogramP50 — geometric midpoint of the median bucket', () => {
  it('returns null for an empty histogram', () => {
    expect(histogramP50(emptyBuckets())).toBeNull();
  });

  it('picks the bucket holding the median sample and returns its geometric midpoint', () => {
    // Bounds: 250, 500, 1000, 2000, ... — bucket index 2 covers [500, 1000).
    const buckets = emptyBuckets();
    buckets[2] = 5; // all mass in one bucket: the median is unambiguous
    expect(histogramP50(buckets)).toBeCloseTo(Math.sqrt(500 * 1000), 6);
  });

  it('hand-computed: cumulative count crossing the halfway mark selects the bucket', () => {
    const buckets = emptyBuckets();
    // bucket 0: [.., 250) x2, bucket 1: [250,500) x1, bucket 3: [1000,2000) x2
    buckets[0] = 2;
    buckets[1] = 1;
    buckets[3] = 2;
    // total 5, target 2.5 -> cumulative after bucket0=2 (<2.5), after bucket1=3 (>=2.5)
    // median bucket is index 1: [bounds[0], bounds[1]) = [250, 500)
    expect(histogramP50(buckets)).toBeCloseTo(Math.sqrt(250 * 500), 6);
  });

  it('extends the log2 spacing for the open bottom bucket', () => {
    const buckets = emptyBuckets();
    buckets[0] = 1;
    const first = HIST_BUCKET_BOUNDS_MS[0];
    expect(histogramP50(buckets)).toBeCloseTo(Math.sqrt((first / 2) * first), 6);
  });

  it('extends the log2 spacing for the open top bucket', () => {
    const buckets = emptyBuckets();
    buckets[buckets.length - 1] = 1;
    const last = HIST_BUCKET_BOUNDS_MS[HIST_BUCKET_BOUNDS_MS.length - 1];
    expect(histogramP50(buckets)).toBeCloseTo(Math.sqrt(last * (last * 2)), 6);
  });
});

function toolStat(overrides: Partial<ToolStat> = {}): ToolStat {
  return { calls: 0, errors: 0, ms: 0, resultChars: 0, buckets: emptyBuckets(), ...overrides };
}

describe('toolLeaderboard', () => {
  it('aggregates calls, errors, ms, resultChars and p50 per tool across rows, and flags MCP tools', () => {
    const rows: WindowRow[] = [
      row({
        sessionId: 's1',
        rollup: {
          toolBreakdown: {
            Read: toolStat({ calls: 2, errors: 0, ms: 100, resultChars: 40 }),
            'mcp__atlas__docs_read': toolStat({ calls: 3, errors: 1, ms: 9000, resultChars: 5000 }),
          },
        },
      }),
      row({
        sessionId: 's2',
        rollup: {
          toolBreakdown: {
            Read: toolStat({ calls: 1, errors: 0, ms: 50, resultChars: 10 }),
          },
        },
      }),
    ];
    const { slowest, mostExpensive } = toolLeaderboard(rows);
    const read = slowest.find((e) => e.tool === 'Read');
    expect(read).toMatchObject({ calls: 3, errors: 0, ms: 150, resultChars: 50, isMcp: false });
    const mcp = slowest.find((e) => e.tool === 'mcp__atlas__docs_read');
    expect(mcp).toMatchObject({ calls: 3, errors: 1, ms: 9000, resultChars: 5000, isMcp: true });
    expect(mostExpensive[0].tool).toBe('mcp__atlas__docs_read'); // largest resultChars first
  });

  it('sorts slowest by total ms descending and most-expensive by resultChars descending, independently', () => {
    const rows: WindowRow[] = [
      row({
        rollup: {
          toolBreakdown: {
            A: toolStat({ calls: 1, ms: 100, resultChars: 5000 }),
            B: toolStat({ calls: 1, ms: 9000, resultChars: 10 }),
          },
        },
      }),
    ];
    const { slowest, mostExpensive } = toolLeaderboard(rows);
    expect(slowest.map((e) => e.tool)).toEqual(['B', 'A']);
    expect(mostExpensive.map((e) => e.tool)).toEqual(['A', 'B']);
  });

  it('caps both rankings at the leaderboard limit', () => {
    const toolBreakdown: Record<string, ToolStat> = {};
    for (let i = 0; i < TOOL_LEADERBOARD_LIMIT + 5; i++) {
      toolBreakdown[`Tool${i}`] = toolStat({ calls: 1, ms: i + 1, resultChars: i + 1 });
    }
    const rows: WindowRow[] = [row({ rollup: { toolBreakdown } })];
    const { slowest, mostExpensive } = toolLeaderboard(rows);
    expect(slowest).toHaveLength(TOOL_LEADERBOARD_LIMIT);
    expect(mostExpensive).toHaveLength(TOOL_LEADERBOARD_LIMIT);
  });
});

describe('slowMcpFindings', () => {
  function mcpRows(opts: { calls: number; p50Bucket: number; sessions: number }): WindowRow[] {
    const rows: WindowRow[] = [];
    const perSession = Math.ceil(opts.calls / opts.sessions);
    let remaining = opts.calls;
    for (let s = 0; s < opts.sessions; s++) {
      const calls = Math.min(perSession, remaining);
      remaining -= calls;
      const buckets = emptyBuckets();
      buckets[opts.p50Bucket] = calls;
      rows.push(
        row({
          sessionId: `s${s}`,
          rollup: {
            mcpMs: calls * 100,
            toolBreakdown: { 'mcp__slow__tool': toolStat({ calls, ms: calls * 100, buckets }) },
          },
        }),
      );
    }
    return rows;
  }

  it('fires INFO when p50 and call count both clear the thresholds', () => {
    // bucket index for HIST_BUCKET_BOUNDS_MS 32000 -> [32000,64000) which is >= 5000ms p50
    const bucketIndex = HIST_BUCKET_BOUNDS_MS.indexOf(32000) + 1;
    const rows = mcpRows({ calls: SLOW_MCP_MIN_CALLS, p50Bucket: bucketIndex, sessions: 3 });
    const findings = slowMcpFindings(rows);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'slow-mcp', severity: 'info' });
    expect(findings[0].evidence.tool).toBe('mcp__slow__tool');
    expect(findings[0].evidence.calls).toBe(SLOW_MCP_MIN_CALLS);
    expect(findings[0].evidence.p50Ms).toBeGreaterThanOrEqual(SLOW_MCP_P50_MS);
    expect(findings[0].evidence.sessionCount).toBe(3);
  });

  it('does not fire below the call-count threshold even with a slow p50', () => {
    const bucketIndex = HIST_BUCKET_BOUNDS_MS.indexOf(32000) + 1;
    const rows = mcpRows({ calls: SLOW_MCP_MIN_CALLS - 1, p50Bucket: bucketIndex, sessions: 1 });
    expect(slowMcpFindings(rows)).toEqual([]);
  });

  it('does not fire below the p50 threshold even with plenty of calls', () => {
    const bucketIndex = HIST_BUCKET_BOUNDS_MS.indexOf(250); // fast bucket, index 0
    const rows = mcpRows({ calls: SLOW_MCP_MIN_CALLS * 3, p50Bucket: bucketIndex, sessions: 2 });
    expect(slowMcpFindings(rows)).toEqual([]);
  });

  it('never fires for a local (non-MCP) tool no matter how slow', () => {
    const rows: WindowRow[] = [
      row({
        rollup: {
          localToolMs: SLOW_MCP_MIN_CALLS * 40000,
          toolBreakdown: {
            Bash: toolStat({
              calls: SLOW_MCP_MIN_CALLS,
              ms: SLOW_MCP_MIN_CALLS * 40000,
              buckets: (() => {
                const b = emptyBuckets();
                b[b.length - 1] = SLOW_MCP_MIN_CALLS;
                return b;
              })(),
            }),
          },
        },
      }),
    ];
    expect(slowMcpFindings(rows)).toEqual([]);
  });

  it('is always severity info, never a higher severity', () => {
    const bucketIndex = HIST_BUCKET_BOUNDS_MS.indexOf(32000) + 1;
    const rows = mcpRows({ calls: SLOW_MCP_MIN_CALLS * 5, p50Bucket: bucketIndex, sessions: 5 });
    for (const f of slowMcpFindings(rows)) expect(f.severity).toBe('info');
  });
});

describe('resolvedRules', () => {
  const findingFor = (rule: FindingRule): Finding => ({ rule, evidence: {} });

  function sessionsAround(
    firingAt: number,
    cleanCount: number,
    opts: { rule: FindingRule; spacingMs?: number },
  ): WindowRow[] {
    const spacing = opts.spacingMs ?? 60_000;
    const rows: WindowRow[] = [
      row({ sessionId: 'firing', lastAt: firingAt, rollup: { findings: [findingFor(opts.rule)] } }),
    ];
    for (let i = 1; i <= cleanCount; i++) {
      rows.push(row({ sessionId: `clean-${i}`, lastAt: firingAt + i * spacing, rollup: { findings: [] } }));
    }
    return rows;
  }

  it('emits RESOLVED after exactly the required clean sessions, within the TTL', () => {
    const firingAt = Date.now() - DAY_MS; // 1 day ago, inside the TTL
    const rows = sessionsAround(firingAt, RESOLVED_CLEAN_SESSIONS, { rule: 'error-loop' });
    const resolved = resolvedRules(rows, Date.now());
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ rule: 'error-loop', state: 'resolved' });
    expect(resolved[0].evidence.sessionId).toBe('firing');
  });

  it('does not emit RESOLVED one clean session short of the requirement', () => {
    const firingAt = Date.now() - DAY_MS;
    const rows = sessionsAround(firingAt, RESOLVED_CLEAN_SESSIONS - 1, { rule: 'error-loop' });
    expect(resolvedRules(rows, Date.now())).toEqual([]);
  });

  it('drops the entry once the last firing is older than the TTL', () => {
    const firingAt = Date.now() - (RESOLVED_TTL_DAYS + 1) * DAY_MS;
    const rows = sessionsAround(firingAt, RESOLVED_CLEAN_SESSIONS, { rule: 'error-loop' });
    expect(resolvedRules(rows, Date.now())).toEqual([]);
  });

  it('keeps the entry exactly at the TTL boundary', () => {
    const now = Date.now();
    const firingAt = now - RESOLVED_TTL_DAYS * DAY_MS;
    const rows = sessionsAround(firingAt, RESOLVED_CLEAN_SESSIONS, { rule: 'error-loop' });
    expect(resolvedRules(rows, now)).toHaveLength(1);
  });

  it('does not emit RESOLVED for a rule that never fired', () => {
    const rows: WindowRow[] = [row({ rollup: { findings: [] } })];
    expect(resolvedRules(rows, Date.now())).toEqual([]);
  });

  it('does not emit RESOLVED for a rule that is still actively firing (no clean tail)', () => {
    const rows: WindowRow[] = [
      row({ sessionId: 's1', lastAt: Date.now() - 1000, rollup: { findings: [findingFor('cache-burn')] } }),
    ];
    expect(resolvedRules(rows, Date.now())).toEqual([]);
  });

  it('tracks the most recent firing when a rule fires, clears, then fires again', () => {
    const now = Date.now();
    const oldFiring = now - 5 * DAY_MS;
    const recentFiring = now - 1 * DAY_MS;
    const rows: WindowRow[] = [
      row({ sessionId: 'old', lastAt: oldFiring, rollup: { findings: [findingFor('obese-tool-result')] } }),
      row({ sessionId: 'mid1', lastAt: oldFiring + 1000, rollup: { findings: [] } }),
      row({ sessionId: 'recent', lastAt: recentFiring, rollup: { findings: [findingFor('obese-tool-result')] } }),
      row({ sessionId: 'c1', lastAt: recentFiring + 1000, rollup: { findings: [] } }),
      row({ sessionId: 'c2', lastAt: recentFiring + 2000, rollup: { findings: [] } }),
      row({ sessionId: 'c3', lastAt: recentFiring + 3000, rollup: { findings: [] } }),
      row({ sessionId: 'c4', lastAt: recentFiring + 4000, rollup: { findings: [] } }),
      row({ sessionId: 'c5', lastAt: recentFiring + 5000, rollup: { findings: [] } }),
    ];
    const resolved = resolvedRules(rows, now);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].evidence.sessionId).toBe('recent');
  });
});

describe('daySeries', () => {
  it('buckets sessions by the local calendar day of lastAt and sums the four categories', () => {
    const day1 = new Date(2026, 8, 20, 10, 0, 0).getTime(); // local time, Sep 20
    const day2 = new Date(2026, 8, 21, 9, 0, 0).getTime(); // Sep 21
    const rows: WindowRow[] = [
      row({ lastAt: day1, rollup: { apiMs: 100, localToolMs: 50, mcpMs: 10, subagentMs: 5 } }),
      row({ lastAt: day1 + 1000, rollup: { apiMs: 200, localToolMs: 0, mcpMs: 0, subagentMs: 0 } }),
      row({ lastAt: day2, rollup: { apiMs: 10, localToolMs: 10, mcpMs: 10, subagentMs: 10 } }),
    ];
    const series = daySeries(rows);
    expect(series).toHaveLength(2);
    const [d1, d2] = series;
    expect(d1.apiMs).toBe(300);
    expect(d1.localToolMs).toBe(50);
    expect(d1.busyMs).toBe(300 + 50 + 10 + 5);
    expect(d2.busyMs).toBe(40);
    // sorted ascending
    expect(d1.day < d2.day).toBe(true);
  });

  it('does not split a midnight-spanning session — it lands entirely on its lastAt day', () => {
    // A session that started the day before lastAt still counts wholly on lastAt's day.
    const late = new Date(2026, 8, 21, 0, 30, 0).getTime(); // just after local midnight
    const rows: WindowRow[] = [row({ lastAt: late, rollup: { apiMs: 999 } })];
    const series = daySeries(rows);
    expect(series).toHaveLength(1);
    const expectedDay = `${2026}-09-21`;
    expect(series[0].day).toBe(expectedDay);
    expect(series[0].apiMs).toBe(999);
  });
});

describe('cacheRatioSeries', () => {
  it('computes cacheRead / (input + cacheRead + cacheCreation) per day', () => {
    const day = new Date(2026, 8, 20, 10, 0, 0).getTime();
    const rows: WindowRow[] = [
      row({ lastAt: day, rollup: { inputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 100 } }),
    ];
    const series = cacheRatioSeries(rows);
    expect(series).toHaveLength(1);
    expect(series[0].ratio).toBeCloseTo(300 / 500, 6);
  });

  it('reports null ratio for a day with no priced tokens at all', () => {
    const day = new Date(2026, 8, 20, 10, 0, 0).getTime();
    const rows: WindowRow[] = [row({ lastAt: day, rollup: {} })];
    expect(cacheRatioSeries(rows)[0].ratio).toBeNull();
  });
});

describe('windowTotals', () => {
  it('sums tokens, busy split, wall clock and cost, and computes cost per session', () => {
    const rows: WindowRow[] = [
      row({
        model: 'claude-sonnet-5',
        wallClockMs: 10_000,
        rollup: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, apiMs: 100 },
      }),
      row({
        model: 'claude-opus-5',
        wallClockMs: 5_000,
        rollup: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, apiMs: 50 },
      }),
    ];
    const totals = windowTotals(rows);
    expect(totals.inputTokens).toBe(2_000_000);
    expect(totals.outputTokens).toBe(1_000_000);
    expect(totals.cacheReadTokens).toBe(1_000_000);
    expect(totals.wallClockMs).toBe(15_000);
    expect(totals.apiMs).toBe(150);
    expect(totals.sessionCount).toBe(2);
    // sonnet: 1*$2 + 1*$10 = 12; opus: 1*$5 + 1*$0.5(cache read) = 5.5
    expect(totals.costTotal).toBeCloseTo(12 + 5.5, 6);
    expect(totals.costPerSession).toBeCloseTo(totals.costTotal / 2, 6);
    expect(totals.cachedRatio).toBeCloseTo(1_000_000 / (2_000_000 + 1_000_000), 6);
  });

  it('treats a missing wallClockMs as zero and returns nulls for an empty window', () => {
    const totals = windowTotals([]);
    expect(totals.sessionCount).toBe(0);
    expect(totals.costTotal).toBe(0);
    expect(totals.costPerSession).toBeNull();
    expect(totals.cachedRatio).toBeNull();
    expect(totals.wallClockMs).toBe(0);
  });

  // Finding 3 / controller Ruling 11 — subagent spend must enter the window
  // cost total, priced per the subagent's own (often cheaper) model.
  it('folds subagent spend into costTotal, priced at the subagent\'s own model rate', () => {
    const rows: WindowRow[] = [
      row({
        model: 'claude-sonnet-5',
        rollup: {
          inputTokens: 1_000_000,
          subagentUsage: { 'claude-haiku-4-5': subagentUsage({ input: 1_000_000 }) },
        },
      }),
    ];
    const totals = windowTotals(rows);
    // sonnet main thread: 1*$2 = 2; haiku subagent: 1*$1 = 1
    expect(totals.costTotal).toBeCloseTo(2 + 1, 6);
  });
});

describe('deltaVsPrevious', () => {
  it('computes a positive percentage change', () => {
    expect(deltaVsPrevious(118, 100)).toBeCloseTo(18, 6);
  });

  it('computes a negative percentage change', () => {
    expect(deltaVsPrevious(80, 100)).toBeCloseTo(-20, 6);
  });

  it('returns 0 when both current and previous are zero', () => {
    expect(deltaVsPrevious(0, 0)).toBe(0);
  });

  it('returns null when previous is zero but current is not — no baseline to compare against', () => {
    expect(deltaVsPrevious(50, 0)).toBeNull();
  });
});
