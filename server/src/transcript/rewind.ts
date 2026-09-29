import type { ChatMessage } from '../types.js';
import type { ImageWriter } from '../images/store.js';
import { entriesToMessages, type TranscriptEntry } from './parser.js';
import { isHumanPrompt, readBranch, type ForkPoint } from './liveBranch.js';

/**
 * What the rewind feature reads off a transcript (spec
 * 2026-09-29-rewind-design): which user messages can be picked, where each
 * one would fork, and where the dividers of rewinds already made go. All of
 * it comes from the file's live branch, so it is computed once per read of
 * the file and cached with it; what the database adds (a pending cut, the
 * counts of sent rewinds) is applied per request by `presentBranch`.
 */

/** One pickable user entry. */
export interface RewindTarget {
  /** The target's `parentUuid`: where `resumeSessionAt` continues from. */
  forkUuid: string;
  /**
   * The target is the newest human prompt on the live branch, so the range a
   * rewind drops is exactly one turn and the CLI's `resumeDropsTurn` guard
   * accepts it. A deeper rewind goes unguarded.
   */
  newest: boolean;
  /** What the composer gets back: the text the human typed. */
  text: string;
}

export interface BranchRead {
  /** The live branch as wire messages, pickable user rows marked `rewindable`. */
  messages: ChatMessage[];
  targets: Map<string, RewindTarget>;
  /** Each live entry's position in the file, by uuid — what a cut compares. */
  order: Map<string, number>;
  /**
   * Where the live branch passes a rewind. `before` is the position of the
   * live side's first entry: the divider goes ahead of it.
   */
  forks: Array<ForkPoint & { before: number }>;
}

/** A rewind Orbital sent, as the `rewinds` table holds it. */
export interface SentRewind {
  forkUuid: string;
  targetUuid: string;
  hiddenCount: number;
  /** Epoch ms. */
  at: number;
}

function isBoundary(e: TranscriptEntry): boolean {
  return e.type === 'system' && e.subtype === 'compact_boundary' && e.isSidechain !== true;
}

/** A user row the human could recognise as theirs: text, an image, or a slash command they typed. */
function pickable(m: ChatMessage): boolean {
  return (
    m.role === 'user' &&
    (Boolean(m.text?.trim()) || Boolean(m.images?.length) || Boolean(m.command?.name))
  );
}

/**
 * The text a picked message puts back in the composer: what the human typed,
 * or for a bare slash command the command as they typed it.
 */
function composerText(rows: ChatMessage[]): string {
  const typed = rows.map((m) => m.text?.trim() ?? '').filter(Boolean).join('\n\n');
  if (typed) return typed;
  const command = rows.find((m) => m.command?.name)?.command;
  if (!command?.name) return '';
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(command.body)?.[1]?.trim();
  return args ? `${command.name} ${args}` : command.name;
}

/**
 * Reads a parsed transcript for the rewind feature.
 *
 * A user entry is a target when it is a human prompt on the live branch, it
 * has conversation before it (an assistant entry, or a compaction — the first
 * prompt of a session has only start-up attachments), and it comes after the
 * branch's newest `compact_boundary`: the CLI cannot fork before one (spec §
 * Which messages can be picked).
 */
export function readTranscriptBranch(entries: readonly TranscriptEntry[], images?: ImageWriter): BranchRead {
  const branch = readBranch(entries);
  const list = branch.entries;
  const order = new Map<string, number>();
  list.forEach((e, i) => {
    if (typeof e.uuid === 'string' && !order.has(e.uuid)) order.set(e.uuid, i);
  });

  let lastBoundary = -1;
  let newest: string | null = null;
  list.forEach((e, i) => {
    if (isBoundary(e)) lastBoundary = i;
    if (e.isSidechain !== true && isHumanPrompt(e) && typeof e.uuid === 'string') newest = e.uuid;
  });
  const candidates = new Map<string, string>();
  let conversation = false;
  list.forEach((e, i) => {
    if (e.isSidechain === true) return;
    if (
      conversation && i > lastBoundary && isHumanPrompt(e) &&
      typeof e.uuid === 'string' && typeof e.parentUuid === 'string'
    ) {
      candidates.set(e.uuid, e.parentUuid);
    }
    if (e.type === 'assistant' || isBoundary(e)) conversation = true;
  });

  const messages = entriesToMessages(list, images);
  const rowsOf = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    if (!m.uuid || !candidates.has(m.uuid) || !pickable(m)) continue;
    const rows = rowsOf.get(m.uuid);
    if (rows) rows.push(m);
    else rowsOf.set(m.uuid, [m]);
  }
  const targets = new Map<string, RewindTarget>();
  for (const [uuid, rows] of rowsOf) {
    targets.set(uuid, { forkUuid: candidates.get(uuid)!, newest: uuid === newest, text: composerText(rows) });
  }
  const marked = messages.map((m) =>
    m.role === 'user' && m.uuid && rowsOf.get(m.uuid)?.includes(m) ? { ...m, rewindable: true as const } : m,
  );

  const forks: BranchRead['forks'] = [];
  for (const fork of branch.forks) {
    const child = list.find(
      (e) => e.parentUuid === fork.parentUuid && isHumanPrompt(e) && typeof e.uuid === 'string',
    );
    const before = child ? order.get(child.uuid!) : undefined;
    if (before !== undefined) forks.push({ ...fork, before });
  }
  return { messages: marked, targets, order, forks };
}

/** The divider's id: the same whether it was placed by a landing cut or by the fork it became. */
function dividerId(forkUuid: string, deadUuid: string): string {
  return `rewind:${forkUuid}:${deadUuid}`;
}

function divider(id: string, hiddenCount: number | null, timestamp: string | undefined): ChatMessage {
  return { id, role: 'rewind', rewind: { hiddenCount }, ...(timestamp ? { timestamp } : {}) };
}

/**
 * The live branch as the messages API returns it, given what the database
 * says (spec § Pending rewind):
 *
 * - A divider at every fork. One Orbital sent carries its count; one done in
 *   the terminal carries none.
 * - A pending rewind cuts the branch before its target.
 * - So does a sent rewind whose new prompt has not reached the file yet: the
 *   target is still on the live branch until it does, and showing the old
 *   branch again for that moment would be a lie about what the CLI resumed.
 *   Its divider goes at the cut.
 *
 * `cutAt` is the timestamp of the first message cut, for anything merged in
 * afterwards by time.
 */
export function presentBranch(
  read: BranchRead,
  db: { pendingTarget: string | null; sent: readonly SentRewind[] },
): { messages: ChatMessage[]; cutAt: string | null } {
  const byTime = [...db.sent].sort((a, b) => b.at - a.at);
  const insertions = read.forks
    .map((fork) => {
      const row =
        byTime.find((r) => r.forkUuid === fork.parentUuid && r.targetUuid === fork.deadUuid) ??
        byTime.find((r) => r.forkUuid === fork.parentUuid);
      const at = row ? new Date(row.at).toISOString() : undefined;
      return {
        before: fork.before,
        message: divider(dividerId(fork.parentUuid, fork.deadUuid), row?.hiddenCount ?? null, at),
      };
    })
    .sort((a, b) => a.before - b.before);

  let cut: number | undefined;
  let landing: ChatMessage | null = null;
  if (db.pendingTarget !== null) {
    cut = read.order.get(db.pendingTarget);
  } else if (byTime[0] && read.order.has(byTime[0].targetUuid)) {
    const row = byTime[0];
    cut = read.order.get(row.targetUuid);
    landing = divider(dividerId(row.forkUuid, row.targetUuid), row.hiddenCount, new Date(row.at).toISOString());
  }

  const out: ChatMessage[] = [];
  let next = 0;
  let cutAt: string | null = null;
  for (const m of read.messages) {
    const at = m.uuid ? read.order.get(m.uuid) : undefined;
    if (at !== undefined) {
      if (cut !== undefined && at >= cut) {
        cutAt = m.timestamp ?? null;
        break;
      }
      while (next < insertions.length && insertions[next].before <= at) out.push(insertions[next++].message);
    }
    out.push(m);
  }
  if (landing) out.push(landing);
  return { messages: out, cutAt };
}
