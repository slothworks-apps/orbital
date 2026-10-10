import type { TranscriptEntry } from '../transcript/parser.js';
import { asksOrbitalCompact } from '../runner/autoCompact.js';

/**
 * What a session's compactions did, read off its transcript (spec
 * 2026-10-10-auto-compact-between-turns-design § Stats). Tokens only: money
 * is derived at read time from the pricing table, like every other stats
 * column.
 *
 * The saving is an estimate against a counterfactual — the same session with
 * Orbital's compactions left out. After each one, every later main-loop
 * request would have carried the tokens it removed on top of what it did
 * carry, until a compaction Orbital did not start (the CLI's own, or the
 * user's) would have happened anyway and the two sessions meet again.
 */
export interface CompactionStats {
  orbital: number;
  manual: number;
  auto: number;
  /** Orbital compactions whose boundary reported both figures; the sums below are over those. */
  measured: number;
  preTokens: number;
  postTokens: number;
  /** Orbital compactions whose boundary reported a duration, and its sum. */
  timed: number;
  durationMs: number;
  /** Tokens later requests did not read from the cache (a warm cache)… */
  savedReadTokens: number;
  /** …and did not write to it again (a cold one: the cache had expired). */
  savedWriteTokens: number;
  /**
   * What the compactions cost: reading the context once, writing the summary,
   * and putting the summary in the cache the request after them had to
   * write, where it would otherwise have read.
   */
  costReadTokens: number;
  costOutputTokens: number;
  costWriteTokens: number;
  /** `Read` calls, in the turn after an Orbital compaction, of a file read before it. */
  rereads: number;
  /** Main-loop requests and the context they carried — the comparison's per-request average. */
  mainRequests: number;
  contextTokens: number;
}

export function emptyCompactionStats(): CompactionStats {
  return {
    orbital: 0, manual: 0, auto: 0, measured: 0, preTokens: 0, postTokens: 0, timed: 0, durationMs: 0,
    savedReadTokens: 0, savedWriteTokens: 0, costReadTokens: 0, costOutputTokens: 0, costWriteTokens: 0,
    rereads: 0, mainRequests: 0, contextTokens: 0,
  };
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Pure, one pass in write order; never throws. */
export function computeCompactionStats(entries: TranscriptEntry[]): CompactionStats {
  const stats = emptyCompactionStats();
  const counted = new Set<string>();
  const readBefore = new Set<string>();
  /** Tokens the counterfactual session would still carry. */
  let offset = 0;
  /** The request right after an Orbital compaction: its cache write is already in the cost. */
  let afterCompaction = false;
  let orbitalAsked = false;
  /** Open from an Orbital compaction to the second human prompt after it. */
  let rereadWindow: { before: Set<string>; seen: Set<string>; prompts: number } | null = null;

  entries.forEach((entry, index) => {
    if (entry.isSidechain) return;

    if (entry.type === 'user' && entry.isCompactSummary !== true && entry.isMeta !== true) {
      const asked = asksOrbitalCompact(entry.message?.content);
      if (asked === null) return;
      orbitalAsked = asked;
      if (rereadWindow && ++rereadWindow.prompts >= 2) rereadWindow = null;
      return;
    }

    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const meta = entry.compactMetadata ?? {};
      const trigger = meta.trigger === 'manual' && orbitalAsked ? 'orbital' : meta.trigger === 'manual' ? 'manual' : 'auto';
      orbitalAsked = false;
      stats[trigger]++;
      if (trigger !== 'orbital') {
        offset = 0;
        afterCompaction = false;
        return;
      }
      const pre = num(meta.preTokens);
      const post = num(meta.postTokens);
      const duration = num(meta.durationMs);
      if (duration !== null) {
        stats.timed++;
        stats.durationMs += duration;
      }
      if (pre !== null && post !== null && pre >= post) {
        stats.measured++;
        stats.preTokens += pre;
        stats.postTokens += post;
        stats.costReadTokens += pre;
        stats.costOutputTokens += post;
        stats.costWriteTokens += post;
        offset += pre - post;
        afterCompaction = true;
      }
      rereadWindow = { before: new Set(readBefore), seen: new Set(), prompts: 0 };
      return;
    }

    if (entry.type !== 'assistant') return;
    const key = entry.requestId || (entry.message as { id?: string } | undefined)?.id || `request-${index}`;
    if (!counted.has(key)) {
      counted.add(key);
      const usage = entry.message?.usage;
      const read = num(usage?.cache_read_input_tokens) ?? 0;
      const context = (num(usage?.input_tokens) ?? 0) + read + (num(usage?.cache_creation_input_tokens) ?? 0);
      if (context > 0) {
        stats.mainRequests++;
        stats.contextTokens += context;
        if (offset > 0) {
          if (read > 0 || afterCompaction) stats.savedReadTokens += offset;
          else stats.savedWriteTokens += offset;
        }
        afterCompaction = false;
      }
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== 'tool_use' || block.name !== 'Read') continue;
      const path = (block.input as { file_path?: unknown } | undefined)?.file_path;
      if (typeof path !== 'string') continue;
      if (rereadWindow && rereadWindow.before.has(path) && !rereadWindow.seen.has(path)) {
        rereadWindow.seen.add(path);
        stats.rereads++;
      }
      readBefore.add(path);
    }
  });
  return stats;
}
