import { beforeEach, describe, expect, it } from 'vitest';
import { SessionNotifier } from '../src/lib/notifications';

/** An `upsert` frame as the hub publishes it (the full ApiSession, trimmed). */
function upsert(session: Record<string, unknown>) {
  return { topic: 'sessions', event: 'upsert', session };
}

function status(sessionId: string, value: string) {
  return { topic: 'sessions', event: 'status', sessionId, status: value };
}

describe('SessionNotifier', () => {
  let notifier: SessionNotifier;

  beforeEach(() => {
    notifier = new SessionNotifier();
  });

  describe('first sighting', () => {
    it('seeds silently from an upsert, however alarming the status', () => {
      // Registry rescans flood upserts for sessions that have been waiting for
      // hours; notifying on those would fire on every reconnect.
      expect(notifier.onEvent(upsert({ id: 's1', title: 'Map', status: 'needs_input' }))).toBeNull();
    });

    it('seeds silently from a status frame', () => {
      expect(notifier.onEvent(status('s1', 'needs_input'))).toBeNull();
    });

    it('seeds from an upsert and notifies on the NEXT transition', () => {
      notifier.onEvent(upsert({ id: 's1', title: 'Map', status: 'working' }));
      expect(notifier.onEvent(status('s1', 'needs_input'))).toEqual({
        title: 'Map',
        body: 'Needs your input',
        sessionId: 's1',
      });
    });
  });

  describe('transitions', () => {
    beforeEach(() => {
      notifier.onEvent(upsert({ id: 's1', title: 'Map', cwd: '/Users/x/code/orbital', status: 'working' }));
    });

    it('notifies when a working session wants input', () => {
      expect(notifier.onEvent(status('s1', 'needs_input'))).toEqual({
        title: 'Map',
        body: 'Needs your input',
        sessionId: 's1',
      });
    });

    it('notifies when a working session ends', () => {
      expect(notifier.onEvent(status('s1', 'ended'))).toEqual({
        title: 'Map',
        body: 'Session ended',
        sessionId: 's1',
      });
    });

    it('stays quiet when a terminal session ages out into ended', () => {
      // idle → ended is a timer in the registry, not something that happened.
      notifier.onEvent(status('s1', 'idle'));
      expect(notifier.onEvent(status('s1', 'ended'))).toBeNull();
    });

    it('stays quiet when a waiting session ages out into ended', () => {
      notifier.onEvent(status('s1', 'needs_input'));
      expect(notifier.onEvent(status('s1', 'ended'))).toBeNull();
    });

    it('notifies once, not on every repeat of the same status', () => {
      expect(notifier.onEvent(status('s1', 'needs_input'))).not.toBeNull();
      expect(notifier.onEvent(status('s1', 'needs_input'))).toBeNull();
      expect(notifier.onEvent(upsert({ id: 's1', title: 'Map', status: 'needs_input' }))).toBeNull();
    });

    it('notifies again when the session goes back to work and asks again', () => {
      notifier.onEvent(status('s1', 'needs_input'));
      notifier.onEvent(status('s1', 'working'));
      expect(notifier.onEvent(status('s1', 'needs_input'))).not.toBeNull();
    });

    it('stays quiet on the other transitions', () => {
      expect(notifier.onEvent(status('s1', 'idle'))).toBeNull();
      expect(notifier.onEvent(status('s1', 'working'))).toBeNull();
    });

    it('notifies on a transition carried by an upsert, not only by a status frame', () => {
      expect(notifier.onEvent(upsert({ id: 's1', title: 'Map', status: 'needs_input' }))).toEqual({
        title: 'Map',
        body: 'Needs your input',
        sessionId: 's1',
      });
    });
  });

  describe('naming the session', () => {
    it('falls back to the basename of cwd when the title is null', () => {
      notifier.onEvent(upsert({ id: 's1', title: null, cwd: '/Users/x/code/orbital', status: 'working' }));
      expect(notifier.onEvent(status('s1', 'needs_input'))?.title).toBe('orbital');
    });

    it('falls back to "Session" when neither a title nor a cwd was ever seen', () => {
      notifier.onEvent(status('s1', 'working'));
      expect(notifier.onEvent(status('s1', 'needs_input'))?.title).toBe('Session');
    });

    it('keeps the last name an upsert carried, so status-only frames can still name it', () => {
      notifier.onEvent(upsert({ id: 's1', title: null, cwd: '/Users/x/code/orbital', status: 'working' }));
      notifier.onEvent(upsert({ id: 's1', title: 'Wire the notifier', status: 'working' }));
      expect(notifier.onEvent(status('s1', 'needs_input'))?.title).toBe('Wire the notifier');
    });

    it('treats an empty title as no title', () => {
      notifier.onEvent(upsert({ id: 's1', title: '  ', cwd: '/Users/x/code/orbital', status: 'working' }));
      expect(notifier.onEvent(status('s1', 'needs_input'))?.title).toBe('orbital');
    });
  });

  describe('errors', () => {
    it('notifies when a session fails, naming it from what upserts taught us', () => {
      notifier.onEvent(upsert({ id: 's1', title: 'Map', status: 'working' }));
      expect(
        notifier.onEvent({
          topic: 'errors',
          event: 'error',
          error: { kind: 'session_failed', sessionId: 's1', message: 'spawn claude ENOENT\n  at foo' },
          unseen: 1,
        }),
      ).toEqual({
        title: 'Map',
        body: 'Session failed: spawn claude ENOENT',
        sessionId: 's1',
      });
    });

    it('falls back to "Session" for a failure about a session it never saw', () => {
      const out = notifier.onEvent({
        topic: 'errors',
        event: 'error',
        error: { kind: 'session_failed', sessionId: 'ghost', message: 'boom' },
      });
      expect(out).toEqual({ title: 'Session', body: 'Session failed: boom', sessionId: 'ghost' });
    });

    it('stays quiet about the other error kinds', () => {
      for (const kind of ['api_request', 'render_crash']) {
        expect(
          notifier.onEvent({ topic: 'errors', event: 'error', error: { kind, message: 'x' } }),
        ).toBeNull();
      }
    });

    it('ignores seen events', () => {
      expect(notifier.onEvent({ topic: 'errors', event: 'seen', ids: null, unseen: 0 })).toBeNull();
    });
  });

  describe('forgetting', () => {
    it('drops a removed session, so its next sighting seeds silently again', () => {
      notifier.onEvent(upsert({ id: 's1', title: 'Map', status: 'working' }));
      expect(notifier.onEvent({ topic: 'sessions', event: 'remove', sessionId: 's1' })).toBeNull();
      expect(notifier.onEvent(status('s1', 'needs_input'))).toBeNull();
    });

    it('reset() empties everything, so the post-reconnect replay is silent', () => {
      notifier.onEvent(upsert({ id: 's1', title: 'Map', status: 'working' }));
      notifier.reset();
      expect(notifier.onEvent(status('s1', 'needs_input'))).toBeNull();
      // and the seed took, so the transition after it still speaks
      notifier.onEvent(status('s1', 'working'));
      expect(notifier.onEvent(status('s1', 'needs_input'))).not.toBeNull();
    });
  });

  describe('junk off the wire', () => {
    it('returns null for anything malformed rather than throwing', () => {
      const junk: unknown[] = [
        null,
        undefined,
        42,
        'hello',
        [],
        {},
        { topic: 'sessions' },
        { topic: 'sessions', event: 'upsert' },
        { topic: 'sessions', event: 'upsert', session: null },
        { topic: 'sessions', event: 'upsert', session: { status: 'working' } }, // no id
        { topic: 'sessions', event: 'status', status: 'ended' }, // no sessionId
        { topic: 'sessions', event: 'status', sessionId: 's1' }, // no status
        { topic: 'sessions', event: 'remove' },
        { topic: 'sessions', event: 'whatever', sessionId: 's1' },
        { topic: 'errors', event: 'error' },
        { topic: 'errors', event: 'error', error: { kind: 'session_failed' } }, // no message
        { topic: 'tags', event: 'upsert' },
      ];
      for (const frame of junk) {
        expect(() => notifier.onEvent(frame)).not.toThrow();
        expect(notifier.onEvent(frame)).toBeNull();
      }
    });

    it('ignores a status it does not understand instead of treating it as news', () => {
      notifier.onEvent(upsert({ id: 's1', title: 'Map', status: 'working' }));
      expect(notifier.onEvent(status('s1', 'hibernating'))).toBeNull();
      // and the unknown status did not overwrite what we knew
      expect(notifier.onEvent(status('s1', 'needs_input'))).not.toBeNull();
    });
  });
});
