import { beforeEach, describe, expect, it } from 'vitest';
import { WorkingSessions } from '../src/lib/background';
import {
  parseUpdateAction,
  parseUpdateView,
  shouldCheckForUpdates,
  UpdateFlow,
} from '../src/lib/updates';

describe('shouldCheckForUpdates', () => {
  it('checks in a packaged build that knows where its releases are', () => {
    expect(shouldCheckForUpdates({ isPackaged: true, hasAppUpdateYml: true })).toBe(true);
  });

  it('never checks in a dev build', () => {
    expect(shouldCheckForUpdates({ isPackaged: false, hasAppUpdateYml: true })).toBe(false);
  });

  it('never checks in a local build, which carries no app-update.yml', () => {
    expect(shouldCheckForUpdates({ isPackaged: true, hasAppUpdateYml: false })).toBe(false);
  });
});

describe('UpdateFlow', () => {
  let flow: UpdateFlow;

  beforeEach(() => {
    flow = new UpdateFlow();
  });

  it('shows nothing until an update is downloaded', () => {
    expect(flow.view).toEqual({ phase: 'none' });
  });

  it('offers a downloaded version with the number of working sessions', () => {
    flow.setWorkingCount(2, true);
    const step = flow.downloaded('0.26.0');
    expect(step).toEqual({ changed: true, restart: false });
    expect(flow.view).toEqual({ phase: 'ready', version: '0.26.0', workingCount: 2 });
  });

  it('restarts at once on Restart now, working sessions or not', () => {
    flow.setWorkingCount(3, true);
    flow.downloaded('0.26.0');
    expect(flow.act('restart-now').restart).toBe(true);
    expect(flow.view.phase).toBe('restarting');
  });

  it('restarts at once when asked to wait but nothing is working', () => {
    flow.setWorkingCount(0, true);
    flow.downloaded('0.26.0');
    expect(flow.act('restart-when-idle').restart).toBe(true);
  });

  it('waits while a session works, and restarts when the last one finishes', () => {
    flow.setWorkingCount(2, true);
    flow.downloaded('0.26.0');
    expect(flow.act('restart-when-idle').restart).toBe(false);
    expect(flow.view).toEqual({ phase: 'waiting', version: '0.26.0', workingCount: 2 });
    expect(flow.setWorkingCount(1, true).restart).toBe(false);
    expect(flow.setWorkingCount(0, true).restart).toBe(true);
  });

  it('keeps waiting when a session starts during the wait', () => {
    flow.setWorkingCount(1, true);
    flow.downloaded('0.26.0');
    flow.act('restart-when-idle');
    expect(flow.setWorkingCount(2, true).restart).toBe(false);
    expect(flow.view).toEqual({ phase: 'waiting', version: '0.26.0', workingCount: 2 });
  });

  it('restarts only once, however the count moves after', () => {
    flow.setWorkingCount(1, true);
    flow.downloaded('0.26.0');
    flow.act('restart-when-idle');
    expect(flow.setWorkingCount(0, true).restart).toBe(true);
    expect(flow.setWorkingCount(1, true).restart).toBe(false);
    expect(flow.setWorkingCount(0, true).restart).toBe(false);
    expect(flow.act('restart-now').restart).toBe(false);
  });

  it('cancelling the wait goes back to the offer, and finishing then restarts nothing', () => {
    flow.setWorkingCount(1, true);
    flow.downloaded('0.26.0');
    flow.act('restart-when-idle');
    flow.act('cancel-wait');
    expect(flow.view).toEqual({ phase: 'ready', version: '0.26.0', workingCount: 1 });
    expect(flow.setWorkingCount(0, true).restart).toBe(false);
  });

  it('a session finishing without a wait restarts nothing', () => {
    flow.setWorkingCount(1, true);
    flow.downloaded('0.26.0');
    expect(flow.setWorkingCount(0, true).restart).toBe(false);
    expect(flow.view.phase).toBe('ready');
  });

  it('closing the prompt hides it for that version and abandons a wait', () => {
    flow.setWorkingCount(1, true);
    flow.downloaded('0.26.0');
    flow.act('restart-when-idle');
    flow.act('dismiss');
    expect(flow.view.phase).toBe('dismissed');
    expect(flow.setWorkingCount(0, true).restart).toBe(false);
  });

  it('does not offer a dismissed version again', () => {
    flow.downloaded('0.26.0');
    flow.act('dismiss');
    expect(flow.downloaded('0.26.0').changed).toBe(false);
    expect(flow.view.phase).toBe('dismissed');
  });

  it('offers a newer version after one was dismissed', () => {
    flow.downloaded('0.26.0');
    flow.act('dismiss');
    flow.downloaded('0.27.0');
    expect(flow.view).toEqual({ phase: 'ready', version: '0.27.0', workingCount: 0 });
  });

  it('keeps an existing wait when a newer version arrives during it', () => {
    flow.setWorkingCount(1, true);
    flow.downloaded('0.26.0');
    flow.act('restart-when-idle');
    flow.downloaded('0.27.0');
    expect(flow.view).toEqual({ phase: 'waiting', version: '0.27.0', workingCount: 1 });
  });

  it('ignores actions before anything is downloaded', () => {
    for (const action of ['restart-now', 'restart-when-idle', 'cancel-wait', 'dismiss'] as const) {
      expect(flow.act(action)).toEqual({ changed: false, restart: false });
    }
    expect(flow.view).toEqual({ phase: 'none' });
  });

  it('reports no change when the count did not move', () => {
    flow.setWorkingCount(1, true);
    flow.downloaded('0.26.0');
    expect(flow.setWorkingCount(1, true).changed).toBe(false);
  });

  it('counts only Orbital sessions — a working terminal session does not hold a restart', () => {
    const working = new WorkingSessions();
    working.seed(working.beginSeed(), { sessions: [] });
    working.onFrame({ topic: 'sessions', event: 'upsert', session: { id: 'w', source: 'web', status: 'working' } });
    flow.setWorkingCount(working.count, working.seeded);
    flow.downloaded('0.26.0');
    flow.act('restart-when-idle');
    working.onFrame({ topic: 'sessions', event: 'upsert', session: { id: 't', source: 'terminal', status: 'working' } });
    expect(flow.setWorkingCount(working.count, working.seeded).restart).toBe(false);
    working.onFrame({ topic: 'sessions', event: 'status', sessionId: 'w', status: 'needs_input' });
    expect(flow.setWorkingCount(working.count, working.seeded).restart).toBe(true);
  });

  describe('after the sessions socket reconnects', () => {
    let working: WorkingSessions;

    /** Waiting on one working Orbital session, with the fold seeded. */
    beforeEach(() => {
      working = new WorkingSessions();
      working.seed(working.beginSeed(), { sessions: [{ id: 'w', source: 'web', status: 'working' }] });
      flow.setWorkingCount(working.count, working.seeded);
      flow.downloaded('0.26.0');
      flow.act('restart-when-idle');
    });

    it('does not restart on an idle frame before the list is read again', () => {
      working.reset();
      working.beginSeed(); // the list is on its way, not here yet
      working.onFrame({ topic: 'sessions', event: 'upsert', session: { id: 'x', source: 'web', status: 'idle' } });
      expect(working.count).toBe(0);
      expect(flow.setWorkingCount(working.count, working.seeded).restart).toBe(false);
      expect(flow.view).toEqual({ phase: 'waiting', version: '0.26.0', workingCount: 1 });
    });

    it('keeps waiting when the list read again still has a working session', () => {
      working.reset();
      working.seed(working.beginSeed(), { sessions: [{ id: 'w', source: 'web', status: 'working' }] });
      expect(flow.setWorkingCount(working.count, working.seeded).restart).toBe(false);
    });

    it('restarts when the list read again has nothing working', () => {
      working.reset();
      working.seed(working.beginSeed(), { sessions: [{ id: 'w', source: 'web', status: 'idle' }] });
      expect(flow.setWorkingCount(working.count, working.seeded).restart).toBe(true);
    });
  });

  it('never restarts a wait on a count that is not known', () => {
    flow.setWorkingCount(1, true);
    flow.downloaded('0.26.0');
    flow.act('restart-when-idle');
    expect(flow.setWorkingCount(0, false).restart).toBe(false);
  });

  it('Restart when sessions finish waits while the count is not known', () => {
    flow.setWorkingCount(0, false);
    flow.downloaded('0.26.0');
    expect(flow.act('restart-when-idle').restart).toBe(false);
    expect(flow.view.phase).toBe('waiting');
    expect(flow.setWorkingCount(0, true).restart).toBe(true);
  });
});

describe('parseUpdateAction', () => {
  it('takes the four actions and nothing else', () => {
    for (const action of ['restart-now', 'restart-when-idle', 'cancel-wait', 'dismiss']) {
      expect(parseUpdateAction(action)).toBe(action);
    }
    for (const raw of ['restart', '', null, 1, {}, ['dismiss']]) {
      expect(parseUpdateAction(raw)).toBeNull();
    }
  });
});

describe('parseUpdateView', () => {
  it('passes a well-formed view through', () => {
    const view = { phase: 'waiting', version: '0.26.0', workingCount: 2 };
    expect(parseUpdateView(view)).toEqual(view);
  });

  it('reads anything malformed as no update', () => {
    for (const raw of [
      null,
      'ready',
      { phase: 'ready' },
      { phase: 'ready', version: '', workingCount: 0 },
      { phase: 'ready', version: '0.26.0', workingCount: -1 },
      { phase: 'ready', version: '0.26.0', workingCount: 1.5 },
      { phase: 'later', version: '0.26.0', workingCount: 0 },
    ]) {
      expect(parseUpdateView(raw)).toEqual({ phase: 'none' });
    }
  });
});
