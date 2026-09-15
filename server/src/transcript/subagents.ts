import type { TranscriptEntry } from './parser.js';

export interface SubagentInfo {
  id: string;
  name: string;
  state: 'working' | 'ended';
}

export function trackSubagents(entries: TranscriptEntry[]): SubagentInfo[] {
  const agents = new Map<string, SubagentInfo>();
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
        agents.set(String(block.id), { id: String(block.id), name, state: 'working' });
      } else if (block.type === 'tool_result') {
        const existing = agents.get(String(block.tool_use_id));
        if (existing) existing.state = 'ended';
      }
    }
  }
  return [...agents.values()];
}
