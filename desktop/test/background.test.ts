import { beforeEach, describe, expect, it } from 'vitest';
import { decideQuit, decideWindowClose, WorkingSessions } from '../src/lib/background';

describe('decideWindowClose', () => {
  it('hides the window when the app is not quitting', () => {
    expect(decideWindowClose({ quitting: false })).toBe('hide');
  });

  it('lets the window close once a quit is under way', () => {
    expect(decideWindowClose({ quitting: true })).toBe('close');
  });
});

describe('decideQuit', () => {
  it('asks when the forked server still has sessions mid-turn', () => {
    expect(decideQuit({ forked: true, workingCount: 2 })).toBe('confirm');
  });

  it('quits silently when nothing orbital-run is working', () => {
    expect(decideQuit({ forked: true, workingCount: 0 })).toBe('quit');
  });

  it('never asks in attach mode — that server outlives the app', () => {
    expect(decideQuit({ forked: false, workingCount: 3 })).toBe('quit');
  });
});

/** An `upsert` frame as the hub publishes it (the full ApiSession, trimmed). */
function upsert(session: Record<string, unknown>) {
  return { topic: 'sessions', event: 'upsert', session };
}

/** A runner `status` frame — no `source`, because only the runner sends these. */
function statusFrame(sessionId: string, status: string) {
  return { topic: 'sessions', event: 'status', sessionId, status };
}

function remove(sessionId: string) {
  return { topic: 'sessions', event: 'remove', sessionId };
}

describe('WorkingSessions', () => {
  let working: WorkingSessions;

  beforeEach(() => {
    working = new WorkingSessions();
  });

  it('starts empty, so a startup-failure quit is never blocked', () => {
    expect(working.count).toBe(0);
  });

  it('counts an orbital-run session that is mid-turn', () => {
    working.onFrame(upsert({ id: 's1', source: 'web', status: 'working' }));
    expect(working.count).toBe(1);
  });

  it('ignores terminal sessions — the server’s death does not touch them', () => {
    working.onFrame(upsert({ id: 's1', source: 'terminal', status: 'working' }));
    expect(working.count).toBe(0);
  });

  it('ignores an orbital-run session that is not working', () => {
    working.onFrame(upsert({ id: 's1', source: 'web', status: 'needs_input' }));
    expect(working.count).toBe(0);
  });

  it('counts a session once, however many upserts it sends', () => {
    working.onFrame(upsert({ id: 's1', source: 'web', status: 'working' }));
    working.onFrame(upsert({ id: 's1', source: 'web', status: 'working' }));
    expect(working.count).toBe(1);
  });

  it('drops a session that stops working', () => {
    working.onFrame(upsert({ id: 's1', source: 'web', status: 'working' }));
    working.onFrame(upsert({ id: 's1', source: 'web', status: 'idle' }));
    expect(working.count).toBe(0);
  });

  it('drops a session removed from the map', () => {
    working.onFrame(upsert({ id: 's1', source: 'web', status: 'working' }));
    working.onFrame(remove('s1'));
    expect(working.count).toBe(0);
  });

  it('counts each working session separately', () => {
    working.onFrame(upsert({ id: 's1', source: 'web', status: 'working' }));
    working.onFrame(upsert({ id: 's2', source: 'web', status: 'working' }));
    expect(working.count).toBe(2);
  });

  it('empties on reset — a new socket replays the world', () => {
    working.onFrame(upsert({ id: 's1', source: 'web', status: 'working' }));
    working.reset();
    expect(working.count).toBe(0);
  });

  it('ignores every other topic', () => {
    working.onFrame({ topic: 'errors', event: 'error', error: { kind: 'session_failed' } });
    expect(working.count).toBe(0);
  });

  it('survives malformed frames rather than taking the main process down', () => {
    for (const frame of [null, 'hello', 42, [], {}, { topic: 'sessions' }, upsert({}), remove('')]) {
      expect(() => working.onFrame(frame)).not.toThrow();
    }
    expect(working.count).toBe(0);
  });

  it('counts a session the runner says has started a turn', () => {
    working.onFrame(upsert({ id: 's1', source: 'web', status: 'idle' }));
    working.onFrame(statusFrame('s1', 'working'));
    expect(working.count).toBe(1);
  });

  it('drops a session the runner says has left its turn', () => {
    working.onFrame(upsert({ id: 's1', source: 'web', status: 'working' }));
    working.onFrame(statusFrame('s1', 'needs_input'));
    expect(working.count).toBe(0);
  });

  it('counts a status frame for an id no upsert ever mentioned', () => {
    // After a reconnect the set is empty and the runner may never re-upsert
    // the session it is mid-turn on; the status frame is all there is.
    working.onFrame(statusFrame('s1', 'working'));
    expect(working.count).toBe(1);
  });

  it('survives malformed status frames', () => {
    for (const frame of [
      { topic: 'sessions', event: 'status', status: 'working' },
      { topic: 'sessions', event: 'status', sessionId: '', status: 'working' },
      { topic: 'sessions', event: 'status', sessionId: 42, status: 'working' },
      { topic: 'sessions', event: 'status', sessionId: 's1' },
    ]) {
      expect(() => working.onFrame(frame)).not.toThrow();
    }
    expect(working.count).toBe(0);
  });
});
