import type { TranscriptEntry } from './parser.js';

export interface SubagentInfo {
  id: string;
  name: string;
  state: 'working' | 'ended';
}

/**
 * The tool names that spawn a subagent. Claude Code 2.1.236 calls it `Agent`;
 * `Task` is what earlier versions called the same thing, and transcripts
 * written by them are still on disk. Both are accepted, because a version bump
 * renaming this silently is exactly how this detection broke the first time.
 */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * Tracks subagents across multiple 'entries' batches. TranscriptTail
 * delivers the Task tool_use and its matching tool_result in separate batches
 * (they can be written minutes apart; the tail only debounces 150ms), so state
 * must persist across calls to `feed()` rather than being recomputed per batch
 * — otherwise the tool_result batch finds no tracked agent and the 'ended'
 * transition is silently dropped.
 */
export class SubagentTracker {
  private agents = new Map<string, SubagentInfo>();

  /** Feed one batch of entries; returns only the agents whose state changed (or was newly created) in this call. */
  feed(entries: TranscriptEntry[]): SubagentInfo[] {
    const touched = new Set<string>();
    for (const e of entries) {
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_use' && SUBAGENT_TOOLS.has(String(block.name))) {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const name =
            (typeof input.description === 'string' && input.description) ||
            (typeof input.subagent_type === 'string' && input.subagent_type) ||
            'subagent';
          const id = String(block.id);
          this.agents.set(id, { id, name, state: 'working' });
          touched.add(id);
        } else if (block.type === 'tool_result') {
          const id = String(block.tool_use_id);
          const existing = this.agents.get(id);
          if (existing) {
            existing.state = 'ended';
            touched.add(id);
          }
        }
      }
    }
    return [...touched].map((id) => this.agents.get(id)!);
  }

  /** Every agent this tracker has seen that has not reported a result yet. */
  running(): SubagentInfo[] {
    return [...this.agents.values()].filter((a) => a.state === 'working');
  }
}

/** One-shot convenience wrapper over `SubagentTracker` for callers with a single, complete batch of entries. */
export function trackSubagents(entries: TranscriptEntry[]): SubagentInfo[] {
  return new SubagentTracker().feed(entries);
}

/**
 * The server's single source of truth for "which subagents are running right
 * now", keyed by session. Everything that can observe a `Task` call feeds it
 * — the live-transcript watcher, the on-demand tail, the SDK runner — and
 * everything that reports subagents (`toApiSession`, and through it both the
 * REST shape and the `sessions` topic) reads it.
 *
 * `feed` returns whether the *running* set changed rather than which agents
 * were touched: callers turn that into "republish this session", and the same
 * entries reaching the store from two readers of one transcript must not
 * cause a second publish.
 */
export class SubagentStore {
  private trackers = new Map<string, SubagentTracker>();

  /** Feed one batch of entries for a session; true if `get()` would now answer differently. */
  feed(sessionId: string, entries: TranscriptEntry[]): boolean {
    let tracker = this.trackers.get(sessionId);
    if (!tracker) {
      tracker = new SubagentTracker();
      this.trackers.set(sessionId, tracker);
    }
    const before = this.get(sessionId);
    tracker.feed(entries);
    return !sameAgents(before, this.get(sessionId));
  }

  /** The session's still-running subagents; `ended` ones are never reported. */
  get(sessionId: string): SubagentInfo[] {
    return this.trackers.get(sessionId)?.running() ?? [];
  }

  /** Forget a session entirely — it ended, so nothing of it is still running. */
  drop(sessionId: string): void {
    this.trackers.delete(sessionId);
  }
}

function sameAgents(a: SubagentInfo[], b: SubagentInfo[]): boolean {
  return a.length === b.length && a.every((agent, i) => agent.id === b[i].id);
}
