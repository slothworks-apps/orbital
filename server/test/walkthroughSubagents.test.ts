import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSubagentMessages } from '../src/walkthrough/subagents.js';
import { makeTmpDir } from './tmp.js';

function sessionDir() {
  const root = makeTmpDir('wt');
  const transcript = join(root, 'sess.jsonl');
  writeFileSync(transcript, '{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}\n');
  const agents = join(root, 'sess', 'subagents');
  mkdirSync(agents, { recursive: true });
  return { transcript, agents };
}

const line = (o: unknown) => JSON.stringify(o) + '\n';

describe('readSubagentMessages', () => {
  it('returns an empty map without a subagents directory', () => {
    const root = makeTmpDir('wt');
    const t = join(root, 'x.jsonl');
    writeFileSync(t, '');
    expect(readSubagentMessages(t).size).toBe(0);
  });

  it('keys each agent\'s messages by the meta file\'s toolUseId, sidechain flag cleared', () => {
    const { transcript, agents } = sessionDir();
    writeFileSync(join(agents, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'toolu_A', description: 'd' }));
    writeFileSync(join(agents, 'agent-a1.jsonl'),
      line({ type: 'user', uuid: 'x1', isSidechain: true, agentId: 'a1', message: { role: 'user', content: 'do it' } }) +
      line({ type: 'assistant', uuid: 'x2', isSidechain: true, agentId: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_E', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }] } }));
    const map = readSubagentMessages(transcript);
    expect([...map.keys()]).toEqual(['toolu_A']);
    expect(map.get('toolu_A')?.map((m) => m.role)).toEqual(['user', 'tool_use']);
  });

  it('skips an agent whose meta is missing, unreadable, or has no toolUseId', () => {
    const { transcript, agents } = sessionDir();
    writeFileSync(join(agents, 'agent-b1.jsonl'), line({ type: 'user', uuid: 'y', message: { role: 'user', content: 'x' } }));
    writeFileSync(join(agents, 'agent-b2.meta.json'), '{not json');
    writeFileSync(join(agents, 'agent-b2.jsonl'), '');
    writeFileSync(join(agents, 'agent-b3.meta.json'), JSON.stringify({ description: 'no id' }));
    writeFileSync(join(agents, 'agent-b3.jsonl'), '');
    expect(readSubagentMessages(transcript).size).toBe(0);
  });
});
