import { beforeEach, describe, expect, it } from 'vitest';
import { WorkingSessions } from '../src/lib/background';
import {
  AUTO_DOWNLOAD_KEY,
  checkAnswerMessage,
  parseAutoDownload,
  parseSkippedVersion,
  parseUpdateAction,
  parseUpdateCheckAnswer,
  parseUpdateView,
  serializeSkippedVersion,
  shouldCheckForUpdates,
  updateSize,
  UpdateFlow,
  type FoundOutcome,
  type UpdateAction,
} from '../src/lib/updates';

const MB = 1_000_000;

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

describe('parseAutoDownload', () => {
  it('is on only for the literal true, off by default', () => {
    expect(parseAutoDownload({ [AUTO_DOWNLOAD_KEY]: 'true' })).toBe(true);
    for (const raw of [{}, { [AUTO_DOWNLOAD_KEY]: 'false' }, { [AUTO_DOWNLOAD_KEY]: 'yes' }, null, 'true']) {
      expect(parseAutoDownload(raw)).toBe(false);
    }
  });
});

describe('updateSize', () => {
  it('is the zip the Mac updater downloads, not the DMG beside it', () => {
    expect(
      updateSize([
        { url: 'Orbital-0.26.0-arm64.dmg', size: 140 * MB },
        { url: 'Orbital-0.26.0-arm64-mac.zip', size: 130 * MB },
      ]),
    ).toBe(130 * MB);
  });

  it('falls back to the first file, and to zero when nothing says', () => {
    expect(updateSize([{ url: 'a.dmg', size: 5 }])).toBe(5);
    expect(updateSize([{ url: 'a.zip' }])).toBe(0);
    expect(updateSize([])).toBe(0);
    expect(updateSize(undefined)).toBe(0);
  });
});

describe('UpdateFlow', () => {
  let flow: UpdateFlow;

  /** Asked first (the default), with a known count. */
  beforeEach(() => {
    flow = new UpdateFlow();
  });

  /** Offered, downloaded and ready, with `working` sessions mid-turn when it appeared. */
  function ready(version = '0.26.0', working = 0): void {
    flow.setWorkingCount(working, true);
    flow.downloaded(version);
  }

  /**
   * A new count, and — when it asks for one — the look again
   * `IDLE_SETTLE_MS` later with nothing else in between.
   */
  function settle(count: number, seeded: boolean) {
    const step = flow.setWorkingCount(count, seeded);
    return step.idleCheck ? flow.idleSettled() : step;
  }

  it('shows nothing until a check finds something', () => {
    expect(flow.view).toEqual({ phase: 'none', checkedAt: null });
  });

  it('remembers when it last checked', () => {
    expect(flow.checked(1000).changed).toBe(true);
    expect(flow.view.checkedAt).toBe(1000);
  });

  describe('asking before the download (setting off)', () => {
    it('offers a found version with its size, and downloads nothing', () => {
      const step = flow.available('0.26.0', 131.4 * MB);
      expect(step).toMatchObject({ changed: true, download: false, restart: false });
      expect(flow.view).toEqual({ phase: 'available', version: '0.26.0', totalMB: 131, checkedAt: null });
    });

    it('downloads on Download, and shows the progress', () => {
      flow.available('0.26.0', 130 * MB);
      expect(flow.act('download')).toMatchObject({ changed: true, download: true });
      expect(flow.view).toMatchObject({ phase: 'downloading', version: '0.26.0', percent: 0, totalMB: 130 });
      expect(flow.progress(42.7, 130 * MB).changed).toBe(true);
      expect(flow.view).toMatchObject({ phase: 'downloading', percent: 42 });
      // The same whole percent again moves nothing on screen.
      expect(flow.progress(42.9, 130 * MB).changed).toBe(false);
    });

    it('goes on from Downloading to Ready in the same prompt', () => {
      flow.setWorkingCount(0, true);
      flow.available('0.26.0', 130 * MB);
      flow.act('download');
      flow.downloaded('0.26.0');
      expect(flow.view).toMatchObject({ phase: 'ready', version: '0.26.0', buttons: 'one' });
    });

    it('offers the version again when its download fails', () => {
      flow.available('0.26.0', 130 * MB);
      flow.act('download');
      flow.progress(10, 130 * MB);
      expect(flow.downloadFailed().changed).toBe(true);
      expect(flow.view).toMatchObject({ phase: 'available', version: '0.26.0', totalMB: 130 });
    });

    it('does not offer the version again while it downloads', () => {
      flow.available('0.26.0', 130 * MB);
      flow.act('download');
      expect(flow.available('0.26.0', 130 * MB)).toMatchObject({ changed: false, download: false });
      expect(flow.view.phase).toBe('downloading');
    });

    it('× skips that version: gone, and not offered at the next check', () => {
      flow.available('0.26.0', 130 * MB);
      expect(flow.act('skip')).toMatchObject({ changed: true, skipChanged: true });
      expect(flow.view.phase).toBe('none');
      expect(flow.skippedVersion).toBe('0.26.0');
      expect(flow.available('0.26.0', 130 * MB).changed).toBe(false);
      expect(flow.view.phase).toBe('none');
    });

    it('a skipped version stays skipped across a restart', () => {
      flow = new UpdateFlow({ skippedVersion: '0.26.0' });
      expect(flow.available('0.26.0', 130 * MB).changed).toBe(false);
      expect(flow.view.phase).toBe('none');
    });

    it('offers a newer version after one was skipped', () => {
      flow.available('0.26.0', 130 * MB);
      flow.act('skip');
      flow.available('0.27.0', 131 * MB);
      expect(flow.view).toMatchObject({ phase: 'available', version: '0.27.0' });
    });

    it('Check now offers a skipped version again, and forgets the skip', () => {
      flow.available('0.26.0', 130 * MB);
      flow.act('skip');
      const step = flow.available('0.26.0', 130 * MB, { manual: true });
      expect(step).toMatchObject({ changed: true, skipChanged: true });
      expect(flow.view).toMatchObject({ phase: 'available', version: '0.26.0' });
      expect(flow.skippedVersion).toBeNull();
    });

    it('a newer version replaces an older one still on offer', () => {
      flow.available('0.26.0', 130 * MB);
      flow.available('0.27.0', 131 * MB);
      expect(flow.view).toMatchObject({ phase: 'available', version: '0.27.0', totalMB: 131 });
    });
  });

  describe('downloading by itself (setting on)', () => {
    beforeEach(() => flow.setAutoDownload(true));

    it('downloads a found version without a prompt, and starts the prompt at Ready', () => {
      flow.setWorkingCount(0, true);
      expect(flow.available('0.26.0', 130 * MB)).toMatchObject({ changed: false, download: true });
      expect(flow.view.phase).toBe('none');
      expect(flow.progress(50, 130 * MB).changed).toBe(false);
      expect(flow.view.phase).toBe('none');
      flow.downloaded('0.26.0');
      expect(flow.view).toMatchObject({ phase: 'ready', version: '0.26.0', buttons: 'one' });
    });

    it('stays silent when the download fails; the next check tries again', () => {
      flow.available('0.26.0', 130 * MB);
      expect(flow.downloadFailed().changed).toBe(false);
      expect(flow.view.phase).toBe('none');
      expect(flow.available('0.26.0', 130 * MB).download).toBe(true);
    });

    it('does not download a skipped version', () => {
      flow = new UpdateFlow({ skippedVersion: '0.26.0' });
      flow.setAutoDownload(true);
      expect(flow.available('0.26.0', 130 * MB).download).toBe(false);
      expect(flow.available('0.26.0', 130 * MB, { manual: true }).download).toBe(true);
    });

    it('does not download what is already downloaded', () => {
      ready();
      expect(flow.available('0.26.0', 130 * MB).download).toBe(false);
    });

    it('starts a download once, however many checks find it meanwhile', () => {
      expect(flow.available('0.26.0', 130 * MB)).toMatchObject({ download: true, outcome: 'downloading' });
      expect(flow.available('0.26.0', 130 * MB, { manual: true })).toMatchObject({
        download: false,
        outcome: 'downloading',
      });
      flow.downloadFailed();
      expect(flow.available('0.26.0', 130 * MB).download).toBe(true);
    });
  });

  describe('turning automatic download on', () => {
    it('downloads the version Available is offering, as Download would', () => {
      flow.available('0.26.0', 130 * MB);
      expect(flow.setAutoDownload(true)).toMatchObject({ changed: true, download: true });
      expect(flow.view).toMatchObject({ phase: 'downloading', version: '0.26.0', percent: 0 });
    });

    it('starts nothing when nothing is offered, or when turned off', () => {
      expect(flow.setAutoDownload(true)).toMatchObject({ changed: false, download: false });
      flow = new UpdateFlow();
      flow.available('0.26.0', 130 * MB);
      expect(flow.setAutoDownload(false)).toMatchObject({ changed: false, download: false });
      expect(flow.view.phase).toBe('available');
    });
  });

  describe('what a check found', () => {
    it('is offered when the map shows it, whatever state the prompt is in', () => {
      expect(flow.available('0.26.0', MB).outcome).toBe('offered');
      expect(flow.available('0.26.0', MB, { manual: true })).toMatchObject({ outcome: 'offered', changed: false });
      flow.act('download');
      expect(flow.available('0.26.0', MB).outcome).toBe('offered');
      flow.downloaded('0.26.0');
      expect(flow.available('0.26.0', MB).outcome).toBe('offered');
    });

    it('installs on quit once its receipt was OK’d', () => {
      ready('0.26.0', 0);
      flow.act('close');
      flow.act('ok');
      expect(flow.available('0.26.0', MB, { manual: true })).toMatchObject({
        outcome: 'installs-on-quit',
        changed: false,
        download: false,
      });
    });

    it('is held behind a downloaded version waiting for its restart', () => {
      ready('0.26.0', 1);
      expect(flow.available('0.27.0', MB, { manual: true }).outcome).toBe('held');
    });

    it('is skipped only for a check the user did not ask for', () => {
      flow = new UpdateFlow({ skippedVersion: '0.26.0' });
      expect(flow.available('0.26.0', MB).outcome).toBe('skipped');
      expect(flow.available('0.26.0', MB, { manual: true }).outcome).toBe('offered');
    });
  });

  describe('a download that fails after it was reported done', () => {
    // Squirrel.Mac stages the zip after `update-downloaded`, and can refuse it.
    it('offers the version again from Ready, Waiting or the receipt', () => {
      for (const to of [() => {}, () => flow.act('restart-when-idle'), () => flow.act('close')]) {
        flow = new UpdateFlow();
        ready('0.26.0', 1);
        to();
        expect(flow.downloadFailed().changed).toBe(true);
        expect(flow.view).toMatchObject({ phase: 'available', version: '0.26.0' });
        // No longer downloaded: Download fetches it again, and it comes back as Ready.
        expect(flow.act('download').download).toBe(true);
        flow.downloaded('0.26.0');
        expect(flow.view.phase).toBe('ready');
      }
    });

    it('does not leave a restart that failed restarting', () => {
      ready('0.26.0', 0);
      flow.act('restart-now');
      expect(flow.updaterError().changed).toBe(true);
      expect(flow.view).toMatchObject({ phase: 'available', version: '0.26.0' });
    });

    it('a failed check changes nothing', () => {
      ready('0.26.0', 1);
      expect(flow.updaterError().changed).toBe(false);
      expect(flow.view.phase).toBe('ready');
    });

    it('stays silent for a download that ran by itself', () => {
      flow.setAutoDownload(true);
      flow.available('0.26.0', MB);
      expect(flow.downloadFailed().changed).toBe(false);
      expect(flow.view.phase).toBe('none');
    });
  });

  describe('Ready', () => {
    it('has one button when nothing works as it appears, two otherwise', () => {
      ready('0.26.0', 0);
      expect(flow.view).toEqual({ phase: 'ready', version: '0.26.0', workingCount: 0, buttons: 'one', checkedAt: null });
      flow = new UpdateFlow();
      ready('0.26.0', 2);
      expect(flow.view).toMatchObject({ phase: 'ready', workingCount: 2, buttons: 'two' });
    });

    it('keeps its buttons while the count moves, and the count stays live', () => {
      ready('0.26.0', 2);
      expect(flow.setWorkingCount(0, true).changed).toBe(true);
      expect(flow.view).toMatchObject({ workingCount: 0, buttons: 'two' });
      flow = new UpdateFlow();
      ready('0.26.0', 0);
      flow.setWorkingCount(3, true);
      expect(flow.view).toMatchObject({ workingCount: 3, buttons: 'one' });
    });

    it('has two buttons when the count is not known as it appears', () => {
      flow.setWorkingCount(0, false);
      flow.downloaded('0.26.0');
      expect(flow.view).toMatchObject({ buttons: 'two' });
    });

    it('restarts at once on Restart now, working sessions or not', () => {
      ready('0.26.0', 3);
      expect(flow.act('restart-now').restart).toBe(true);
      expect(flow.view.phase).toBe('restarting');
    });

    it('restarts at once when asked to wait but nothing is working', () => {
      ready('0.26.0', 0);
      expect(flow.act('restart-when-idle').restart).toBe(true);
    });

    it('× leaves a receipt, and OK ends it for that version', () => {
      ready('0.26.0', 1);
      expect(flow.act('close').changed).toBe(true);
      expect(flow.view).toMatchObject({ phase: 'closed', version: '0.26.0' });
      expect(flow.act('ok').changed).toBe(true);
      expect(flow.view.phase).toBe('none');
      // Downloaded again by a later check, it is not offered again.
      expect(flow.downloaded('0.26.0').changed).toBe(false);
      expect(flow.available('0.26.0', 130 * MB).changed).toBe(false);
      expect(flow.view.phase).toBe('none');
    });

    it('a session finishing on the receipt restarts nothing', () => {
      ready('0.26.0', 1);
      flow.act('close');
      expect(settle(0, true).restart).toBe(false);
    });

    it('a newer download replaces the receipt with a prompt for it', () => {
      ready('0.26.0', 0);
      flow.act('close');
      flow.downloaded('0.27.0');
      expect(flow.view).toMatchObject({ phase: 'ready', version: '0.27.0' });
    });

    it('a newer version found after OK is offered', () => {
      ready('0.26.0', 0);
      flow.act('close');
      flow.act('ok');
      flow.available('0.27.0', 130 * MB);
      expect(flow.view).toMatchObject({ phase: 'available', version: '0.27.0' });
    });

    it('a newer version found while one waits to restart is held until then', () => {
      ready('0.26.0', 1);
      expect(flow.available('0.27.0', 130 * MB)).toMatchObject({ changed: false, download: false });
      expect(flow.view).toMatchObject({ phase: 'ready', version: '0.26.0' });
    });
  });

  describe('when sessions finish', () => {
    it('waits while a session works, and restarts when the last one finishes', () => {
      ready('0.26.0', 2);
      expect(flow.act('restart-when-idle').restart).toBe(false);
      expect(flow.view).toMatchObject({ phase: 'waiting', version: '0.26.0', workingCount: 2 });
      expect(settle(1, true).restart).toBe(false);
      expect(settle(0, true).restart).toBe(true);
    });

    it('keeps waiting when a session starts during the wait', () => {
      ready('0.26.0', 1);
      flow.act('restart-when-idle');
      expect(settle(2, true).restart).toBe(false);
      expect(flow.view).toMatchObject({ phase: 'waiting', workingCount: 2 });
    });

    it('restarts only once the zero has settled, not on a zero between two frames', () => {
      ready('0.26.0', 1);
      flow.act('restart-when-idle');
      const zero = flow.setWorkingCount(0, true);
      expect(zero).toMatchObject({ restart: false, idleCheck: true });
      flow.setWorkingCount(1, true);
      expect(flow.idleSettled().restart).toBe(false);
      flow.setWorkingCount(0, true);
      expect(flow.idleSettled().restart).toBe(true);
    });

    it('a settled zero restarts nothing once the wait was cancelled', () => {
      ready('0.26.0', 1);
      flow.act('restart-when-idle');
      flow.setWorkingCount(0, true);
      flow.act('cancel-wait');
      expect(flow.idleSettled().restart).toBe(false);
    });

    it('restarts only once, however the count moves after', () => {
      ready('0.26.0', 1);
      flow.act('restart-when-idle');
      expect(settle(0, true).restart).toBe(true);
      expect(settle(1, true).restart).toBe(false);
      expect(settle(0, true).restart).toBe(false);
      expect(flow.act('restart-now').restart).toBe(false);
    });

    it('Cancel goes back to the two-button choice, and finishing then restarts nothing', () => {
      ready('0.26.0', 1);
      flow.act('restart-when-idle');
      flow.act('cancel-wait');
      expect(flow.view).toMatchObject({ phase: 'ready', workingCount: 1, buttons: 'two' });
      expect(settle(0, true).restart).toBe(false);
    });

    it('Restart on the one-button prompt waits if a session started meanwhile', () => {
      ready('0.26.0', 0);
      flow.setWorkingCount(1, true);
      expect(flow.act('restart-when-idle').restart).toBe(false);
      expect(flow.view.phase).toBe('waiting');
      flow.act('cancel-wait');
      expect(flow.view).toMatchObject({ phase: 'ready', buttons: 'two' });
    });

    it('a newer download replaces the wait with a prompt for it', () => {
      ready('0.26.0', 1);
      flow.act('restart-when-idle');
      flow.downloaded('0.27.0');
      expect(flow.view).toMatchObject({ phase: 'ready', version: '0.27.0', workingCount: 1, buttons: 'two' });
      expect(settle(0, true).restart).toBe(false);
    });

    it('never restarts a wait on a count that is not known', () => {
      ready('0.26.0', 1);
      flow.act('restart-when-idle');
      expect(settle(0, false).restart).toBe(false);
    });

    it('Restart when sessions finish waits while the count is not known', () => {
      flow.setWorkingCount(0, false);
      flow.downloaded('0.26.0');
      expect(flow.act('restart-when-idle').restart).toBe(false);
      expect(flow.view.phase).toBe('waiting');
      expect(settle(0, true).restart).toBe(true);
    });

    it('counts only Orbital sessions — a working terminal session does not hold a restart', () => {
      const working = new WorkingSessions();
      working.seed(working.beginSeed(), { sessions: [] });
      working.onFrame({ topic: 'sessions', event: 'upsert', session: { id: 'w', source: 'web', status: 'working' } });
      flow.setWorkingCount(working.busyCount, working.seeded);
      flow.downloaded('0.26.0');
      flow.act('restart-when-idle');
      working.onFrame({ topic: 'sessions', event: 'upsert', session: { id: 't', source: 'terminal', status: 'working' } });
      expect(settle(working.busyCount, working.seeded).restart).toBe(false);
      working.onFrame({ topic: 'sessions', event: 'status', sessionId: 'w', status: 'needs_input' });
      expect(settle(working.busyCount, working.seeded).restart).toBe(true);
    });

    it('waits for a session parked on a permission prompt, though it reads needs_input', () => {
      const working = new WorkingSessions();
      working.seed(working.beginSeed(), { sessions: [] });
      const parked = { id: 'p', source: 'web', status: 'working', pendingDecision: { id: 'd1' } };
      working.onFrame({ topic: 'sessions', event: 'upsert', session: parked });
      working.onFrame({ topic: 'sessions', event: 'status', sessionId: 'p', status: 'needs_input' });
      flow.setWorkingCount(working.busyCount, working.seeded);
      flow.downloaded('0.26.0');
      expect(flow.view).toMatchObject({ phase: 'ready', workingCount: 1, buttons: 'two' });
      flow.act('restart-when-idle');
      expect(flow.view.phase).toBe('waiting');
      // Answered: the server sends the session without its decision, still
      // `needs_input`, then `working` — the count reads zero between the two.
      working.onFrame({ topic: 'sessions', event: 'upsert', session: { ...parked, status: 'needs_input', pendingDecision: null } });
      expect(flow.setWorkingCount(working.busyCount, working.seeded)).toMatchObject({ restart: false, idleCheck: true });
      working.onFrame({ topic: 'sessions', event: 'status', sessionId: 'p', status: 'working' });
      flow.setWorkingCount(working.busyCount, working.seeded);
      expect(flow.idleSettled().restart).toBe(false);
      // The turn ends with nothing pending.
      working.onFrame({ topic: 'sessions', event: 'status', sessionId: 'p', status: 'needs_input' });
      expect(settle(working.busyCount, working.seeded).restart).toBe(true);
    });

    describe('after the sessions socket reconnects', () => {
      let working: WorkingSessions;

      /** Waiting on one working Orbital session, with the fold seeded. */
      beforeEach(() => {
        working = new WorkingSessions();
        working.seed(working.beginSeed(), { sessions: [{ id: 'w', source: 'web', status: 'working' }] });
        flow.setWorkingCount(working.busyCount, working.seeded);
        flow.downloaded('0.26.0');
        flow.act('restart-when-idle');
      });

      it('does not restart on an idle frame before the list is read again', () => {
        working.reset();
        working.beginSeed(); // the list is on its way, not here yet
        working.onFrame({ topic: 'sessions', event: 'upsert', session: { id: 'x', source: 'web', status: 'idle' } });
        expect(working.count).toBe(0);
        expect(settle(working.busyCount, working.seeded).restart).toBe(false);
        expect(flow.view).toMatchObject({ phase: 'waiting', workingCount: 1 });
      });

      it('keeps waiting when the list read again still has a working session', () => {
        working.reset();
        working.seed(working.beginSeed(), { sessions: [{ id: 'w', source: 'web', status: 'working' }] });
        expect(settle(working.busyCount, working.seeded).restart).toBe(false);
      });

      it('restarts when the list read again has nothing working', () => {
        working.reset();
        working.seed(working.beginSeed(), { sessions: [{ id: 'w', source: 'web', status: 'idle' }] });
        expect(settle(working.busyCount, working.seeded).restart).toBe(true);
      });
    });
  });

  it('a session finishing without a wait restarts nothing', () => {
    ready('0.26.0', 1);
    expect(settle(0, true).restart).toBe(false);
    expect(flow.view.phase).toBe('ready');
  });

  it('reports no change when the count did not move', () => {
    ready('0.26.0', 1);
    expect(flow.setWorkingCount(1, true).changed).toBe(false);
  });

  it('takes an action only in the state that shows its button', () => {
    const all: UpdateAction[] = ['download', 'skip', 'restart-now', 'restart-when-idle', 'cancel-wait', 'close', 'ok'];
    for (const action of all) expect(flow.act(action)).toMatchObject({ changed: false, restart: false, download: false });
    expect(flow.view.phase).toBe('none');
    flow.available('0.26.0', MB);
    for (const action of ['restart-now', 'restart-when-idle', 'cancel-wait', 'close', 'ok'] as const) {
      expect(flow.act(action).changed).toBe(false);
    }
    flow.act('download');
    for (const action of all) expect(flow.act(action)).toMatchObject({ changed: false, download: false });
    expect(flow.view.phase).toBe('downloading');
  });

  it('changes nothing once restarting', () => {
    ready('0.26.0', 0);
    flow.act('restart-now');
    expect(flow.downloaded('0.27.0').changed).toBe(false);
    expect(flow.available('0.27.0', MB)).toMatchObject({ changed: false, download: false });
    expect(flow.view.phase).toBe('restarting');
  });
});

describe('skipped version file', () => {
  it('round-trips a version and nothing', () => {
    expect(parseSkippedVersion(serializeSkippedVersion('0.26.0'))).toBe('0.26.0');
    expect(parseSkippedVersion(serializeSkippedVersion(null))).toBeNull();
  });

  it('reads anything malformed as nothing skipped', () => {
    for (const raw of ['', '{', 'null', '"0.26.0"', '{"skippedVersion":3}', '{"skippedVersion":""}']) {
      expect(parseSkippedVersion(raw)).toBeNull();
    }
  });
});

describe('parseUpdateAction', () => {
  it('takes the seven actions and nothing else', () => {
    for (const action of ['download', 'skip', 'restart-now', 'restart-when-idle', 'cancel-wait', 'close', 'ok']) {
      expect(parseUpdateAction(action)).toBe(action);
    }
    for (const raw of ['restart', 'dismiss', '', null, 1, {}, ['ok']]) {
      expect(parseUpdateAction(raw)).toBeNull();
    }
  });
});

describe('parseUpdateView', () => {
  it('passes each well-formed view through', () => {
    for (const view of [
      { phase: 'none', checkedAt: null },
      { phase: 'none', checkedAt: 5 },
      { phase: 'available', version: '0.26.0', totalMB: 130, checkedAt: 5 },
      { phase: 'downloading', version: '0.26.0', percent: 40, totalMB: 130, checkedAt: 5 },
      { phase: 'ready', version: '0.26.0', workingCount: 2, buttons: 'two', checkedAt: null },
      { phase: 'waiting', version: '0.26.0', workingCount: 2, checkedAt: null },
      { phase: 'closed', version: '0.26.0', checkedAt: null },
      { phase: 'restarting', version: '0.26.0', checkedAt: null },
    ]) {
      expect(parseUpdateView(view)).toEqual(view);
    }
  });

  it('reads anything malformed as no update, keeping a good checkedAt', () => {
    for (const raw of [
      null,
      'ready',
      { phase: 'ready' },
      { phase: 'ready', version: '', workingCount: 0, buttons: 'one' },
      { phase: 'ready', version: '0.26.0', workingCount: -1, buttons: 'one' },
      { phase: 'ready', version: '0.26.0', workingCount: 1.5, buttons: 'one' },
      { phase: 'ready', version: '0.26.0', workingCount: 1, buttons: 'three' },
      { phase: 'downloading', version: '0.26.0', percent: 101, totalMB: 1 },
      { phase: 'available', version: '0.26.0', totalMB: -1 },
      { phase: 'later', version: '0.26.0' },
    ]) {
      expect(parseUpdateView(raw)).toEqual({ phase: 'none', checkedAt: null });
    }
    expect(parseUpdateView({ phase: 'later', checkedAt: 7 })).toEqual({ phase: 'none', checkedAt: 7 });
  });
});

describe('parseUpdateCheckAnswer', () => {
  it('passes the answers through and reads anything else as an error', () => {
    for (const answer of [
      { kind: 'up-to-date' },
      { kind: 'found', version: '0.26.0', outcome: 'offered' },
      { kind: 'found', version: '0.26.0', outcome: 'installs-on-quit' },
      { kind: 'error' },
      { kind: 'unsupported' },
    ]) {
      expect(parseUpdateCheckAnswer(answer)).toEqual(answer);
    }
    for (const raw of [
      null,
      { kind: 'found' },
      { kind: 'found', version: '', outcome: 'offered' },
      { kind: 'found', version: '0.26.0' },
      { kind: 'found', version: '0.26.0', outcome: 'maybe' },
      { kind: 'maybe' },
    ]) {
      expect(parseUpdateCheckAnswer(raw)).toEqual({ kind: 'error' });
    }
  });
});

describe('checkAnswerMessage', () => {
  const ctx = { current: '0.25.0' };
  const found = (outcome: FoundOutcome) => checkAnswerMessage({ kind: 'found', version: '0.26.0', outcome }, ctx);

  it('says nothing when the prompt on the map is the answer', () => {
    expect(found('offered')).toBeNull();
  });

  it('says what became of a version the map shows nothing for', () => {
    expect(found('downloading')?.detail).toContain('downloading');
    expect(found('installs-on-quit')).toEqual({
      message: 'Orbital 0.26.0 is downloaded.',
      detail: 'It installs when you quit Orbital.',
    });
    expect(found('held')?.detail).toContain('after Orbital restarts');
  });

  it('answers every other result of the menu item', () => {
    expect(checkAnswerMessage({ kind: 'up-to-date' }, ctx)?.message).toContain('0.25.0');
    expect(checkAnswerMessage({ kind: 'error' }, ctx)).not.toBeNull();
    expect(checkAnswerMessage({ kind: 'unsupported' }, ctx)).not.toBeNull();
  });
});
