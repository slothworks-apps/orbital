import type { FastifyInstance } from 'fastify';
import { and, eq, gte, lt, lte, type SQL } from 'drizzle-orm';
import { join } from 'node:path';
import { sessions, sessionStats } from '../db/schema.js';
import { computeStats, type StatsRollup, type TurnSegment } from '../stats/compute.js';
import { costOf, costOfSubagentUsage, severityOf, type Severity } from '../stats/pricing.js';
import {
  cacheRatioSeries,
  daySeries,
  deltaVsPrevious,
  resolvedRules,
  slowMcpFindings,
  toolLeaderboard,
  windowTotals,
  type WindowRow,
  type WindowTotals,
} from '../stats/window.js';
import { readSessionEntries } from '../stats/transcript.js';
import type { RouteContext } from './routes.js';

type WindowParam = '24h' | '7d' | '30d' | 'all';

/** Wall-clock span each non-`all` window covers, ending now. */
const WINDOW_MS: Record<Exclude<WindowParam, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function isWindowParam(v: string): v is WindowParam {
  return v === '24h' || v === '7d' || v === '30d' || v === 'all';
}

/** One `session_stats ⋈ sessions` row, flattened rather than drizzle's default
 * nested-by-table shape (the indexer's join does the same for the same reason). */
interface JoinedRow {
  sessionId: string;
  title: string;
  projectDir: string;
  /** `sessions.resolvedModel` — the id the pricing table's prefixes match, not the requested `model` value. */
  model: string | null;
  lastAt: number;
  firstAt: number | null;
  rollup: StatsRollup;
}

function emptyStatsRollup(): StatsRollup {
  return {
    apiMs: 0, localToolMs: 0, mcpMs: 0, subagentMs: 0, turns: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, thinkingTokens: 0, subagentTokens: 0,
    subagentUsage: {}, toolCalls: 0, toolErrors: 0, toolBreakdown: {}, findings: [],
  };
}

/**
 * The overview's row source: an inner join, so a session not yet indexed for
 * stats (no `session_stats` row) is excluded rather than shown with a zeroed
 * rollup — it will appear once the indexer catches up.
 */
function fetchJoinedRows(ctx: RouteContext, conditions: SQL[]): JoinedRow[] {
  const rows = ctx.db
    .select({
      sessionId: sessions.id,
      title: sessions.title,
      projectDir: sessions.projectDir,
      model: sessions.resolvedModel,
      lastAt: sessions.lastAt,
      firstAt: sessions.firstAt,
      apiMs: sessionStats.apiMs,
      localToolMs: sessionStats.localToolMs,
      mcpMs: sessionStats.mcpMs,
      subagentMs: sessionStats.subagentMs,
      turns: sessionStats.turns,
      inputTokens: sessionStats.inputTokens,
      outputTokens: sessionStats.outputTokens,
      cacheReadTokens: sessionStats.cacheReadTokens,
      cacheCreationTokens: sessionStats.cacheCreationTokens,
      cacheCreation5mTokens: sessionStats.cacheCreation5mTokens,
      cacheCreation1hTokens: sessionStats.cacheCreation1hTokens,
      thinkingTokens: sessionStats.thinkingTokens,
      subagentTokens: sessionStats.subagentTokens,
      subagentUsage: sessionStats.subagentUsage,
      toolCalls: sessionStats.toolCalls,
      toolErrors: sessionStats.toolErrors,
      toolBreakdown: sessionStats.toolBreakdown,
      findings: sessionStats.findings,
    })
    .from(sessionStats)
    .innerJoin(sessions, eq(sessions.id, sessionStats.sessionId))
    .where(and(...conditions))
    .all();

  // `lastAt` is nullable in the schema, but every row here passed the
  // `lte(sessions.lastAt, now)` condition below, which a NULL can never
  // satisfy — so the cast is safe, not an assumption.
  return rows.map((r) => ({
    sessionId: r.sessionId,
    title: r.title,
    projectDir: r.projectDir,
    model: r.model,
    lastAt: r.lastAt as number,
    firstAt: r.firstAt,
    rollup: {
      apiMs: r.apiMs, localToolMs: r.localToolMs, mcpMs: r.mcpMs, subagentMs: r.subagentMs, turns: r.turns,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens, cacheCreation5mTokens: r.cacheCreation5mTokens,
      cacheCreation1hTokens: r.cacheCreation1hTokens, thinkingTokens: r.thinkingTokens,
      subagentTokens: r.subagentTokens, subagentUsage: r.subagentUsage,
      toolCalls: r.toolCalls, toolErrors: r.toolErrors, toolBreakdown: r.toolBreakdown, findings: r.findings,
    },
  }));
}

function toWindowRow(r: JoinedRow): WindowRow {
  return {
    sessionId: r.sessionId,
    lastAt: r.lastAt,
    projectDir: r.projectDir,
    // Empty rather than the pricing/leaderboard functions ever seeing null —
    // an unresolved model prices as DEFAULT_PRICING, same as an unrecognised one.
    model: r.model ?? '',
    rollup: r.rollup,
    wallClockMs: r.firstAt !== null ? Math.max(0, r.lastAt - r.firstAt) : undefined,
  };
}

interface FindingFeedEntry {
  rule: string;
  /** The canvas's fourth finding-card treatment (10d) sits alongside the three real severities, not above or below them. */
  severity: Severity | 'resolved';
  sessionId: string | null;
  title: string | null;
  projectDir: string | null;
  when: number;
  evidence: Record<string, unknown>;
}

/**
 * Per-session findings (stored, priced at each session's own model) merged
 * with the window-level `slow-mcp` and RESOLVED entries, newest first. None
 * of the three sources carries a finding timestamp of its own: a per-session
 * finding is dated by its session's `lastAt`, `slow-mcp` by "now" (it is a
 * live aggregate, not tied to one moment), and RESOLVED by the evidence's
 * `firedAt` — the last session where the rule actually fired.
 */
function findingsFeed(rows: JoinedRow[], windowRows: WindowRow[], now: number): FindingFeedEntry[] {
  const bySession = new Map(rows.map((r) => [r.sessionId, r]));
  const resolved = resolvedRules(windowRows, now);
  // A resolved rule is a state its firing moves into, not a second card next
  // to the first (10d treats RESOLVED as one of four card states, the same
  // slot CRITICAL/WARNING/INFO occupy) — so the raw per-session finding for
  // the *resolving* session is suppressed here and replaced by the RESOLVED
  // entry below. `resolvedRules` only ever reports the LAST firing of a
  // rule in the window, so the key must be rule+session, not rule alone: an
  // earlier session where the same rule fired is a separate, still-real
  // CRITICAL/WARNING/INFO card and must survive in the feed (controller
  // ruling after a review finding — the rule-only key silently deleted
  // every earlier firing of a rule with only its last one resolved).
  const resolvedKeys = new Set(resolved.map((f) => `${f.rule}::${f.evidence.sessionId}`));
  const out: FindingFeedEntry[] = [];

  for (const r of rows) {
    for (const finding of r.rollup.findings) {
      if (resolvedKeys.has(`${finding.rule}::${r.sessionId}`)) continue;
      out.push({
        rule: finding.rule,
        severity: severityOf(finding, r.model ?? ''),
        sessionId: r.sessionId,
        title: r.title,
        projectDir: r.projectDir,
        when: r.lastAt,
        evidence: finding.evidence,
      });
    }
  }

  for (const f of slowMcpFindings(windowRows)) {
    out.push({
      rule: f.rule,
      severity: f.severity,
      sessionId: null,
      title: null,
      projectDir: null,
      when: now,
      evidence: f.evidence,
    });
  }

  for (const f of resolved) {
    const session = bySession.get(f.evidence.sessionId);
    out.push({
      rule: f.rule,
      severity: 'resolved',
      sessionId: f.evidence.sessionId,
      title: session?.title ?? null,
      projectDir: session?.projectDir ?? null,
      when: f.evidence.firedAt,
      evidence: f.evidence,
    });
  }

  return out.sort((a, b) => b.when - a.when);
}

function rollupFromStoredRow(row: typeof sessionStats.$inferSelect): StatsRollup {
  return {
    apiMs: row.apiMs, localToolMs: row.localToolMs, mcpMs: row.mcpMs, subagentMs: row.subagentMs,
    turns: row.turns, inputTokens: row.inputTokens, outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens, cacheCreationTokens: row.cacheCreationTokens,
    cacheCreation5mTokens: row.cacheCreation5mTokens, cacheCreation1hTokens: row.cacheCreation1hTokens,
    thinkingTokens: row.thinkingTokens, subagentTokens: row.subagentTokens, subagentUsage: row.subagentUsage,
    toolCalls: row.toolCalls, toolErrors: row.toolErrors, toolBreakdown: row.toolBreakdown, findings: row.findings,
  };
}

export function registerStatsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;

  app.get('/api/stats/overview', (req, reply) => {
    const q = req.query as Record<string, string>;
    const window = q.window ?? '7d';
    if (!isWindowParam(window)) {
      return reply.code(400).send({ error: 'window must be 24h, 7d, 30d or all' });
    }
    const project = q.project || null;
    const model = q.model || null;
    const now = Date.now();
    const windowMs = window === 'all' ? null : WINDOW_MS[window];
    const windowStart = windowMs === null ? null : now - windowMs;

    const conditions: SQL[] = [lte(sessions.lastAt, now)];
    if (windowStart !== null) conditions.push(gte(sessions.lastAt, windowStart));
    if (project) conditions.push(eq(sessions.projectDir, project));
    if (model) conditions.push(eq(sessions.resolvedModel, model));

    const rows = fetchJoinedRows(ctx, conditions);
    const windowRows = rows.map(toWindowRow);
    const totals = windowTotals(windowRows);

    // `all` has no "same length" window before it to compare against.
    let previousTotals: WindowTotals | null = null;
    let costDeltaPct: number | null = null;
    if (windowMs !== null && windowStart !== null) {
      const prevConditions: SQL[] = [
        gte(sessions.lastAt, windowStart - windowMs),
        lt(sessions.lastAt, windowStart),
      ];
      if (project) prevConditions.push(eq(sessions.projectDir, project));
      if (model) prevConditions.push(eq(sessions.resolvedModel, model));
      previousTotals = windowTotals(fetchJoinedRows(ctx, prevConditions).map(toWindowRow));
      costDeltaPct = deltaVsPrevious(totals.costTotal, previousTotals.costTotal);
    }

    return {
      filters: { window, project, model },
      sessionCount: rows.length,
      windowStart,
      windowEnd: now,
      totals,
      previousTotals,
      costDeltaPct,
      daySeries: daySeries(windowRows),
      cacheRatioSeries: cacheRatioSeries(windowRows),
      toolLeaderboard: toolLeaderboard(windowRows),
      findings: findingsFeed(rows, windowRows, now),
    };
  });

  app.get('/api/stats/sessions/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    // The turn timeline is a fresh full-transcript (+ subagents) reparse on
    // every read, and only the surfaces that draw the waterfall — the
    // drilldown and the open quick dialog — need it. The readout row re-reads
    // on every `stats` event and shows only the rollup and cost, so it asks
    // without the flag and pays nothing for the timeline it does not use (ADR
    // `the-stats-row-reads-when-the-stats-are-written`, "What remains").
    const wantTimeline = (req.query as Record<string, string>).timeline === '1';
    const sessionRow = db
      .select({
        id: sessions.id,
        title: sessions.title,
        projectDir: sessions.projectDir,
        model: sessions.model,
        resolvedModel: sessions.resolvedModel,
        firstAt: sessions.firstAt,
        lastAt: sessions.lastAt,
      })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (!sessionRow) return reply.code(404).send({ error: 'not found' });

    // A session the indexer has not reached yet (freshly launched, or its
    // first pass hasn't run) has a row but no rollup — an empty one, not a 404,
    // matches the "session stats · —" empty state the drilldown must render.
    const statsRow = db.select().from(sessionStats).where(eq(sessionStats.sessionId, id)).get();
    const rollup = statsRow ? rollupFromStoredRow(statsRow) : emptyStatsRollup();

    // The pricing table matches on the id the CLI actually ran, not the
    // requested value (`opus[1m]` vs `claude-opus-5`) — same as the overview.
    const pricingModel = sessionRow.resolvedModel ?? '';
    const mainCost = costOf(rollup, pricingModel);
    const subagentTotal = costOfSubagentUsage(rollup.subagentUsage);

    // The on-demand timeline (Ruling 7): re-read the transcript + its
    // subagent files through Task 3's helper and recompute — never the
    // stored rollup, which is what `rollup` above already is. A session with
    // no `project_dir` yet (just launched) has no file to read at all.
    let turns: TurnSegment[] = [];
    if (wantTimeline && sessionRow.projectDir) {
      try {
        const path = join(ctx.projectsDir, sessionRow.projectDir, `${id}.jsonl`);
        turns = computeStats(readSessionEntries(path)).turns;
      } catch (err) {
        // Transcript missing or unreadable: the waterfall is empty, the rest
        // of the drilldown (stored rollup, cost, findings) still answers. Name
        // the session so a corrupt transcript is diagnosable rather than silent.
        console.warn(`stats: could not read timeline for session ${id}:`, err);
      }
    }

    return {
      session: {
        id: sessionRow.id,
        title: sessionRow.title,
        projectDir: sessionRow.projectDir,
        model: sessionRow.model,
        resolvedModel: sessionRow.resolvedModel,
        firstAt: sessionRow.firstAt,
        lastAt: sessionRow.lastAt,
        turns: rollup.turns,
      },
      rollup,
      cost: {
        uncachedInput: mainCost.uncachedInput,
        cacheRead: mainCost.cacheRead,
        cacheWrite: mainCost.cacheWrite,
        output: mainCost.output,
        mainTotal: mainCost.total,
        subagentTotal,
        total: mainCost.total + subagentTotal,
      },
      findings: rollup.findings.map((f) => ({
        rule: f.rule,
        severity: severityOf(f, pricingModel),
        evidence: f.evidence,
      })),
      turns,
    };
  });
}
