import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, extractMeta, entriesToMessages } from '../src/transcript/parser.js';

const text = readFileSync(join(import.meta.dirname, 'fixtures/transcript-basic.jsonl'), 'utf8');

describe('parseTranscript', () => {
  it('skips corrupt lines without throwing', () => {
    expect(parseTranscript(text)).toHaveLength(3);
  });
});

describe('extractMeta', () => {
  it('derives cwd, title, timestamps, count', () => {
    const meta = extractMeta(parseTranscript(text));
    expect(meta.cwd).toBe('/Users/tomin/Projects/slothworks/ergaily');
    expect(meta.title).toBe('Fix the login bug in the auth service please');
    expect(meta.firstAt).toBe(Date.parse('2026-09-01T10:00:00.000Z'));
    expect(meta.lastAt).toBe(Date.parse('2026-09-01T10:01:00.000Z'));
    expect(meta.messageCount).toBe(3);
  });
});

describe('entriesToMessages', () => {
  it('flattens content blocks to chat messages', () => {
    const msgs = entriesToMessages(parseTranscript(text));
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_use', 'tool_result']);
    expect(msgs[2]).toMatchObject({ toolName: 'Bash', toolUseId: 't1' });
    expect(msgs[3]).toMatchObject({ toolUseId: 't1', text: '3 passing' });
  });
});
