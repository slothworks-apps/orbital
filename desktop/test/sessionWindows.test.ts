import { describe, expect, it } from 'vitest';
import {
  decideDetach,
  decideNotificationClick,
  isSessionId,
  parseDetachedIds,
  sessionWindowUrl,
} from '../src/lib/sessionWindows';

describe('isSessionId', () => {
  it('accepts a non-empty string', () => {
    expect(isSessionId('abc-123')).toBe(true);
  });

  it('rejects the empty string and anything that is not a string', () => {
    for (const value of ['', undefined, null, 42, {}, ['abc']]) {
      expect(isSessionId(value)).toBe(false);
    }
  });
});

describe('parseDetachedIds', () => {
  it('keeps the string ids of an array', () => {
    expect(parseDetachedIds(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('drops entries that are not ids', () => {
    expect(parseDetachedIds(['a', 1, '', null, { id: 'x' }, 'b'])).toEqual(['a', 'b']);
  });

  it('reads anything that is not an array as no detached sessions', () => {
    for (const payload of [undefined, null, 'a', { 0: 'a', length: 1 }]) {
      expect(parseDetachedIds(payload)).toEqual([]);
    }
  });
});

describe('sessionWindowUrl', () => {
  it('puts the route on the origin the main window was sent to', () => {
    expect(sessionWindowUrl('http://127.0.0.1:4737', 'abc')).toBe('http://127.0.0.1:4737/session/abc');
    expect(sessionWindowUrl('http://localhost:5173', 'abc')).toBe('http://localhost:5173/session/abc');
  });

  it("drops the main window's own path, query and hash", () => {
    expect(sessionWindowUrl('http://127.0.0.1:4737/stats?session=x#y', 'abc')).toBe(
      'http://127.0.0.1:4737/session/abc',
    );
  });

  it('keeps an id with separators inside its one path segment', () => {
    const url = new URL(sessionWindowUrl('http://127.0.0.1:4737/', 'a/../b?c#d'));
    expect(url.pathname).toBe('/session/a%2F..%2Fb%3Fc%23d');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
  });
});

describe('decideDetach', () => {
  it('opens a window for a session that has none', () => {
    expect(decideDetach('a', new Set(['b']))).toBe('open');
  });

  it('focuses the window a session already has', () => {
    expect(decideDetach('a', new Set(['a']))).toBe('focus');
  });
});

describe('decideNotificationClick', () => {
  it("sends a detached session's notification to its own window", () => {
    expect(decideNotificationClick('a', new Set(['a']))).toEqual({
      kind: 'session-window',
      sessionId: 'a',
    });
  });

  it('shows the map and selects a session that is not detached', () => {
    expect(decideNotificationClick('a', new Set(['b']))).toEqual({ kind: 'main', select: 'a' });
  });

  it('shows the map and selects nothing when the notification names no session', () => {
    expect(decideNotificationClick(null, new Set(['a']))).toEqual({ kind: 'main', select: null });
  });
});
