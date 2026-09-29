import type { TranscriptEntry } from './parser.js';

/**
 * The transcript read as its live branch (spec 2026-09-29-rewind-design §
 * Reading the live branch). The CLI records a rewind by appending the new
 * branch to the end of the file, parented to the fork point, and leaves the
 * abandoned entries in place unmarked; an interrupt leaves a dangling
 * `tool_use` the next prompt does not parent to. Every reader that walks the
 * file in order would show both branches, so each one calls this between
 * `parseTranscript` and what it does with the entries.
 */

/** The entry types that form the parent chain. Everything else passes through. */
const CHAIN_TYPES = new Set(['user', 'assistant', 'system', 'attachment', 'progress']);

/** What the walk needs of an entry — small enough for the tail to hold a file's worth. */
export interface ChainNode {
  uuid: string;
  /** Where the walk goes next: `parentUuid`, or a compaction's `logicalParentUuid`. */
  up: string | null;
  /** A user entry the human typed. See `isHumanPrompt`. */
  prompt: boolean;
  /** A user entry carrying a tool_result. */
  toolResult: boolean;
  /** An assistant entry carrying a tool_use. */
  toolUse: boolean;
}

function carries(e: TranscriptEntry, type: string, block: string): boolean {
  const content = e.message?.content;
  return e.type === type && Array.isArray(content) && content.some((b) => b?.type === block);
}

/**
 * A user entry the human typed: not the harness speaking (`isMeta`), not a
 * compaction's summary, not a tool's result. A branch holding one is a
 * conversation of its own; a branch holding none is part of the turn it
 * hangs off.
 */
export function isHumanPrompt(e: TranscriptEntry): boolean {
  return e.type === 'user' && e.isMeta !== true && e.isCompactSummary !== true && !carries(e, 'user', 'tool_result');
}

/** The entry as a chain node, or null when it is not on the parent chain at all. */
export function chainNode(e: TranscriptEntry): ChainNode | null {
  if (!CHAIN_TYPES.has(e.type) || typeof e.uuid !== 'string' || e.isSidechain === true) return null;
  const parent = typeof e.parentUuid === 'string' ? e.parentUuid : null;
  const logical =
    e.type === 'system' && e.subtype === 'compact_boundary' && typeof e.logicalParentUuid === 'string'
      ? e.logicalParentUuid
      : null;
  return {
    uuid: e.uuid,
    up: parent ?? logical,
    prompt: isHumanPrompt(e),
    toolResult: carries(e, 'user', 'tool_result'),
    toolUse: carries(e, 'assistant', 'tool_use'),
  };
}

/**
 * Where the live branch passes a rewind: `parentUuid` is the live entry both
 * branches hang off, `deadUuid` the first entry of the one that was dropped.
 * The divider after a rewind is drawn here.
 */
export interface ForkPoint {
  parentUuid: string;
  deadUuid: string;
}

export interface ChainWalk {
  live: Set<string>;
  forks: ForkPoint[];
}

/**
 * The live branch of a file's chain nodes (in file order, duplicates
 * included).
 *
 * The spine is the spec's walk: from the newest leaf — the node, latest in
 * the file, that no other node names as its parent — up the parents, a
 * compaction crossed by its logical parent. A uuid the file holds twice (the
 * CLI re-appends whole ranges around a compaction) counts at its first
 * occurrence, for the tip too: ranked by where it was re-appended, a
 * re-appended side leaf takes the tip for as long as nothing newer follows
 * it, and the branch collapses to the preserved range.
 *
 * The spine alone drops real conversation, so what hangs off it is judged
 * branch by branch:
 *
 * - A side branch holding a human prompt was left behind: a rewind (the new
 *   prompt hangs off the same entry), or the `/compact` prompt older
 *   transcripts hang off the pre-compaction tip. It is dead.
 * - Any other side branch belongs to the turn it hangs off. Parallel and
 *   streamed tool calls chain one `tool_use` after another, each result
 *   parents its own call, and the next step continues from whichever result
 *   landed last — so the spine passes one call of the batch and the rest,
 *   results and all, hang beside it. The exception is an interrupt's
 *   dangling `tool_use`: a call with no result, once a later prompt is on
 *   the spine, is dropped along with whatever hangs off it.
 *
 * A parent the file does not hold (yet), or none at all, continues the walk
 * at the chain node before it in the file. A real transcript has assistant
 * entries parented to uuids never written, the CLI writes some entries
 * before the parent they name, and a session opened with `/clear` starts a
 * second root after the command. Stopping there would lose everything above
 * the gap; the walk ends at the file's first chain node.
 */
export function walkChain(nodes: readonly ChainNode[]): ChainWalk {
  const first = new Map<string, number>();
  const children = new Map<string, number[]>();
  const answered = new Set<string>();
  nodes.forEach((n, i) => {
    if (first.has(n.uuid)) return;
    first.set(n.uuid, i);
    if (n.up === null) return;
    const list = children.get(n.up);
    if (list) list.push(i);
    else children.set(n.up, [i]);
    if (n.toolResult) answered.add(n.up);
  });

  let tip: string | null = null;
  for (const [uuid, i] of first) {
    if (!children.has(uuid) && (tip === null || i > first.get(tip)!)) tip = uuid;
  }

  const live = new Set<string>();
  /** Each spine node's child on the spine — what tells a rewind from a `/compact`. */
  const spineChild = new Map<string, ChainNode>();
  let lastPrompt = -1;
  let below: ChainNode | null = null;
  let at = tip === null ? undefined : first.get(tip);
  while (at !== undefined && !live.has(nodes[at].uuid)) {
    const node = nodes[at];
    live.add(node.uuid);
    if (below) spineChild.set(node.uuid, below);
    if (node.prompt && at > lastPrompt) lastPrompt = at;
    below = node;
    const up = node.up === null ? undefined : first.get(node.up);
    at = up ?? (at > 0 ? at - 1 : undefined);
  }

  const spine = new Set(live);
  const forks: ForkPoint[] = [];
  for (const [uuid, i] of first) {
    const root = nodes[i];
    if (spine.has(uuid) || root.up === null || !spine.has(root.up)) continue;
    const branch: number[] = [];
    const stack = [i];
    while (stack.length) {
      const j = stack.pop()!;
      branch.push(j);
      stack.push(...(children.get(nodes[j].uuid) ?? []));
    }
    if (branch.some((j) => nodes[j].prompt)) {
      if (spineChild.get(root.up)?.prompt) forks.push({ parentUuid: root.up, deadUuid: uuid });
      continue;
    }
    const dropped = new Set<string>();
    for (const j of branch.sort((a, b) => a - b)) {
      const n = nodes[j];
      if (n.up !== null && dropped.has(n.up)) dropped.add(n.uuid);
      else if (n.toolUse && !answered.has(n.uuid) && j < lastPrompt) dropped.add(n.uuid);
      else live.add(n.uuid);
    }
  }
  return { live, forks };
}

export interface Branch<T> extends ChainWalk {
  /** The file's entries on the live branch, uuid-less metadata included, in file order. */
  entries: T[];
}

export function readBranch<T extends TranscriptEntry>(entries: readonly T[]): Branch<T> {
  const nodes: Array<ChainNode | null> = entries.map(chainNode);
  const { live, forks } = walkChain(nodes.filter((n): n is ChainNode => n !== null));
  const seen = new Set<string>();
  const out = entries.filter((e, i) => {
    const node = nodes[i];
    if (!node) return true;
    if (seen.has(node.uuid)) return false;
    seen.add(node.uuid);
    return live.has(node.uuid);
  });
  return { entries: out, live, forks };
}

/** The entries of the live branch — what every transcript reader reads. */
export function liveBranch<T extends TranscriptEntry>(entries: readonly T[]): T[] {
  return readBranch(entries).entries;
}

/** What the tail does with a batch of appended entries. */
export type FollowResult =
  | { kind: 'append'; entries: TranscriptEntry[] }
  /** The branch changed under the reader: a rewind, or an interrupt's dangling call dropped. */
  | { kind: 'reset' };

/** An entry a reader shows — what a branch change has to take away to matter. */
function isShown(e: TranscriptEntry): boolean {
  return (e.type === 'user' || e.type === 'assistant' || e.type === 'system') && e.isMeta !== true;
}

/**
 * The live branch followed across appends, for the tail (spec § Reading the
 * live branch, the tail). It holds the whole file's chain nodes and walks
 * them again on every batch — about a millisecond on the largest local
 * transcript — rather than judging each appended entry against the leaf
 * alone: the CLI writes parallel results, hook attachments and the odd entry
 * out of order, and every entry-by-entry rule tried against local
 * transcripts either reloaded on ordinary tool calls or missed a rewind whose
 * new branch opens with a system entry.
 *
 * A batch that leaves on the branch everything the reader was shown appends
 * its live entries (the chainless ones pass through). One that takes a shown
 * entry off it is a reset: the reader reads the transcript again. Entries off
 * the branch are dropped. An entry whose parent comes later in the same
 * batch — the CLI writes a result before its call now and then — is moved
 * after it; one whose parent is not in the batch either goes out in place,
 * since a real transcript also has parents that are never written, and does
 * not count as shown.
 */
export class BranchFollower {
  private nodes: ChainNode[] = [];
  private known = new Set<string>();
  /** Every entry of a kind a reader shows, live or not. */
  private showable = new Set<string>();
  /** What the reader holds right now. */
  private shown = new Set<string>();

  constructor(history: readonly TranscriptEntry[] = []) {
    this.take(history);
    this.settle(walkChain(this.nodes).live);
  }

  append(entries: readonly TranscriptEntry[]): FollowResult {
    const fresh = this.take(entries);
    const { live } = walkChain(this.nodes);
    for (const uuid of this.shown) {
      if (!live.has(uuid)) {
        this.settle(live);
        return { kind: 'reset' };
      }
    }
    // A parent later in this batch, by uuid, and what waits for it.
    const later = new Set<string>();
    const held = new Map<string, TranscriptEntry[]>();
    for (const e of fresh) later.add(e.uuid!);
    const out: TranscriptEntry[] = [];
    const emit = (e: TranscriptEntry) => {
      const node = chainNode(e);
      if (!node) return void out.push(e);
      later.delete(node.uuid);
      if (node.up !== null && later.has(node.up)) {
        const waiting = held.get(node.up);
        if (waiting) waiting.push(e);
        else held.set(node.up, [e]);
        return;
      }
      if (live.has(node.uuid)) {
        out.push(e);
        // Placed by the bridge, not by its parent, it can leave the branch
        // when the parent turns up; that is not a change worth a reload.
        const placed = node.up === null || this.known.has(node.up);
        if (placed && this.showable.has(node.uuid)) this.shown.add(node.uuid);
      }
      const waiting = held.get(node.uuid);
      held.delete(node.uuid);
      waiting?.forEach(emit);
    };
    for (const e of entries) if (!chainNode(e) || fresh.has(e)) emit(e);
    return { kind: 'append', entries: out };
  }

  /** After a full read: the reader holds the live branch. */
  private settle(live: ReadonlySet<string>): void {
    this.shown = new Set([...this.showable].filter((uuid) => live.has(uuid)));
  }

  /** Records the entries' chain nodes; returns the ones that are a uuid's first occurrence. */
  private take(entries: readonly TranscriptEntry[]): Set<TranscriptEntry> {
    const fresh = new Set<TranscriptEntry>();
    for (const e of entries) {
      const node = chainNode(e);
      if (!node) continue;
      this.nodes.push(node);
      if (this.known.has(node.uuid)) continue;
      this.known.add(node.uuid);
      fresh.add(e);
      if (isShown(e)) this.showable.add(node.uuid);
    }
    return fresh;
  }
}
