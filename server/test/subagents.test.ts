import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript } from '../src/transcript/parser.js';
import { trackSubagents } from '../src/transcript/subagents.js';

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
