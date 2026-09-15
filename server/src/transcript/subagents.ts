import type { TranscriptEntry } from './parser.js';

export interface SubagentInfo {
  id: string;
  name: string;
  state: 'working' | 'ended';
}

/**
 * Tracks Task-tool subagents across multiple 'entries' batches. TranscriptTail
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
        if (block.type === 'tool_use' && block.name === 'Task') {
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
}

/** One-shot convenience wrapper over `SubagentTracker` for callers with a single, complete batch of entries. */
export function trackSubagents(entries: TranscriptEntry[]): SubagentInfo[] {
  return new SubagentTracker().feed(entries);
}
