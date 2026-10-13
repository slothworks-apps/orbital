/**
 * One session's full media list — the main transcript's and its subagents'
 * (specs 2026-10-09-session-media-design, 2026-10-13-session-media-more-design).
 * The one place that builds it: `GET /api/sessions/:id/media` answers with it,
 * and anything listing media across sessions calls it per session.
 */
import type { MediaItem } from '@orbital/shared/media';
import type { ChatMessage, SessionRow } from '../types.js';
import { SUBAGENT_TOOLS } from '../transcript/subagents.js';
import { StampedCache, fileStamp } from '../transcript/stampedCache.js';
import { readSubagentFile, subagentFiles } from '../walkthrough/subagents.js';
import type { ImageWriter } from '../transcript/parser.js';
import { locateMedia, mediaCandidates, type LocateMedia } from './items.js';

export interface SessionMediaContext {
  /** The session's row; undefined for an unknown id. */
  row(id: string): SessionRow | undefined;
  /** The transcript as the panel presents it; null for an unknown id. */
  presentTranscript(id: string): ChatMessage[] | null;
  /** Where the session's named and written files are looked for. */
  locate(id: string, row: SessionRow): LocateMedia;
  /** Each subagent's media candidates, by the `Agent` call that launched it (`SubagentMedia`). */
  subagents(id: string, row: SessionRow): ReadonlyMap<string, MediaItem[]>;
}

/**
 * How many subagent transcripts' candidates are kept. Each is a handful of
 * small objects, so the count can be generous: it only has to hold the
 * subagents of the sessions being looked at.
 */
const SUBAGENT_MEDIA_ENTRIES = 2000;

/**
 * Subagents' media candidates, each held under its transcript's and meta's
 * stamps: a request re-reads only the agents whose files moved since the
 * last one, never the whole directory (spec 2026-10-13-session-media-more-design
 * § Performance).
 */
export class SubagentMedia {
  private cache = new StampedCache<MediaItem[]>(SUBAGENT_MEDIA_ENTRIES);

  constructor(private readonly images?: ImageWriter) {}

  /** The candidates of every joinable subagent beside `transcriptPath`, by `toolUseId`. */
  read(transcriptPath: string): Map<string, MediaItem[]> {
    const out = new Map<string, MediaItem[]>();
    for (const file of subagentFiles(transcriptPath)) {
      const stamp = `${fileStamp(file.transcript) ?? '-'}#${fileStamp(file.meta) ?? '-'}`;
      const items = this.cache.get(file.transcript, stamp, () => {
        const messages = readSubagentFile(file.transcript, this.images);
        return messages ? mediaCandidates(messages) : [];
      });
      if (items.length) out.set(file.toolUseId, items);
    }
    return out;
  }
}

/** The moon's name for an `Agent` call, as `SubagentTracker` gives it. */
function agentName(input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  return (
    (typeof args.description === 'string' && args.description) ||
    (typeof args.subagent_type === 'string' && args.subagent_type) ||
    'subagent'
  );
}

/** A sort key per item: its time, or the one before it in its own list when its own is unreadable. */
function keyed(items: readonly MediaItem[]): Array<{ item: MediaItem; at: number }> {
  let last = -Infinity;
  return items.map((item) => {
    const at = Date.parse(item.ts);
    if (!Number.isNaN(at)) last = at;
    return { item, at: last };
  });
}

/**
 * Lists merged by time, each list's own order kept; on a tie the earlier list
 * goes first, so the main transcript's item stands before a subagent's.
 */
function mergeByTime(lists: ReadonlyArray<readonly MediaItem[]>): MediaItem[] {
  const queues = lists.map(keyed);
  const heads = queues.map(() => 0);
  const out: MediaItem[] = [];
  for (;;) {
    let pick = -1;
    for (let q = 0; q < queues.length; q++) {
      if (heads[q] >= queues[q].length) continue;
      if (pick === -1 || queues[q][heads[q]].at < queues[pick][heads[pick]].at) pick = q;
    }
    if (pick === -1) return out;
    out.push(queues[pick][heads[pick]++].item);
  }
}

/**
 * The session's media, oldest first; null for an unknown session.
 *
 * A subagent's items join only when its `Agent` call is on the branch the
 * transcript presents — that call's row is where Show in transcript goes,
 * and a call a rewind took away takes its subagent's media with it.
 */
export function sessionMedia(ctx: SessionMediaContext, sessionId: string): MediaItem[] | null {
  const row = ctx.row(sessionId);
  const messages = row && ctx.presentTranscript(sessionId);
  if (!row || !messages) return null;
  const locate = ctx.locate(sessionId, row);
  const main = locateMedia(mediaCandidates(messages), locate);

  const subagents = ctx.subagents(sessionId, row);
  if (subagents.size === 0) return main;
  const calls = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role === 'tool_use' && m.toolUseId && m.toolName && SUBAGENT_TOOLS.has(m.toolName)) calls.set(m.toolUseId, m);
  }
  const lists: MediaItem[][] = [main];
  for (const [toolUseId, candidates] of subagents) {
    const call = calls.get(toolUseId);
    if (!call) continue;
    const subagent = { toolUseId, name: agentName(call.toolInput) };
    const items = locateMedia(
      candidates.map((c) => ({ ...c, id: `${toolUseId}/${c.id}`, messageId: call.id, subagent })),
      locate,
    );
    if (items.length) lists.push(items);
  }
  return mergeByTime(lists);
}
