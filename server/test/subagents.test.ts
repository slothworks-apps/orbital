import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, type TranscriptEntry } from '../src/transcript/parser.js';
import { trackSubagents, SubagentTracker, SubagentStore } from '../src/transcript/subagents.js';

describe('trackSubagents', () => {
  it('marks resolved Task calls ended, open ones working; ignores non-Task tools', () => {
    const entries = parseTranscript(
      readFileSync(join(import.meta.dirname, 'fixtures/transcript-subagents.jsonl'), 'utf8'),
    );
    expect(trackSubagents(entries)).toEqual([
      { id: 'task1', name: 'test-runner', state: 'ended' },
      { id: 'task2', name: 'docs-writer', state: 'working' },
    ]);
  });

  it('uses subagent_type fallback when description missing; uses default "subagent" when both missing; ignores unmatched tool_result', () => {
    const entries: import('../src/transcript/parser.js').TranscriptEntry[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-09-01T11:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'task3', name: 'Task', input: { subagent_type: 'code-reviewer', prompt: 'review code' } },
            { type: 'tool_use', id: 'task4', name: 'Task', input: { prompt: 'do something' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-09-01T11:02:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'unmatched', content: 'orphan result' },
            { type: 'tool_result', tool_use_id: 'task3', content: 'review done' },
          ],
        },
      },
    ];
    expect(trackSubagents(entries)).toEqual([
      { id: 'task3', name: 'code-reviewer', state: 'ended' },
      { id: 'task4', name: 'subagent', state: 'working' },
    ]);
  });
});

describe('SubagentTracker', () => {
  it('carries state across separate feed() batches: tool_use and its tool_result arriving apart still yield a working then ended transition', () => {
    const tracker = new SubagentTracker();

    const toolUseBatch: TranscriptEntry[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-09-01T11:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'test-runner' } },
          ],
        },
      },
    ];
    expect(tracker.feed(toolUseBatch)).toEqual([
      { id: 'task1', name: 'test-runner', state: 'working' },
    ]);

    // Delivered as its own batch minutes later, per TranscriptTail's per-append debounce.
    const toolResultBatch: TranscriptEntry[] = [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-09-01T11:05:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'task1', content: 'tests pass' }],
        },
      },
    ];
    expect(tracker.feed(toolResultBatch)).toEqual([
      { id: 'task1', name: 'test-runner', state: 'ended' },
    ]);

    const unrelatedBatch: TranscriptEntry[] = [
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-09-01T11:06:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }],
        },
      },
    ];
    expect(tracker.feed(unrelatedBatch)).toEqual([]);
  });
});

describe('SubagentStore', () => {
  const taskUse = (id: string, description: string): TranscriptEntry => ({
    type: 'assistant',
    uuid: `a-${id}`,
    timestamp: '2026-09-01T11:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Task', input: { description } }],
    },
  });
  const taskResult = (id: string): TranscriptEntry => ({
    type: 'user',
    uuid: `u-${id}`,
    timestamp: '2026-09-01T11:05:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
  });

  it('keeps one tracker per session and reports only the still-running agents', () => {
    const store = new SubagentStore();
    store.feed('s1', [taskUse('t1', 'reviewer')]);
    store.feed('s2', [taskUse('t2', 'tester')]);

    expect(store.get('s1')).toEqual([{ id: 't1', name: 'reviewer', state: 'working' }]);
    expect(store.get('s2')).toEqual([{ id: 't2', name: 'tester', state: 'working' }]);
    expect(store.get('unknown')).toEqual([]);

    store.feed('s1', [taskResult('t1')]);
    expect(store.get('s1')).toEqual([]);
    expect(store.get('s2')).toEqual([{ id: 't2', name: 'tester', state: 'working' }]);
  });

  it('reports whether the running set changed, so callers publish only on a real change', () => {
    const store = new SubagentStore();
    expect(store.feed('s1', [taskUse('t1', 'reviewer')])).toBe(true);
    expect(store.feed('s1', [taskUse('t1', 'reviewer')])).toBe(false); // same entry replayed
    expect(store.feed('s1', [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }] } }])).toBe(false);
    expect(store.feed('s1', [taskResult('t1')])).toBe(true);
    expect(store.feed('s1', [taskResult('t1')])).toBe(false); // already ended
  });

  it('drops a session so an ended session leaves no agents behind', () => {
    const store = new SubagentStore();
    store.feed('s1', [taskUse('t1', 'reviewer')]);
    store.drop('s1');
    expect(store.get('s1')).toEqual([]);

    // A dropped session starts from scratch: the old tracker is gone, so a
    // late tool_result for an agent it used to know changes nothing.
    expect(store.feed('s1', [taskResult('t1')])).toBe(false);
  });
});

describe('the subagent tool name', () => {
  const call = (name: string): TranscriptEntry => ({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-09-16T20:00:00.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'x1', name, input: { description: 'reviewer', subagent_type: 'general-purpose' } },
      ],
    },
  });

  // Claude Code 2.1.236 spawns subagents with a tool called `Agent`; no
  // transcript on this machine contains a single `Task` tool_use any more.
  // Both names are accepted so old transcripts keep working.
  it('detects the current `Agent` tool', () => {
    expect(trackSubagents([call('Agent')])).toEqual([
      { id: 'x1', name: 'reviewer', state: 'working' },
    ]);
  });

  it('still detects the older `Task` tool', () => {
    expect(trackSubagents([call('Task')])).toEqual([
      { id: 'x1', name: 'reviewer', state: 'working' },
    ]);
  });

  it('ignores every other tool', () => {
    expect(trackSubagents([call('Bash')])).toEqual([]);
  });
});
