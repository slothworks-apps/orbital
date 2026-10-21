import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NEEDS_INPUT_SETTLE_MS,
  NOTIFICATIONS_TURN_ON,
  notificationsAllOff,
  parseNotificationSettings,
  SessionNotifier,
  type NotificationSettings,
  type SessionNotification,
} from '../src/notifications.js';

/** Every event on: what the fold is judged against unless a test mutes one. */
const ALL_ON: NotificationSettings = {
  needsInput: true,
  sessionEnded: true,
  sessionFailed: true,
  onlyWhenBackground: true,
  sound: true,
};

/** An `upsert` frame as the hub publishes it (the full ApiSession, trimmed). */
function upsert(session: Record<string, unknown>) {
  return { topic: 'sessions', event: 'upsert', session };
}

function status(sessionId: string, value: string) {
  return { topic: 'sessions', event: 'status', sessionId, status: value };
}

const done = (title: string, sessionId = 's1'): SessionNotification => ({ kind: 'done', title, body: 'Done', sessionId });
const asks = (title: string, sessionId = 's1'): SessionNotification => ({
  kind: 'needs_input', title, body: 'Needs your input', sessionId,
});

/**
 * A notifier whose held reports wait on a hand-run timer list: `feed` says
 * what the frames reported at once, `settle` what the held ones report once
 * their time is up, `say` both.
 */
function harness(now?: () => number) {
  const out: SessionNotification[] = [];
  const timers = new Set<() => void>();
  const notifier = new SessionNotifier({
    notify: (n) => out.push(n),
    now,
    schedule: (fn) => {
      timers.add(fn);
      return () => timers.delete(fn);
    },
  });
  notifier.setSettings(ALL_ON);
  const feed = (...frames: unknown[]): SessionNotification[] => {
    for (const frame of frames) notifier.onEvent(frame);
    return out.splice(0);
  };
  const settle = (): SessionNotification[] => {
    const due = [...timers];
    timers.clear();
    for (const fn of due) fn();
    return out.splice(0);
  };
  return {
    notifier,
    feed,
    settle,
    say: (...frames: unknown[]) => [...feed(...frames), ...settle()],
    held: () => timers.size,
  };
}

describe('SessionNotifier', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  describe('first sighting', () => {
    it('seeds silently from an upsert, however alarming the status', () => {
      // Registry rescans flood upserts for sessions that have been waiting for
      // hours; notifying on those would fire on every reconnect.
      expect(h.say(upsert({ id: 's1', title: 'Map', status: 'needs_input' }))).toEqual([]);
    });

    it('notifies on a status frame for a session it has not met', () => {
      // A status frame is a live change, never part of a replay: after a
      // reconnect the first word about a working session can be this one.
      expect(h.say(status('s1', 'needs_input'))).toEqual([done('Session')]);
    });

    it('seeds silently from a status frame that is not a question', () => {
      expect(h.say(status('s1', 'ended'), status('s2', 'idle'))).toEqual([]);
    });

    describe('an upsert that already asks', () => {
      let now = 1_000_000;
      beforeEach(() => {
        now = 1_000_000;
        h = harness(() => now);
      });

      it('is news when the session was active after the notifier started', () => {
        // A terminal session that started and asked between two registry scans.
        const fresh = { id: 's1', title: 'Map', status: 'needs_input', lastAt: now + 500, pendingDecision: { id: 'q' } };
        expect(h.say(upsert(fresh))).toEqual([asks('Map')]);
      });

      it('is a baseline when the session has been waiting since before', () => {
        expect(h.say(upsert({ id: 's1', title: 'Map', status: 'needs_input', lastAt: now - 3_600_000 }))).toEqual([]);
      });

      it('counts from the reset after a reconnect', () => {
        now += 60_000;
        h.notifier.reset();
        expect(h.say(upsert({ id: 's1', status: 'needs_input', lastAt: now - 30_000 }))).toEqual([]);
      });

      it('respects the needs-input switch', () => {
        h.notifier.setSettings({ ...ALL_ON, needsInput: false });
        expect(h.say(upsert({ id: 's1', status: 'needs_input', lastAt: now + 500 }), status('s2', 'needs_input'))).toEqual([]);
      });
    });

    it('seeds from an upsert and notifies on the NEXT transition', () => {
      h.feed(upsert({ id: 's1', title: 'Map', status: 'working' }));
      expect(h.say(status('s1', 'needs_input'))).toEqual([done('Map')]);
    });
  });

  describe('seed', () => {
    it('never notifies, not even for a transition it carries', () => {
      h.feed(upsert({ id: 's1', title: 'Map', status: 'working', lastAt: Date.now() + 1000 }));
      h.notifier.seed({ id: 's1', title: 'Map', status: 'needs_input', lastAt: Date.now() + 1000, pendingDecision: { id: 'q' } });
      h.notifier.seed({ id: 's2', title: 'Other', status: 'needs_input', lastAt: Date.now() + 1000 });
      expect(h.held()).toBe(0);
      expect(h.settle()).toEqual([]);
    });

    it('is a baseline the next transition is judged from', () => {
      h.notifier.seed({ id: 's1', title: 'Map', status: 'working' });
      expect(h.say(status('s1', 'needs_input'))).toEqual([done('Map')]);
    });
  });

  describe('transitions', () => {
    beforeEach(() => {
      h.feed(upsert({ id: 's1', title: 'Map', cwd: '/Users/x/code/orbital', status: 'working' }));
    });

    it('notifies when a working session ends, at once', () => {
      expect(h.feed(status('s1', 'ended'))).toEqual([{ kind: 'ended', title: 'Map', body: 'Session ended', sessionId: 's1' }]);
    });

    it('stays quiet when a terminal session ages out into ended', () => {
      // idle → ended is a timer in the registry, not something that happened.
      expect(h.say(status('s1', 'idle'), status('s1', 'ended'))).toEqual([]);
    });

    it('stays quiet when a waiting session ends', () => {
      h.say(status('s1', 'needs_input'));
      expect(h.say(status('s1', 'ended'))).toEqual([]);
    });

    it('notifies once, not on every repeat of the same status', () => {
      expect(h.say(status('s1', 'needs_input'))).toHaveLength(1);
      expect(h.say(status('s1', 'needs_input'), upsert({ id: 's1', title: 'Map', status: 'needs_input' }))).toEqual([]);
    });

    it('notifies again when the session goes back to work and stops again', () => {
      h.say(status('s1', 'needs_input'), status('s1', 'working'));
      expect(h.say(status('s1', 'needs_input'))).toHaveLength(1);
    });

    it('stays quiet on the other transitions', () => {
      expect(h.say(status('s1', 'idle'), status('s1', 'working'))).toEqual([]);
    });

    it('notifies on a transition carried by an upsert, not only by a status frame', () => {
      expect(h.say(upsert({ id: 's1', title: 'Map', status: 'needs_input' }))).toEqual([done('Map')]);
    });
  });

  describe('a stop that has to settle (ADR a-finished-turn-is-done-not-needs-input)', () => {
    beforeEach(() => {
      h.feed(upsert({ id: 's1', title: 'Map', status: 'working' }));
    });

    it('holds needs_input back until it settles', () => {
      expect(h.feed(status('s1', 'needs_input'))).toEqual([]);
      expect(h.held()).toBe(1);
      expect(h.settle()).toEqual([done('Map')]);
    });

    it('reports nothing when the session is working again before it settles', () => {
      // The harness sending its next step, or the CLI waking for a background agent.
      h.feed(status('s1', 'needs_input'), status('s1', 'working'));
      expect(h.held()).toBe(0);
      expect(h.settle()).toEqual([]);
    });

    it('reports nothing for a session removed, or a notifier reset, before it settles', () => {
      h.feed(status('s1', 'needs_input'), { topic: 'sessions', event: 'remove', sessionId: 's1' });
      expect(h.settle()).toEqual([]);
      h.feed(upsert({ id: 's1', title: 'Map', status: 'working' }), status('s1', 'needs_input'));
      h.notifier.reset();
      expect(h.held()).toBe(0);
      expect(h.settle()).toEqual([]);
    });

    it('says needs input for a parked decision, even one whose upsert came after the status frame', () => {
      h.feed(status('s1', 'needs_input'));
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', pendingDecision: { id: 'p1', kind: 'permission' } }));
      expect(h.settle()).toEqual([asks('Map')]);
    });

    it('says done when the decision was answered before it settled', () => {
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', pendingDecision: { id: 'p1' } }));
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', pendingDecision: null }));
      expect(h.settle()).toEqual([done('Map')]);
    });

    it('says needs input for a harness gate waiting for an OK', () => {
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', harnessGate: 'waiting' }));
      expect(h.settle()).toEqual([asks('Map')]);
    });

    it('says needs input for a lost login (spec 2026-10-21-log-in-from-orbital-design § 3)', () => {
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', loginWait: { kind: 'claude', claudeDirId: 3, running: false, startedBy: null } }));
      expect(h.settle()).toEqual([asks('Map')]);
    });

    it('says done when the login was already running before the stop settled: it waits on the browser, not on you', () => {
      const wait = { kind: 'claude', claudeDirId: 3, running: false, startedBy: null };
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', loginWait: wait }));
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', loginWait: { ...wait, running: true } }));
      expect(h.settle()).toEqual([done('Map')]);
    });

    it('says nothing while the harness reviewer reads the work: it comes back on its own', () => {
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', harnessGate: 'reviewing' }));
      expect(h.settle()).toEqual([]);
    });

    it('says needs input when a session that settled quietly asks only later, without leaving needs_input', () => {
      // The reviewer hands the gate back to the user.
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', harnessGate: 'reviewing' }));
      expect(h.settle()).toEqual([]);
      expect(h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', harnessGate: 'waiting' }))).toEqual([]);
      expect(h.settle()).toEqual([asks('Map')]);
      // A question after a Done.
      h.feed(upsert({ id: 's1', title: 'Map', status: 'working' }), status('s1', 'needs_input'));
      expect(h.settle()).toEqual([done('Map')]);
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', pendingDecision: { id: 'p1', kind: 'question' } }));
      expect(h.settle()).toEqual([asks('Map')]);
    });

    it('says a late ask once: not again while it still asks, nor twice while one is held', () => {
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', pendingDecision: { id: 'p1' } }));
      expect(h.settle()).toEqual([asks('Map')]);
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', pendingDecision: { id: 'p1' }, harnessGate: 'waiting' }));
      expect(h.held()).toBe(0);
      h.feed(status('s1', 'working'), status('s1', 'needs_input'));
      h.feed(upsert({ id: 's1', title: 'Map', status: 'needs_input', pendingDecision: { id: 'p2' } }));
      expect(h.held()).toBe(1);
      expect(h.settle()).toEqual([asks('Map')]);
    });

    it('says nothing for a session found already waiting that keeps asking', () => {
      h.notifier.seed({ id: 's2', title: 'Old', status: 'needs_input', pendingDecision: { id: 'p1' } });
      h.feed(upsert({ id: 's2', title: 'Old', status: 'needs_input', pendingDecision: { id: 'p1' } }));
      expect(h.settle()).toEqual([]);
    });

    it('reads the needs-input switch when it settles', () => {
      h.feed(status('s1', 'needs_input'));
      h.notifier.setSettings({ ...ALL_ON, needsInput: false });
      expect(h.settle()).toEqual([]);
    });

    describe('on the default timer', () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      it('reports once NEEDS_INPUT_SETTLE_MS has passed, and a cancel holds', () => {
        const out: SessionNotification[] = [];
        const notifier = new SessionNotifier({ notify: (n) => out.push(n) });
        notifier.setSettings(ALL_ON);
        notifier.onEvent(upsert({ id: 's1', title: 'Map', status: 'working' }));
        notifier.onEvent(status('s1', 'needs_input'));
        vi.advanceTimersByTime(NEEDS_INPUT_SETTLE_MS - 1);
        notifier.onEvent(status('s1', 'working'));
        vi.advanceTimersByTime(NEEDS_INPUT_SETTLE_MS);
        expect(out).toEqual([]);
        notifier.onEvent(status('s1', 'needs_input'));
        vi.advanceTimersByTime(NEEDS_INPUT_SETTLE_MS);
        expect(out).toEqual([done('Map')]);
      });

      it('dispose cancels what is held', () => {
        const out: SessionNotification[] = [];
        const notifier = new SessionNotifier({ notify: (n) => out.push(n) });
        notifier.setSettings(ALL_ON);
        notifier.onEvent(status('s1', 'needs_input'));
        notifier.dispose();
        vi.runAllTimers();
        expect(out).toEqual([]);
      });
    });
  });

  describe('naming the session', () => {
    const titleOf = (...frames: unknown[]) => h.say(...frames)[0]?.title;

    it('falls back to the basename of cwd when the title is null', () => {
      h.feed(upsert({ id: 's1', title: null, cwd: '/Users/x/code/orbital', status: 'working' }));
      expect(titleOf(status('s1', 'needs_input'))).toBe('orbital');
    });

    it('falls back to "Session" when neither a title nor a cwd was ever seen', () => {
      h.feed(status('s1', 'working'));
      expect(titleOf(status('s1', 'needs_input'))).toBe('Session');
    });

    it('keeps the last name an upsert carried, so status-only frames can still name it', () => {
      h.feed(upsert({ id: 's1', title: null, cwd: '/Users/x/code/orbital', status: 'working' }));
      h.feed(upsert({ id: 's1', title: 'Wire the notifier', status: 'working' }));
      expect(titleOf(status('s1', 'needs_input'))).toBe('Wire the notifier');
    });

    it('treats an empty title as no title', () => {
      h.feed(upsert({ id: 's1', title: '  ', cwd: '/Users/x/code/orbital', status: 'working' }));
      expect(titleOf(status('s1', 'needs_input'))).toBe('orbital');
    });
  });

  describe('errors', () => {
    it('notifies at once when a session fails, naming it from what upserts taught us', () => {
      h.feed(upsert({ id: 's1', title: 'Map', status: 'working' }));
      expect(
        h.feed({
          topic: 'errors',
          event: 'error',
          error: { kind: 'session_failed', sessionId: 's1', message: 'spawn claude ENOENT\n  at foo' },
          unseen: 1,
        }),
      ).toEqual([{ kind: 'failed', title: 'Map', body: 'Session failed: spawn claude ENOENT', sessionId: 's1' }]);
    });

    it('falls back to "Session" for a failure about a session it never saw', () => {
      const out = h.feed({
        topic: 'errors',
        event: 'error',
        error: { kind: 'session_failed', sessionId: 'ghost', message: 'boom' },
      });
      expect(out).toEqual([{ kind: 'failed', title: 'Session', body: 'Session failed: boom', sessionId: 'ghost' }]);
    });

    it('stays quiet about the other error kinds', () => {
      for (const kind of ['api_request', 'render_crash']) {
        expect(h.say({ topic: 'errors', event: 'error', error: { kind, message: 'x' } })).toEqual([]);
      }
    });

    it('ignores seen events', () => {
      expect(h.say({ topic: 'errors', event: 'seen', ids: null, unseen: 0 })).toEqual([]);
    });
  });

  describe('forgetting', () => {
    it('drops a removed session, so its next sighting seeds silently again', () => {
      h.feed(upsert({ id: 's1', title: 'Map', status: 'working' }));
      expect(h.say({ topic: 'sessions', event: 'remove', sessionId: 's1' })).toEqual([]);
      expect(h.say(upsert({ id: 's1', title: 'Map', status: 'needs_input' }))).toEqual([]);
    });

    it('reset() empties everything, so the post-reconnect replay is silent', () => {
      h.feed(upsert({ id: 's1', title: 'Map', status: 'working' }));
      h.notifier.reset();
      expect(h.say(upsert({ id: 's1', title: 'Map', status: 'needs_input' }))).toEqual([]);
      // and the seed took, so the transition after it still speaks
      h.feed(status('s1', 'working'));
      expect(h.say(status('s1', 'needs_input'))).toHaveLength(1);
    });
  });

  describe('junk off the wire', () => {
    it('reports nothing for anything malformed rather than throwing', () => {
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
        expect(() => h.feed(frame)).not.toThrow();
        expect(h.say(frame)).toEqual([]);
      }
      for (const session of junk) expect(() => h.notifier.seed(session)).not.toThrow();
    });

    it('ignores a status it does not understand instead of treating it as news', () => {
      h.feed(upsert({ id: 's1', title: 'Map', status: 'working' }));
      expect(h.say(status('s1', 'hibernating'))).toEqual([]);
      // and the unknown status did not overwrite what we knew
      expect(h.say(status('s1', 'needs_input'))).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Settings → Notifications (spec 2026-09-21-settings-sections-design § 5)
// ---------------------------------------------------------------------------

describe('notification settings', () => {
  const failure = (sessionId: string) => ({
    topic: 'errors',
    event: 'error',
    error: { kind: 'session_failed', sessionId, message: 'boom' },
  });

  describe('parseNotificationSettings', () => {
    // Spec 2026-10-08-notifications-off-by-default-design § 1: silence by
    // default. An absent key reads as the new default, which is what a fresh
    // install seeds; an existing install had its values written out by the
    // migration, so nothing it relied on reads differently.
    it('reads an absent key as the default: every event and sound off, background-only on', () => {
      expect(parseNotificationSettings({})).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
      expect(DEFAULT_NOTIFICATION_SETTINGS).toEqual({
        needsInput: false,
        sessionEnded: false,
        sessionFailed: false,
        onlyWhenBackground: true,
        sound: false,
      });
    });

    it('turns an event on only for the literal string "true"', () => {
      expect(parseNotificationSettings({ notify_sound: 'true' }).sound).toBe(true);
      expect(parseNotificationSettings({ notify_needs_input: 'true' }).needsInput).toBe(true);
      for (const value of ['false', '1', '', 'TRUE', 'yes']) {
        expect(parseNotificationSettings({ notify_sound: value }).sound).toBe(false);
      }
    });

    it('turns background-only off only for the literal string "false"', () => {
      expect(parseNotificationSettings({ notify_only_when_background: 'false' }).onlyWhenBackground).toBe(false);
      for (const value of ['true', '0', '', 'FALSE']) {
        expect(parseNotificationSettings({ notify_only_when_background: value }).onlyWhenBackground).toBe(true);
      }
    });

    it('survives a payload that is not an object', () => {
      for (const raw of [null, undefined, 'nope', 42, []]) {
        expect(parseNotificationSettings(raw)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
      }
    });
  });

  describe('the tip', () => {
    it('calls the defaults all off', () => {
      expect(notificationsAllOff(DEFAULT_NOTIFICATION_SETTINGS)).toBe(true);
      // Background-only filters, it notifies nothing, so turning it off is still all off.
      expect(notificationsAllOff({ ...DEFAULT_NOTIFICATION_SETTINGS, onlyWhenBackground: false })).toBe(true);
    });

    it('calls any event or sound on not all off', () => {
      for (const key of ['needsInput', 'sessionEnded', 'sessionFailed', 'sound'] as const) {
        expect(notificationsAllOff({ ...DEFAULT_NOTIFICATION_SETTINGS, [key]: true })).toBe(false);
      }
    });

    it('turns on exactly needs input and session failed, sound and session ended staying off', () => {
      expect({ ...DEFAULT_NOTIFICATION_SETTINGS, ...NOTIFICATIONS_TURN_ON }).toEqual({
        needsInput: true,
        sessionEnded: false,
        sessionFailed: true,
        onlyWhenBackground: true,
        sound: false,
      });
    });
  });

  describe('muting', () => {
    let h: ReturnType<typeof harness>;

    beforeEach(() => {
      h = harness();
    });

    function mute(patch: Partial<NotificationSettings>) {
      h.notifier.setSettings({ ...ALL_ON, ...patch });
    }

    it('silences each event independently', () => {
      mute({ needsInput: false });
      h.feed(upsert({ id: 's1', title: 'Map', status: 'working' }));
      expect(h.say(status('s1', 'needs_input'))).toEqual([]);

      mute({ needsInput: true, sessionEnded: false });
      h.feed(upsert({ id: 's2', title: 'Other', status: 'working' }));
      expect(h.say(status('s2', 'ended'))).toEqual([]);

      mute({ sessionEnded: true, sessionFailed: false });
      expect(h.say(failure('s1'))).toEqual([]);
    });

    /**
     * The point of muting AFTER the fold: a silenced transition still moves
     * `seen`, so turning the row back on reports the NEXT transition rather
     * than replaying one that happened while it was off.
     */
    it('keeps folding a muted transition, so re-enabling does not replay it', () => {
      mute({ needsInput: false });
      h.feed(upsert({ id: 's1', title: 'Map', status: 'working' }));
      expect(h.say(status('s1', 'needs_input'))).toEqual([]);

      mute({ needsInput: true });
      // Still sitting in needs_input: that is a state, not news.
      expect(h.say(status('s1', 'needs_input'))).toEqual([]);
      // Only a fresh working → needs_input round trip is.
      expect(h.say(status('s1', 'working'))).toEqual([]);
      expect(h.say(status('s1', 'needs_input'))).toEqual([done('Map')]);
    });

    it('exposes the two rows main.ts acts on itself', () => {
      mute({ onlyWhenBackground: false, sound: false });
      expect(h.notifier.current.onlyWhenBackground).toBe(false);
      expect(h.notifier.current.sound).toBe(false);
    });

    it('stays silent before any settings arrive', () => {
      const out: SessionNotification[] = [];
      const notifier = new SessionNotifier({ notify: (n) => out.push(n), schedule: (fn) => (fn(), () => {}) });
      notifier.onEvent(upsert({ id: 's1', title: 'Map', status: 'working' }));
      notifier.onEvent(status('s1', 'needs_input'));
      notifier.onEvent(status('s1', 'ended'));
      expect(out).toEqual([]);
      expect(notifier.current).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    });
  });
});
