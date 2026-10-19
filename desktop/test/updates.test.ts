import { beforeEach, describe, expect, it } from 'vitest';
import { UPDATE_KEEPALIVE_MS } from '@orbital/shared/remote/serverUpdate';
import { WorkingSessions } from '../src/lib/background';
import {
  AUTO_DOWNLOAD_KEY,
  checkAnswerMessage,
  parseAutoDownload,
  parseSkippedVersion,
  parseUpdateAction,
  parseUpdateCheckAnswer,
  parseUpdateReceipt,
  parseUpdateView,
  receiptAtLaunch,
  REMOTE_RESTART_HOLD_MS,
  serializeSkippedVersion,
  serializeUpdateReceipt,
  serverStateDue,
  shouldCheckForUpdates,
  updateSize,
  UpdateFlow,
  type FoundOutcome,
  type UpdateAction,
} from '../src/lib/updates';

const MB = 1_000_000;
/** What a view carries beside the prompt when no member's update is involved. */
const OWN = { remote: null, sessionStarted: false, receipt: null };

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
    expect(flow.view).toEqual({ phase: 'none', checkedAt: null, ...OWN });
  });

  it('remembers when it last checked', () => {
    expect(flow.checked(1000).changed).toBe(true);
    expect(flow.view.checkedAt).toBe(1000);
  });

  describe('asking before the download (setting off)', () => {
    it('offers a found version with its size, and downloads nothing', () => {
      const step = flow.available('0.26.0', 131.4 * MB);
      expect(step).toMatchObject({ changed: true, download: false, restart: false });
      expect(flow.view).toEqual({ phase: 'available', version: '0.26.0', totalMB: 131, checkedAt: null, ...OWN });
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
      expect(flow.view).toEqual({ phase: 'ready', version: '0.26.0', workingCount: 0, buttons: 'one', checkedAt: null, ...OWN });
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
      // Nothing is on the map while it waits, so a check says it waits.
      expect(flow.available('0.26.0', 130 * MB, { manual: true }).outcome).toBe('waiting');
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
      flow.setWorkingCount(working.count, working.seeded);
      flow.downloaded('0.26.0');
      flow.act('restart-when-idle');
      working.onFrame({ topic: 'sessions', event: 'upsert', session: { id: 't', source: 'terminal', status: 'working' } });
      expect(settle(working.count, working.seeded).restart).toBe(false);
      working.onFrame({ topic: 'sessions', event: 'status', sessionId: 'w', status: 'needs_input' });
      expect(settle(working.count, working.seeded).restart).toBe(true);
    });

    it('does not wait for a session parked on a decision: it is continued after the update', () => {
      const working = new WorkingSessions();
      working.seed(working.beginSeed(), { sessions: [{ id: 'p', source: 'web', status: 'working' }] });
      flow.setWorkingCount(working.count, working.seeded);
      flow.downloaded('0.26.0');
      flow.act('restart-when-idle');
      // A permission prompt or a question parks the turn as `needs_input`.
      working.onFrame({ topic: 'sessions', event: 'status', sessionId: 'p', status: 'needs_input' });
      expect(settle(working.count, working.seeded).restart).toBe(true);
    });

    it('does not restart in the gap between a turn and the one the CLI starts by itself', () => {
      // A queued message or a background agent reporting back: the turn's
      // end reads `needs_input`, and the next turn's first frame `working`.
      const working = new WorkingSessions();
      working.seed(working.beginSeed(), { sessions: [{ id: 'w', source: 'web', status: 'working' }] });
      flow.setWorkingCount(working.count, working.seeded);
      flow.downloaded('0.26.0');
      flow.act('restart-when-idle');
      working.onFrame({ topic: 'sessions', event: 'status', sessionId: 'w', status: 'needs_input' });
      expect(flow.setWorkingCount(working.count, working.seeded)).toMatchObject({ restart: false, idleCheck: true });
      working.onFrame({ topic: 'sessions', event: 'status', sessionId: 'w', status: 'working' });
      flow.setWorkingCount(working.count, working.seeded);
      expect(flow.idleSettled().restart).toBe(false);
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
        expect(settle(working.count, working.seeded).restart).toBe(false);
        expect(flow.view).toMatchObject({ phase: 'waiting', workingCount: 1 });
      });

      it('keeps waiting when the list read again still has a working session', () => {
        working.reset();
        working.seed(working.beginSeed(), { sessions: [{ id: 'w', source: 'web', status: 'working' }] });
        expect(settle(working.count, working.seeded).restart).toBe(false);
      });

      it('restarts when the list read again has nothing working', () => {
        working.reset();
        working.seed(working.beginSeed(), { sessions: [{ id: 'w', source: 'web', status: 'idle' }] });
        expect(settle(working.count, working.seeded).restart).toBe(true);
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

describe('an update a member of the group asked for', () => {
  const INSTALLED = '0.25.0';

  it('downloads the version on screen and installs it as soon as it is downloaded, without a prompt', () => {
    const flow = new UpdateFlow();
    flow.setWorkingCount(0, true);
    flow.available('0.26.0', MB);
    const start = flow.remoteStart();
    expect(start).toMatchObject({ download: true, restart: false, changed: true });
    expect(flow.view.phase).toBe('downloading');
    expect(flow.serverState(INSTALLED)).toEqual({
      t: 'update_state', installed: INSTALLED, available: '0.26.0', downloading: true, downloaded: false,
    });
    expect(flow.downloaded('0.26.0')).toMatchObject({ restart: true, remoteEnded: null });
    expect(flow.view.phase).toBe('restarting');
  });

  it('installs over the sessions working when the request arrived, but not over one that started while it downloaded', () => {
    const confirmed = new UpdateFlow();
    confirmed.setWorkingCount(2, true, ['a', 'b']);
    confirmed.available('0.26.0', MB);
    confirmed.remoteStart();
    confirmed.setWorkingCount(1, true, ['b']);
    expect(confirmed.downloaded('0.26.0')).toMatchObject({ restart: true, remoteEnded: null });

    // As many as when it was asked, but one of them is new: by id, not by count.
    const swapped = new UpdateFlow();
    swapped.setWorkingCount(1, true, ['a']);
    swapped.available('0.26.0', MB);
    swapped.remoteStart();
    swapped.setWorkingCount(1, true, ['c']);
    const landed = swapped.downloaded('0.26.0');
    // This Mac's own Ready prompt, as without a request, and the server is told at once.
    expect(landed).toMatchObject({ restart: false, changed: true, remoteEnded: 'sessions' });
    expect(swapped.view).toMatchObject({ phase: 'ready', version: '0.26.0', buttons: 'two' });
    expect(swapped.serverState(INSTALLED)).toMatchObject({ available: '0.26.0', downloaded: true });
    // The request is over: Restart here is this Mac's user's.
    expect(swapped.act('restart-when-idle')).toMatchObject({ restart: false });
    expect(swapped.view.phase).toBe('waiting');
  });

  it('declines as unknown when the working sessions cannot be told apart at the landing', () => {
    const reconnecting = new UpdateFlow();
    reconnecting.setWorkingCount(0, true);
    reconnecting.available('0.26.0', MB);
    reconnecting.remoteStart();
    reconnecting.setWorkingCount(0, false);
    expect(reconnecting.downloaded('0.26.0')).toMatchObject({ restart: false, remoteEnded: 'unknown' });
    expect(reconnecting.view.phase).toBe('ready');

    // A count given without its ids is no list of sessions.
    const countOnly = new UpdateFlow();
    countOnly.setWorkingCount(0, true);
    countOnly.available('0.26.0', MB);
    countOnly.remoteStart();
    countOnly.setWorkingCount(1, true);
    expect(countOnly.downloaded('0.26.0')).toMatchObject({ restart: false, remoteEnded: 'unknown' });

    // Not known when the request arrived: sessions working at the landing cannot be told confirmed or new.
    const unseeded = new UpdateFlow();
    unseeded.available('0.26.0', MB);
    unseeded.remoteStart();
    unseeded.setWorkingCount(1, true, ['a']);
    expect(unseeded.downloaded('0.26.0')).toMatchObject({ restart: false, remoteEnded: 'unknown' });
    const idle = new UpdateFlow();
    idle.available('0.26.0', MB);
    idle.remoteStart();
    idle.setWorkingCount(0, true, []);
    expect(idle.downloaded('0.26.0')).toMatchObject({ restart: true });
  });

  it('installs a version whose receipt was OK\'d here, when a member asks for it', () => {
    const flow = new UpdateFlow();
    flow.setWorkingCount(0, true);
    flow.downloaded('0.26.0');
    flow.act('close');
    flow.act('ok');
    // Squirrel refused the staged zip later: it no longer counts as downloaded, but stays OK'd.
    flow.downloadFailed();
    flow.available('0.26.0', MB);
    expect(flow.remoteStart()).toMatchObject({ download: true });
    expect(flow.downloaded('0.26.0')).toMatchObject({ restart: true });
  });

  it('installs at once what is downloaded already, a closed receipt included', () => {
    const ready = new UpdateFlow();
    ready.setWorkingCount(3, true);
    ready.downloaded('0.26.0');
    expect(ready.remoteStart()).toMatchObject({ restart: true });

    const closed = new UpdateFlow();
    closed.downloaded('0.26.0');
    closed.act('close');
    closed.act('ok');
    expect(closed.view.phase).toBe('none');
    expect(closed.serverState(INSTALLED)).toMatchObject({ available: '0.26.0', downloaded: true });
    expect(closed.remoteStart()).toMatchObject({ restart: true });
  });

  it('downloads a version skipped on this Mac, and takes the skip back', () => {
    const flow = new UpdateFlow({ skippedVersion: '0.26.0' });
    expect(flow.available('0.26.0', MB).outcome).toBe('skipped');
    expect(flow.serverState(INSTALLED).available).toBe('0.26.0');
    const start = flow.remoteStart();
    expect(start).toMatchObject({ download: true, skipChanged: true });
    expect(flow.skippedVersion).toBeNull();
  });

  it('joins a download already running, starting no second one', () => {
    const asked = new UpdateFlow();
    asked.setWorkingCount(0, true);
    asked.available('0.26.0', MB);
    asked.act('download');
    expect(asked.remoteStart()).toMatchObject({ download: false, restart: false });
    expect(asked.downloaded('0.26.0')).toMatchObject({ restart: true });

    const silent = new UpdateFlow();
    silent.setWorkingCount(0, true);
    silent.setAutoDownload(true);
    silent.available('0.26.0', MB);
    expect(silent.serverState(INSTALLED)).toMatchObject({ available: '0.26.0', downloading: true });
    expect(silent.remoteStart()).toMatchObject({ download: false, restart: false });
    expect(silent.downloaded('0.26.0')).toMatchObject({ restart: true });
  });

  it('does nothing with nothing found', () => {
    const flow = new UpdateFlow();
    expect(flow.remoteStart()).toMatchObject({ download: false, restart: false, changed: false, remoteEnded: null });
    expect(flow.serverState(INSTALLED)).toEqual({
      t: 'update_state', installed: INSTALLED, available: null, downloading: false, downloaded: false,
    });
  });

  it('asked while a restart has not got the app out: restarts once more, then ends the request at once', () => {
    const flow = new UpdateFlow();
    flow.downloaded('0.26.0');
    flow.act('restart-now');
    expect(flow.remoteStart()).toMatchObject({ restart: true, remoteEnded: null });
    expect(flow.remoteStart()).toMatchObject({ restart: false, download: false, remoteEnded: 'restart' });
    expect(flow.view.phase).toBe('restarting');
  });

  it('a cancelled request lets a late download prompt instead of installing', () => {
    const flow = new UpdateFlow();
    flow.available('0.26.0', MB);
    flow.remoteStart();
    flow.remoteCancel();
    expect(flow.downloaded('0.26.0')).toMatchObject({ restart: false });
    expect(flow.view.phase).toBe('ready');
  });

  it('a failed download leaves the request behind: the next download prompts as before', () => {
    const flow = new UpdateFlow();
    flow.available('0.26.0', MB);
    flow.remoteStart();
    flow.downloadFailed();
    expect(flow.view.phase).toBe('available');
    flow.act('download');
    expect(flow.downloaded('0.26.0')).toMatchObject({ restart: false });
    expect(flow.view.phase).toBe('ready');
  });
});

describe('an update another member started, as this Mac shows it (canvas 50v)', () => {
  const AT = 1_760_000_000_000;
  /** A Mac with 0.26.0 found and `ids` working, asked by Pixel 8. */
  function asked(ids: string[], by: string | null = 'Pixel 8') {
    const flow = new UpdateFlow({ now: () => AT });
    flow.setWorkingCount(ids.length, true, ids);
    flow.available('0.26.0', MB);
    const start = flow.remoteStart(by);
    return { flow, start };
  }

  it('01: shows the download as the member\'s, with the live count of what the restart stops', () => {
    const { flow, start } = asked(['a', 'b']);
    expect(start).toMatchObject({ download: true, changed: true });
    expect(flow.view).toMatchObject({ phase: 'downloading', remote: { by: 'Pixel 8', working: 2 } });
    expect(flow.setWorkingCount(1, true, ['a']).changed).toBe(true);
    expect(flow.view.remote).toEqual({ by: 'Pixel 8', working: 1 });
  });

  it('02: holds the last line before the restart, and leaves the receipt for the relaunched app', () => {
    const { flow } = asked(['a', 'b']);
    const landed = flow.downloaded('0.26.0');
    expect(landed).toMatchObject({
      restart: true, holdMs: REMOTE_RESTART_HOLD_MS, remoteEnded: null,
      receipt: { by: 'Pixel 8', at: AT, stopped: 2, version: '0.26.0' },
    });
    expect(flow.view).toMatchObject({ phase: 'restarting', version: '0.26.0', remote: { by: 'Pixel 8', working: 2 } });
    // A session starting during the hold changes nothing: the restart goes ahead.
    const during = flow.setWorkingCount(3, true, ['a', 'b', 'c']);
    expect(during).toMatchObject({ restart: false, receipt: null });
    expect(flow.view.phase).toBe('restarting');
  });

  it('holds the last line too when the update was downloaded already', () => {
    const flow = new UpdateFlow({ now: () => AT });
    flow.setWorkingCount(1, true, ['a']);
    flow.downloaded('0.26.0');
    expect(flow.remoteStart('Pixel 8')).toMatchObject({
      restart: true, holdMs: REMOTE_RESTART_HOLD_MS, receipt: { by: 'Pixel 8', stopped: 1, version: '0.26.0' },
    });
    expect(flow.view).toMatchObject({ phase: 'restarting', remote: { by: 'Pixel 8' } });
  });

  it('asked on this Mac, it is the Mac\'s own update: no member named, no hold, no receipt', () => {
    const { flow } = asked([], null);
    expect(flow.view.remote).toBeNull();
    expect(flow.downloaded('0.26.0')).toMatchObject({ restart: true, holdMs: 0, receipt: null });
    expect(flow.view.remote).toBeNull();
  });

  it('03: a session started here: this Mac\'s Ready, waiting for its user, until a button there', () => {
    const { flow } = asked(['a']);
    flow.setWorkingCount(2, true, ['a', 'c']);
    expect(flow.downloaded('0.26.0')).toMatchObject({ restart: false, remoteEnded: 'sessions', receipt: null });
    expect(flow.view).toMatchObject({ phase: 'ready', workingCount: 2, buttons: 'two', remote: null, sessionStarted: true });
    flow.act('restart-when-idle');
    expect(flow.view).toMatchObject({ phase: 'waiting', sessionStarted: false });
    flow.act('cancel-wait');
    expect(flow.view).toMatchObject({ phase: 'ready', sessionStarted: false });

    // Not when the sessions could not be told apart, and not for a request made on this Mac.
    const unknown = asked(['a']).flow;
    unknown.setWorkingCount(1, false);
    unknown.downloaded('0.26.0');
    expect(unknown.view).toMatchObject({ phase: 'ready', sessionStarted: false });
    const local = asked(['a'], null).flow;
    local.setWorkingCount(2, true, ['a', 'c']);
    local.downloaded('0.26.0');
    expect(local.view).toMatchObject({ phase: 'ready', sessionStarted: false });
  });

  it('03, then asked again: the restart goes, held, from Ready', () => {
    const { flow } = asked(['a']);
    flow.setWorkingCount(2, true, ['a', 'c']);
    flow.downloaded('0.26.0');
    expect(flow.remoteStart('nuc')).toMatchObject({ restart: true, holdMs: REMOTE_RESTART_HOLD_MS, receipt: { by: 'nuc' } });
    expect(flow.view).toMatchObject({ phase: 'restarting', sessionStarted: false, remote: { by: 'nuc' } });
  });

  it('shows a download running by itself once a member asks for it', () => {
    const flow = new UpdateFlow();
    flow.setWorkingCount(0, true, []);
    flow.setAutoDownload(true);
    flow.available('0.26.0', MB);
    expect(flow.view.phase).toBe('none');
    expect(flow.remoteStart('Pixel 8')).toMatchObject({ changed: true, download: false });
    expect(flow.view).toMatchObject({ phase: 'downloading', version: '0.26.0', remote: { by: 'Pixel 8' } });
    expect(flow.progress(40, 92 * MB)).toMatchObject({ changed: true });
    expect(flow.view).toMatchObject({ percent: 40, totalMB: 92 });
  });

  it('a retried restart goes at once and writes no second receipt', () => {
    const { flow } = asked([]);
    flow.downloaded('0.26.0');
    expect(flow.remoteStart('Pixel 8')).toMatchObject({ restart: true, holdMs: 0, receipt: null });
  });

  it('a restart that fails takes its receipt back; a cancelled request is this Mac\'s own download', () => {
    const failed = asked([]).flow;
    failed.downloaded('0.26.0');
    expect(failed.updaterError()).toMatchObject({ receipt: 'clear' });
    expect(failed.view).toMatchObject({ phase: 'available', remote: null });

    const cancelled = asked([]).flow;
    expect(cancelled.remoteCancel()).toMatchObject({ changed: true });
    expect(cancelled.view).toMatchObject({ phase: 'downloading', remote: null });
    expect(cancelled.downloaded('0.26.0')).toMatchObject({ restart: false, receipt: null });
  });

  it('04: the relaunched app tells the receipt until × on it', () => {
    const receipt = { by: 'Pixel 8', at: AT, stopped: 2, version: '0.26.0' };
    const flow = new UpdateFlow({ receipt });
    expect(flow.view.receipt).toEqual(receipt);
    expect(flow.act('receipt-close')).toMatchObject({ changed: true, receipt: 'clear' });
    expect(flow.view.receipt).toBeNull();
    expect(flow.act('receipt-close')).toMatchObject({ changed: false, receipt: null });
  });
});

describe('update receipt file', () => {
  const receipt = { by: 'Pixel 8', at: 1_760_000_000_000, stopped: 2, version: '0.26.0' };

  it('round-trips, and reads anything malformed as none', () => {
    expect(parseUpdateReceipt(serializeUpdateReceipt(receipt))).toEqual(receipt);
    for (const raw of ['', '{', 'null', '[]', JSON.stringify({ ...receipt, stopped: -1 }), JSON.stringify({ ...receipt, by: '' }),
      JSON.stringify({ ...receipt, at: '14:02' }), JSON.stringify({ by: 'Pixel 8' })]) {
      expect(parseUpdateReceipt(raw)).toBeNull();
    }
    // Fields it does not know are not carried.
    expect(parseUpdateReceipt(JSON.stringify({ ...receipt, extra: 1 }))).toEqual(receipt);
  });

  it('is told only by a launch on the version it was written for', () => {
    expect(receiptAtLaunch(receipt, '0.26.0')).toEqual(receipt);
    expect(receiptAtLaunch(receipt, '0.25.0')).toBeNull();
    expect(receiptAtLaunch(null, '0.26.0')).toBeNull();
  });
});

describe('serverStateDue', () => {
  const json = '{"t":"update_state"}';

  it('sends the first state, and any change at once', () => {
    expect(serverStateDue(null, json, false, 0)).toBe(true);
    expect(serverStateDue({ json, at: 0 }, '{"other":1}', false, 1)).toBe(true);
  });

  it('sends the same state again only while downloading, once UPDATE_KEEPALIVE_MS has passed', () => {
    expect(serverStateDue({ json, at: 0 }, json, false, UPDATE_KEEPALIVE_MS * 10)).toBe(false);
    expect(serverStateDue({ json, at: 0 }, json, true, UPDATE_KEEPALIVE_MS - 1)).toBe(false);
    expect(serverStateDue({ json, at: 0 }, json, true, UPDATE_KEEPALIVE_MS)).toBe(true);
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
  it('takes the eight actions and nothing else', () => {
    for (const action of ['download', 'skip', 'restart-now', 'restart-when-idle', 'cancel-wait', 'close', 'ok', 'receipt-close']) {
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
      expect(parseUpdateView({ ...view, ...OWN })).toEqual({ ...view, ...OWN });
    }
  });

  it('passes a member\'s update through where it belongs, and drops it anywhere else or malformed', () => {
    const remote = { by: 'Pixel 8', working: 2 };
    const receipt = { by: 'Pixel 8', at: 5, stopped: 2, version: '0.26.0' };
    const dl = { phase: 'downloading', version: '0.26.0', percent: 40, totalMB: 130, checkedAt: null };
    expect(parseUpdateView({ ...dl, remote, sessionStarted: false, receipt })).toEqual({ ...dl, remote, sessionStarted: false, receipt });
    const restarting = { phase: 'restarting', version: '0.26.0', checkedAt: null };
    expect(parseUpdateView({ ...restarting, remote })).toMatchObject({ remote });
    const ready = { phase: 'ready', version: '0.26.0', workingCount: 3, buttons: 'two', checkedAt: null };
    expect(parseUpdateView({ ...ready, remote, sessionStarted: true })).toEqual({ ...ready, ...OWN, sessionStarted: true });
    // Only Ready waits for this Mac's user; only a download or a restart is a member's.
    expect(parseUpdateView({ ...dl, sessionStarted: true }).sessionStarted).toBe(false);
    for (const bad of [{ by: '', working: 1 }, { by: 'Pixel 8', working: -1 }, { by: 3, working: 1 }, 'Pixel 8']) {
      expect(parseUpdateView({ ...dl, remote: bad }).remote).toBeNull();
    }
    for (const bad of [{ ...receipt, at: -1 }, { ...receipt, by: '' }, { ...receipt, version: 3 }, { by: 'x' }]) {
      expect(parseUpdateView({ phase: 'none', receipt: bad }).receipt).toBeNull();
    }
    expect(parseUpdateView({ phase: 'none', checkedAt: null, receipt })).toEqual({ phase: 'none', checkedAt: null, ...OWN, receipt });
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
      expect(parseUpdateView(raw)).toEqual({ phase: 'none', checkedAt: null, ...OWN });
    }
    expect(parseUpdateView({ phase: 'later', checkedAt: 7 })).toEqual({ phase: 'none', checkedAt: 7, ...OWN });
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
    expect(found('waiting')?.detail).toContain('when the working sessions finish');
  });

  it('answers every other result of the menu item', () => {
    expect(checkAnswerMessage({ kind: 'up-to-date' }, ctx)?.message).toContain('0.25.0');
    expect(checkAnswerMessage({ kind: 'error' }, ctx)).not.toBeNull();
    expect(checkAnswerMessage({ kind: 'unsupported' }, ctx)).not.toBeNull();
  });
});
