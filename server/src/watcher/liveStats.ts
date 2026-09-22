import type { OrbitalDb } from '../db/database.js';
import { STATS_LIVE_RECOMPUTE_TURNS } from '../stats/constants.js';
import { recomputeSessionStats, type SessionStatsWritten } from '../stats/store.js';
import type { TranscriptEntry } from '../transcript/parser.js';

export interface LiveStatsOptions {
  db: OrbitalDb;
  /** The session's transcript on disk, or null while its project is unknown. */
  transcriptPathOf: (sessionId: string) => string | null;
  /** Told after each rollup this writes — see `SessionStatsWritten`. */
  onStats?: SessionStatsWritten;
}

/** How far a session has run since its rollup was last written. */
interface Cadence {
  turns: number;
  /** The requestId of the turn being counted, so its later entries do not recount it. */
  openRequestId: string | null;
}

/**
 * The live half of the stats cadence (spec
 * `2026-09-20-session-stats-design` § Evaluation cadence): a session's rollup
 * is rewritten every `STATS_LIVE_RECOMPUTE_TURNS` turns while it runs, and
 * once when it ends. The indexer covers everything else.
 *
 * Counting turns off the tail's entries is the whole point of keeping state
 * here: the recompute itself reparses the transcript, so deciding whether one
 * is due must not.
 */
export class LiveSessionStats {
  private cadence = new Map<string, Cadence>();

  constructor(private opts: LiveStatsOptions) {}

  /** Feed the entries the tail just read for a session; recomputes when due. */
  feed(sessionId: string, entries: TranscriptEntry[]): void {
    let state = this.cadence.get(sessionId);
    if (!state) {
      state = { turns: 0, openRequestId: null };
      this.cadence.set(sessionId, state);
    }
    for (const entry of entries) {
      // Sidechain entries are a subagent's, and the CLI writes one entry per
      // content block — so a turn is a new requestId on the main chain. An
      // entry from before requestId existed is its own turn, which is the same
      // fallback `computeStats` uses.
      if (entry.type !== 'assistant' || entry.isSidechain) continue;
      const requestId = entry.requestId ?? '';
      if (requestId && requestId === state.openRequestId) continue;
      state.openRequestId = requestId || null;
      state.turns++;
    }
    if (state.turns < STATS_LIVE_RECOMPUTE_TURNS) return;
    state.turns = 0;
    this.recompute(sessionId);
  }

  /** The session is over: write its final rollup and forget the cadence. */
  end(sessionId: string): void {
    this.cadence.delete(sessionId);
    this.recompute(sessionId);
  }

  /** Stop tracking a session without recomputing — nobody is watching it any more. */
  drop(sessionId: string): void {
    this.cadence.delete(sessionId);
  }

  private recompute(sessionId: string): void {
    const path = this.opts.transcriptPathOf(sessionId);
    if (!path) return;
    try {
      recomputeSessionStats(this.opts.db, sessionId, path, this.opts.onStats);
    } catch (err) {
      console.warn(`orbital: failed to compute stats for ${sessionId}:`, err);
    }
  }
}
