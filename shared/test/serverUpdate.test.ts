import { describe, expect, it } from 'vitest';
import {
  SERVER_UPDATE_VERSION, UPDATE_POLL_MS, UPDATE_TIMEOUT_MS, parseMainMessage, parseServerMessage, parseServerUpdateState,
  memberServesUpdate, servesServerUpdate, updateIsNewer, updatePollDelay, watchUpdate, watchVerdict, type ServerUpdateState,
} from '../src/remote/serverUpdate.js';

const state = (over: Partial<ServerUpdateState> = {}): ServerUpdateState => ({
  installed: '0.35.0', candidate: '0.36.0', packaged: true, updating: false, failed: null, sessions: 0, startedBy: null, ...over,
});

describe('parseServerUpdateState', () => {
  it('takes a well-formed state', () => {
    expect(parseServerUpdateState(state())).toEqual(state());
    expect(parseServerUpdateState(state({ candidate: null, installed: 'dev', failed: '1:0.36.0-1' }))).not.toBeNull();
  });

  it('reads startedBy: kept when well-formed, null when absent (an older server) or malformed', () => {
    const by = { id: 'abcd1234', name: 'Pixel 8' };
    expect(parseServerUpdateState(state({ updating: true, startedBy: by }))?.startedBy).toEqual(by);
    const { startedBy: _b, ...older } = state();
    expect(parseServerUpdateState(older)?.startedBy).toBeNull();
    expect(parseServerUpdateState({ ...state(), startedBy: { id: 7, name: 'x' } })?.startedBy).toBeNull();
    expect(parseServerUpdateState({ ...state(), startedBy: { id: 'x'.repeat(500), name: 'x' } })?.startedBy).toBeNull();
    expect(parseServerUpdateState({ ...state(), startedBy: { id: 'a', name: 'n'.repeat(500) } })?.startedBy?.name.length)
      .toBeLessThan(500);
  });

  it('refuses a missing field, a negative count and a version that is not one', () => {
    const { sessions: _s, ...noSessions } = state();
    expect(parseServerUpdateState(noSessions)).toBeNull();
    expect(parseServerUpdateState(state({ sessions: -1 }))).toBeNull();
    expect(parseServerUpdateState(state({ candidate: '../../etc' }))).toBeNull();
    expect(parseServerUpdateState(state({ installed: '--yes' }))).toBeNull();
    expect(parseServerUpdateState(state({ installed: 'x'.repeat(65) }))).toBeNull();
    expect(parseServerUpdateState(null)).toBeNull();
  });
});

describe('servesServerUpdate', () => {
  it('is true from SERVER_UPDATE_VERSION on, and for a dev server', () => {
    expect(servesServerUpdate(SERVER_UPDATE_VERSION)).toBe(true);
    expect(servesServerUpdate('0.40.1')).toBe(true);
    expect(servesServerUpdate('dev')).toBe(true);
  });

  it('is false below it and before a hello named any version', () => {
    expect(servesServerUpdate('0.34.9')).toBe(false);
    expect(servesServerUpdate(null)).toBe(false);
    expect(servesServerUpdate(undefined)).toBe(false);
    expect(servesServerUpdate('')).toBe(false);
  });
});

describe('updateIsNewer', () => {
  it('only a strictly newer candidate', () => {
    expect(updateIsNewer('0.35.0', '0.36.0')).toBe(true);
    expect(updateIsNewer('0.35.0', '0.35.0')).toBe(false);
    expect(updateIsNewer('0.36.0', '0.35.0')).toBe(false);
    expect(updateIsNewer('0.35.0', null)).toBe(false);
  });
});

describe('main ↔ server messages', () => {
  it('takes the two messages as they are sent', () => {
    const msg = { t: 'update_state', installed: '0.35.0', available: '0.36.0', downloading: true, downloaded: false };
    expect(parseMainMessage(msg)).toEqual(msg);
    expect(parseMainMessage({ ...msg, available: null })).not.toBeNull();
    expect(parseServerMessage({ t: 'update_start' })).toEqual({ t: 'update_start' });
    expect(parseServerMessage({ t: 'update_cancel' })).toEqual({ t: 'update_cancel' });
  });

  it('ignores anything malformed, extra or sent the wrong way', () => {
    const msg = { t: 'update_state', installed: '0.35.0', available: null, downloading: false, downloaded: false };
    expect(parseMainMessage({ ...msg, downloaded: 'yes' })).toBeNull();
    expect(parseMainMessage({ ...msg, url: 'https://example.com/evil.zip' })).toBeNull();
    expect(parseMainMessage({ ...msg, available: '/tmp/evil' })).toBeNull();
    expect(parseMainMessage({ t: 'update_start' })).toBeNull();
    expect(parseServerMessage({ t: 'update_start', version: '9.9.9' })).toBeNull();
    expect(parseServerMessage({ t: 'update_cancel', url: 'https://example.com' })).toBeNull();
    expect(parseServerMessage({ t: 'update_restart' })).toBeNull();
    expect(parseServerMessage(msg)).toBeNull();
    expect(parseServerMessage('update_start')).toBeNull();
  });
});

describe('watching an update', () => {
  const watch = watchUpdate(state({ updating: true }), 1_000);

  it('is done once the member answers with another version', () => {
    expect(watchVerdict(watch, state({ installed: '0.36.0', candidate: '0.36.0' }), 2_000)).toBe('updated');
  });

  it('keeps going while the member cannot be read or still says updating', () => {
    expect(watchVerdict(watch, null, 2_000)).toBe('updating');
    expect(watchVerdict(watch, state({ updating: true }), 2_000)).toBe('updating');
  });

  it('fails when the member is back with the old version, or after UPDATE_TIMEOUT_MS', () => {
    expect(watchVerdict(watch, state({ failed: '0.36.0' }), 2_000)).toBe('failed');
    expect(watchVerdict(watch, state(), 2_000)).toBe('failed');
    expect(watchVerdict(watch, null, 1_000 + UPDATE_TIMEOUT_MS)).toBe('failed');
    expect(watchVerdict(watch, state({ updating: true }), 1_000 + UPDATE_TIMEOUT_MS)).toBe('failed');
  });

  it('a new version wins over the timeout', () => {
    expect(watchVerdict(watch, state({ installed: '0.36.0' }), 1_000 + UPDATE_TIMEOUT_MS * 2)).toBe('updated');
  });

  it('polls only while the page is open and a row is watched', () => {
    expect(updatePollDelay({ pageOpen: true, watching: true })).toBe(UPDATE_POLL_MS);
    expect(updatePollDelay({ pageOpen: true, watching: false })).toBeNull();
    expect(updatePollDelay({ pageOpen: false, watching: true })).toBeNull();
  });
});

describe('memberServesUpdate', () => {
  it('asks this device always, a phone never, and another member by its version', () => {
    expect(memberServesUpdate({ self: true, kind: 'desktop', version: null })).toBe(true);
    expect(memberServesUpdate({ self: false, kind: 'phone', version: '9.0.0' })).toBe(false);
    expect(memberServesUpdate({ self: false, kind: 'headless', version: SERVER_UPDATE_VERSION })).toBe(true);
    expect(memberServesUpdate({ self: false, kind: 'desktop', version: '0.1.0' })).toBe(false);
    expect(memberServesUpdate({ self: false, kind: 'desktop' })).toBe(false);
  });
});
