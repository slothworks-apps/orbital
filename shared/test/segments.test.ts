import { describe, expect, it } from 'vitest';
import { sessionOfRequest, sessionOfTopic } from '../src/remote/segments.js';

describe('sessionOfRequest', () => {
  it('reads the session of a path, never of a literal sibling of :id', () => {
    expect(sessionOfRequest('/api/sessions/abc%3A1/interrupt')).toBe('abc:1');
    expect(sessionOfRequest('/api/sessions/abc')).toBe('abc');
    expect(sessionOfRequest('/api/stats/sessions/abc')).toBe('abc');
    expect(sessionOfRequest('/api/sessions/abc?session=other')).toBe('abc');
    expect(sessionOfRequest('/api/sessions/count')).toBeNull();
    expect(sessionOfRequest('/api/sessions/defaults?x=1')).toBeNull();
  });

  it('falls back to ?session=, then ?sessionId=', () => {
    expect(sessionOfRequest('/api/files/preview?session=xyz&path=a')).toBe('xyz');
    expect(sessionOfRequest('/api/harness/templates?sessionId=h1')).toBe('h1');
    expect(sessionOfRequest('/api/sessions/count?session=s')).toBe('s');
  });

  it('names none for a path without one, or an id that does not decode', () => {
    expect(sessionOfRequest('/api/settings')).toBeNull();
    expect(sessionOfRequest('/api/sessions/%E0%A4%A')).toBeNull();
  });
});

describe('sessionOfTopic', () => {
  it('reads the session of a per-session topic', () => {
    expect(sessionOfTopic('session:a')).toBe('a');
    expect(sessionOfTopic('subagent:a:agent')).toBe('a');
    expect(sessionOfTopic('task-output:a:t')).toBe('a');
    expect(sessionOfTopic('sessions')).toBeNull();
    expect(sessionOfTopic('session:')).toBeNull();
  });
});
