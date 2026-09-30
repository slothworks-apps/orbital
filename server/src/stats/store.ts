import { eq } from 'drizzle-orm';
import type { OrbitalDb } from '../db/database.js';
import { permissionWaits, sessionStats } from '../db/schema.js';
import { computeStats, type PermissionWait, type StatsRollup } from './compute.js';
import { STATS_VERSION } from './constants.js';
import { readSessionEntries } from './transcript.js';

/**
 * Stores one settled permission prompt. Nothing recomputes here: the prompt
 * was answered before its tool ran, so the transcript line that closes the
 * tool is still to come, and the index pass that line triggers reads this row.
 */
export function recordPermissionWait(db: OrbitalDb, sessionId: string, wait: PermissionWait): void {
  db.insert(permissionWaits).values({ sessionId, ...wait }).run();
}

/** The session's recorded permission waits — empty for every terminal session. */
export function readPermissionWaits(db: OrbitalDb, sessionId: string): PermissionWait[] {
  return db
    .select({
      toolUseId: permissionWaits.toolUseId,
      agentToolUseId: permissionWaits.agentToolUseId,
      toolName: permissionWaits.toolName,
      shownAt: permissionWaits.shownAt,
      answeredAt: permissionWaits.answeredAt,
      outcome: permissionWaits.outcome,
    })
    .from(permissionWaits)
    .where(eq(permissionWaits.sessionId, sessionId))
    .all();
}

/** The rollup as columns — everything but the session id, which is the key. */
function statsColumns(rollup: StatsRollup) {
  return {
    apiMs: rollup.apiMs,
    localToolMs: rollup.localToolMs,
    mcpMs: rollup.mcpMs,
    subagentMs: rollup.subagentMs,
    turns: rollup.turns,
    inputTokens: rollup.inputTokens,
    outputTokens: rollup.outputTokens,
    cacheReadTokens: rollup.cacheReadTokens,
    cacheCreationTokens: rollup.cacheCreationTokens,
    cacheCreation5mTokens: rollup.cacheCreation5mTokens,
    cacheCreation1hTokens: rollup.cacheCreation1hTokens,
    thinkingTokens: rollup.thinkingTokens,
    subagentTokens: rollup.subagentTokens,
    subagentUsage: rollup.subagentUsage,
    toolCalls: rollup.toolCalls,
    toolErrors: rollup.toolErrors,
    toolBreakdown: rollup.toolBreakdown,
    findings: rollup.findings,
    humanWaitMs: rollup.humanWaitMs,
    humanBreakdown: rollup.humanBreakdown,
    permissionBreakdown: rollup.permissionBreakdown,
    statsVersion: STATS_VERSION,
  };
}

/**
 * Told after a `session_stats` row is written, with the session it belongs to.
 *
 * Every write goes through `upsertSessionStats`, so one listener here covers
 * all three cadences — the live recompute, the end-of-session write and the
 * indexer's pass. It carries no rollup: the web re-reads the endpoint, which
 * is the only place the stored row and the derived cost are assembled (ADR
 * `the-stats-row-reads-when-the-stats-are-written`).
 */
export type SessionStatsWritten = (sessionId: string) => void;

/** Writes the session's one `session_stats` row, replacing whatever was there. */
export function upsertSessionStats(
  db: OrbitalDb,
  sessionId: string,
  rollup: StatsRollup,
  onWrite?: SessionStatsWritten,
): void {
  const columns = statsColumns(rollup);
  db.insert(sessionStats)
    .values({ sessionId, ...columns })
    .onConflictDoUpdate({ target: sessionStats.sessionId, set: columns })
    .run();
  onWrite?.(sessionId);
}

/**
 * Reparses a session from disk — transcript plus sidechains — and stores the
 * rollup. The whole-file reparse is deliberate: it is how the indexer already
 * handles a changed transcript, and the numbers it produces cannot be reached
 * by patching a stored row from a batch of new lines.
 */
export function recomputeSessionStats(
  db: OrbitalDb,
  sessionId: string,
  transcriptPath: string,
  onWrite?: SessionStatsWritten,
): StatsRollup {
  const { rollup } = computeStats(readSessionEntries(transcriptPath), readPermissionWaits(db, sessionId));
  upsertSessionStats(db, sessionId, rollup, onWrite);
  return rollup;
}
