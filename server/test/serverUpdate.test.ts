import { describe, it, expect, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { parseAptPolicy } from '../src/update/aptPolicy.js';
import {
  AptUpdateBackend, chooseUpdateBackend, DesktopUpdateBackend, PACKAGE_ROOT, PACKAGE_VERSION_FILE, runningVersion,
  UPDATE_REQUEST_FILE, type ParentPort, type UpdateBackend, type UpdateProgress,
} from '../src/update/backends.js';
import { UPDATE_MARKER_FILE, UpdateService, readMarker } from '../src/update/service.js';
import { updateAsker } from '../src/api/serverUpdate.js';
import { DEVICE_HEADER } from '../src/remote/inject.js';
import { deviceId } from '@orbital/shared/remote/keys';
import { loadOrCreateIdentity } from '../src/remote/identity.js';
import BetterSqlite3 from 'better-sqlite3';
import { makeTmpDir } from './tmp.js';

const NEWER = `orbital:
  Installed: 0.35.0
  Candidate: 0.36.0
  Version table:
     0.36.0 500
        500 https://apt.orbital.slothworks.io stable/main amd64 Packages
 *** 0.35.0 100
        100 /var/lib/dpkg/status
`;

const INSTALLED_ONLY = `orbital:
  Installed: 0.35.0
  Candidate: 0.35.0
  Version table:
 *** 0.35.0 100
        100 /var/lib/dpkg/status
`;

const NONE = `orbital:
  Installed: (none)
  Candidate: (none)
  Version table:
`;

const GERMAN = `orbital:
  Installiert:           0.35.0
  Installationskandidat: 0.36.0
  Versionstabelle:
     0.36.0 500
`;

describe('parseAptPolicy', () => {
  it('reads the installed and candidate versions', () => {
    expect(parseAptPolicy(NEWER)).toEqual({ installed: '0.35.0', candidate: '0.36.0' });
    expect(parseAptPolicy(INSTALLED_ONLY)).toEqual({ installed: '0.35.0', candidate: '0.35.0' });
    expect(parseAptPolicy(NEWER.replace(/\n/g, '\r\n'))).toEqual({ installed: '0.35.0', candidate: '0.36.0' });
  });

  it('reads (none) as unknown', () => {
    expect(parseAptPolicy(NONE)).toEqual({ installed: null, candidate: null });
  });

  it('finds nothing in another language, in no output, or in another package\'s block', () => {
    expect(parseAptPolicy(GERMAN)).toEqual({ installed: null, candidate: null });
    expect(parseAptPolicy('')).toEqual({ installed: null, candidate: null });
    expect(parseAptPolicy(NEWER.replace('orbital:', 'orbital-extra:'))).toEqual({ installed: null, candidate: null });
  });

  it('keeps a Debian epoch and revision, and refuses what is not a version', () => {
    expect(parseAptPolicy(NEWER.replace('Candidate: 0.36.0', 'Candidate: 1:0.36.0-1ubuntu1')).candidate).toBe('1:0.36.0-1ubuntu1');
    expect(parseAptPolicy(NEWER.replace('Candidate: 0.36.0', 'Candidate: /etc/passwd')).candidate).toBeNull();
  });
});

describe('chooseUpdateBackend', () => {
  const base = { headless: false, entry: '/repo/server/dist/index.mjs', packageRoot: PACKAGE_ROOT, desktopParent: false, parentPort: false };

  it('apt only for a headless server running from the package', () => {
    expect(chooseUpdateBackend({ ...base, headless: true, entry: `${PACKAGE_ROOT}/server/index.mjs` })).toBe('apt');
    expect(chooseUpdateBackend({ ...base, headless: true })).toBe('none');
    expect(chooseUpdateBackend({ ...base, entry: `${PACKAGE_ROOT}/server/index.mjs` })).toBe('none');
    expect(chooseUpdateBackend({ ...base, headless: true, entry: `${PACKAGE_ROOT}-evil/server/index.mjs` })).toBe('none');
    expect(chooseUpdateBackend({ ...base, headless: true, entry: `${PACKAGE_ROOT}/../tmp/index.mjs` })).toBe('none');
    expect(chooseUpdateBackend({ ...base, headless: true, entry: undefined })).toBe('none');
  });

  it('desktop only with both the parent pid and its message port', () => {
    expect(chooseUpdateBackend({ ...base, desktopParent: true, parentPort: true })).toBe('desktop');
    expect(chooseUpdateBackend({ ...base, desktopParent: true })).toBe('none');
    expect(chooseUpdateBackend({ ...base, parentPort: true })).toBe('none');
  });
});

describe('runningVersion', () => {
  const entry = `${PACKAGE_ROOT}/server/index.mjs`;
  const files = (map: Record<string, string>) => (path: string) => {
    if (path in map) return map[path];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const versionFile = join(PACKAGE_ROOT, PACKAGE_VERSION_FILE);

  it('takes ORBITAL_VERSION first, as the desktop sets it', () => {
    const read = files({ [versionFile]: '0.40.0\n' });
    expect(runningVersion({ env: { ORBITAL_VERSION: '0.39.0' }, entry, packageRoot: PACKAGE_ROOT, read })).toBe('0.39.0');
  });

  it("reads the package's file for a server run from the package", () => {
    const read = files({ [versionFile]: '0.40.0\n' });
    expect(runningVersion({ env: {}, entry, packageRoot: PACKAGE_ROOT, read })).toBe('0.40.0');
  });

  it('is null off the package, without the file, or with something that is no version in it', () => {
    const read = files({ [versionFile]: '0.40.0' });
    expect(runningVersion({ env: {}, entry: '/home/u/orbital/server/dist/index.mjs', packageRoot: PACKAGE_ROOT, read })).toBeNull();
    expect(runningVersion({ env: {}, entry, packageRoot: PACKAGE_ROOT, read: files({}) })).toBeNull();
    expect(runningVersion({ env: {}, entry, packageRoot: PACKAGE_ROOT, read: files({ [versionFile]: '../../x y' }) })).toBeNull();
  });
});

describe('AptUpdateBackend', () => {
  it('writes the request file into the setup directory, and refuses without one', () => {
    const dir = makeTmpDir('update-request');
    const apt = new AptUpdateBackend({ requestDir: dir, run: async () => NEWER });
    expect(apt.request()).toBe('ok');
    expect(readFileSync(join(dir, UPDATE_REQUEST_FILE), 'utf8')).toMatch(/^\d+\n$/);
    // A symlink planted at the request's path is replaced, never written through.
    const target = join(makeTmpDir('update-target'), 'victim');
    writeFileSync(target, 'keep');
    rmSync(join(dir, UPDATE_REQUEST_FILE));
    symlinkSync(target, join(dir, UPDATE_REQUEST_FILE));
    expect(apt.request()).toBe('ok');
    expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(lstatSync(join(dir, UPDATE_REQUEST_FILE)).isSymbolicLink()).toBe(false);
    expect(new AptUpdateBackend({ requestDir: join(dir, 'missing') }).request()).toBe('not_set_up');
    writeFileSync(join(dir, 'file'), '');
    expect(new AptUpdateBackend({ requestDir: join(dir, 'file') }).request()).toBe('not_set_up');
  });

  it('reads apt once at a time, and keeps what it knew when a read fails', async () => {
    let calls = 0;
    let out: Promise<string> = Promise.resolve(NEWER);
    const apt = new AptUpdateBackend({ run: () => { calls++; return out; } });
    await Promise.all([apt.refresh(), apt.refresh()]);
    expect(calls).toBe(1);
    expect(apt.versions()).toEqual({ installed: '0.35.0', candidate: '0.36.0' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    out = Promise.reject(new Error('timed out'));
    await apt.refresh();
    warn.mockRestore();
    expect(apt.versions()).toEqual({ installed: '0.35.0', candidate: '0.36.0' });
  });
});

class FakePort implements ParentPort {
  listeners = new Set<(event: { data: unknown }) => void>();
  sent: unknown[] = [];
  on(_e: 'message', l: (event: { data: unknown }) => void) { this.listeners.add(l); }
  removeListener(_e: 'message', l: (event: { data: unknown }) => void) { this.listeners.delete(l); }
  postMessage(m: unknown) { this.sent.push(m); }
  emit(data: unknown) { for (const l of this.listeners) l({ data }); }
}

describe('DesktopUpdateBackend', () => {
  it('takes main\'s state, ignores anything malformed, and asks main with a bare update_start', () => {
    const port = new FakePort();
    const desktop = new DesktopUpdateBackend(port);
    expect(desktop.versions()).toEqual({ installed: null, candidate: null });
    port.emit({ t: 'update_state', installed: '0.35.0', available: '0.36.0', downloading: false, downloaded: false });
    port.emit({ t: 'update_state', installed: '0.35.0', available: 'https://evil', downloading: false, downloaded: false });
    port.emit('garbage');
    expect(desktop.versions()).toEqual({ installed: '0.35.0', candidate: '0.36.0' });
    expect(desktop.request()).toBe('ok');
    desktop.cancel();
    expect(port.sent).toEqual([{ t: 'update_start' }, { t: 'update_cancel' }]);
    desktop.stop();
    expect(port.listeners.size).toBe(0);
  });

  it('reports main\'s progress with every valid state', () => {
    const port = new FakePort();
    const desktop = new DesktopUpdateBackend(port);
    const seen: UpdateProgress[] = [];
    desktop.onProgress((p) => seen.push(p));
    const msg = { t: 'update_state', installed: '0.35.0', available: '0.36.0', downloading: false, downloaded: false };
    port.emit(msg);
    port.emit({ ...msg, downloading: true });
    port.emit({ ...msg, downloaded: true });
    port.emit({ ...msg, downloading: 'yes' });
    port.emit({ t: 'update_ended', reason: 'sessions' });
    port.emit({ t: 'update_ended', reason: 'bored' });
    expect(seen).toEqual(['idle', 'downloading', 'downloaded', { ended: 'sessions' }]);
    // An end is no state: the versions stay what the last state said.
    expect(desktop.versions()).toEqual({ installed: '0.35.0', candidate: '0.36.0' });
  });
});

/** A backend whose versions and answer the test sets. */
function fakeBackend(over: Partial<{ kind: UpdateBackend['kind']; installed: string | null; candidate: string | null; answer: 'ok' | 'not_set_up' }> = {}) {
  const b = {
    kind: 'apt' as UpdateBackend['kind'], installed: '0.35.0' as string | null, candidate: '0.36.0' as string | null,
    answer: 'ok' as 'ok' | 'not_set_up', requests: 0, cancels: 0, stopped: false,
    progress: (_p: UpdateProgress) => {},
    ...over,
  };
  const backend: UpdateBackend = {
    get kind() { return b.kind; },
    versions: () => ({ installed: b.installed, candidate: b.candidate }),
    request: () => { b.requests++; return b.answer; },
    cancel: () => { b.cancels++; },
    onProgress: (l) => { b.progress = l; },
    stop: () => { b.stopped = true; },
  };
  return { b, backend };
}

describe('UpdateService', () => {
  const make = (backend: UpdateBackend, running = '0.35.0', dir = makeTmpDir('update-service'), timeoutMs?: number) =>
    ({ dir, service: new UpdateService({ backend, running, markerPath: join(dir, UPDATE_MARKER_FILE), sessions: () => 2, timeoutMs }) });

  it('reports the state, the running version standing in for an installed one not known', () => {
    const { b, backend } = fakeBackend({ installed: null });
    const { service } = make(backend);
    expect(service.state()).toEqual({
      installed: '0.35.0', candidate: '0.36.0', packaged: true, updating: false, failed: null, sessions: 2, startedBy: null,
      failedReason: null,
    });
    b.kind = 'none';
    expect(service.state().packaged).toBe(false);
  });

  it('refuses in order: not_packaged, no_update, not_set_up, then updating', () => {
    const none = fakeBackend({ kind: 'none' });
    expect(make(none.backend).service.start()).toEqual({ ok: false, error: 'not_packaged', status: 501 });
    const same = fakeBackend({ candidate: '0.35.0' });
    expect(make(same.backend).service.start()).toMatchObject({ ok: false, error: 'no_update', status: 409 });
    const older = fakeBackend({ candidate: '0.34.0' });
    expect(make(older.backend).service.start()).toMatchObject({ error: 'no_update' });
    const unset = fakeBackend({ answer: 'not_set_up' });
    const u = make(unset.backend).service;
    expect(u.start()).toMatchObject({ ok: false, error: 'not_set_up', status: 409 });
    expect(u.state().updating).toBe(false);

    const { b, backend } = fakeBackend();
    const { service } = make(backend);
    expect(service.start()).toMatchObject({ ok: true, state: { updating: true, failed: null } });
    expect(service.start()).toMatchObject({ ok: false, error: 'updating', status: 409 });
    expect(b.requests).toBe(1);
    service.stop();
  });

  it('a start with the version that asked says the update failed; another version forgets the request', () => {
    const { backend } = fakeBackend();
    const { dir, service } = make(backend);
    service.start();
    service.stop();
    expect(make(backend, '0.35.0', dir).service.state().failed).toBe('0.36.0');
    // Still failed at the next start of that version, until a new request or a new version.
    expect(make(backend, '0.35.0', dir).service.state().failed).toBe('0.36.0');
    const again = make(backend, '0.35.0', dir).service;
    again.start();
    expect(again.state().failed).toBeNull();
    again.stop();
    expect(make(backend, '0.36.0', dir).service.state().failed).toBeNull();
    expect(existsSync(join(dir, UPDATE_MARKER_FILE))).toBe(false);
  });

  it('names who started an update while it runs, and forgets it when it ends', () => {
    vi.useFakeTimers();
    try {
      const by = { id: 'peer-1', name: 'Pixel 8' };
      const { backend } = fakeBackend();
      const { dir, service } = make(backend, '0.35.0', undefined, 1_000);
      expect(service.start(by)).toMatchObject({ ok: true, state: { updating: true, startedBy: by } });
      expect(readMarker(join(dir, UPDATE_MARKER_FILE))).toMatchObject({ from: '0.35.0', to: '0.36.0' });
      vi.advanceTimersByTime(1_000);
      expect(service.state()).toMatchObject({ updating: false, failed: '0.36.0', startedBy: null });
      // A request with no known asker names no one.
      expect(service.start(null)).toMatchObject({ ok: true, state: { startedBy: null } });
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a restart ends the update either way, so the marker\'s asker is not shown after it', () => {
    const by = { id: 'peer-1', name: 'Pixel 8' };
    const { backend } = fakeBackend();
    const { dir, service } = make(backend);
    service.start(by);
    service.stop();
    // Back on the old version: failed, and no one is updating it.
    expect(make(backend, '0.35.0', dir).service.state()).toMatchObject({ updating: false, failed: '0.36.0', startedBy: null });
    // Back on the new one: done, and the marker is gone with its asker.
    expect(make(backend, '0.36.0', dir).service.state()).toMatchObject({ failed: null, startedBy: null });
    expect(readMarker(join(dir, UPDATE_MARKER_FILE))).toBeNull();
  });

  it('reads a marker that also names an asker (written before the asker was dropped) as a marker', () => {
    const dir = makeTmpDir('update-marker-by');
    const path = join(dir, UPDATE_MARKER_FILE);
    writeFileSync(path, JSON.stringify({ from: '0.35.0', to: '0.36.0', at: 1, by: { id: 'p', name: 'Pixel 8' } }));
    expect(readMarker(path)).toEqual({ from: '0.35.0', to: '0.36.0', at: 1 });
  });

  it('ignores a marker that is not one', () => {
    const dir = makeTmpDir('update-marker');
    writeFileSync(join(dir, UPDATE_MARKER_FILE), '{"from": 1}');
    expect(make(fakeBackend().backend, '0.35.0', dir).service.state().failed).toBeNull();
  });

  it('gives up waiting for the restart after the timeout, and takes a new request then', () => {
    vi.useFakeTimers();
    try {
      const { b, backend } = fakeBackend();
      const { service } = make(backend, '0.35.0', undefined, 1_000);
      service.start();
      vi.advanceTimersByTime(1_000);
      expect(service.state()).toMatchObject({ updating: false, failed: '0.36.0' });
      expect(b.cancels).toBe(1);
      expect(service.start()).toMatchObject({ ok: true });
      expect(b.requests).toBe(2);
      service.stop();
      expect(b.stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits on while the Mac is still downloading', () => {
    vi.useFakeTimers();
    try {
      const { b, backend } = fakeBackend({ kind: 'desktop' });
      const { service } = make(backend, '0.35.0', undefined, 1_000);
      service.start();
      vi.advanceTimersByTime(900);
      b.progress('downloading');
      vi.advanceTimersByTime(900);
      expect(service.state().updating).toBe(true);
      vi.advanceTimersByTime(100);
      expect(service.state()).toMatchObject({ updating: false, failed: '0.36.0' });
      expect(b.cancels).toBe(1);
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails at once when the Mac\'s download stops without the update, and not on a word from before it began', () => {
    const { b, backend } = fakeBackend({ kind: 'desktop' });
    const { service } = make(backend);
    service.start();
    // Main's state from before it took the request: nothing has started yet.
    b.progress('idle');
    expect(service.state().updating).toBe(true);
    b.progress('downloading');
    b.progress('idle');
    expect(service.state()).toMatchObject({ updating: false, failed: '0.36.0' });
    expect(b.cancels).toBe(0);
    expect(service.start()).toMatchObject({ ok: true });
    service.stop();
  });

  it('a request that joins a download already running fails when that download stops', () => {
    const { b, backend } = fakeBackend({ kind: 'desktop' });
    const { service } = make(backend);
    // Main was downloading by itself before anyone asked; nothing changes in its state when they do.
    b.progress('downloading');
    service.start();
    b.progress('idle');
    expect(service.state()).toMatchObject({ updating: false, failed: '0.36.0' });
    service.stop();
  });

  it('fails at once, with the reason, when main ends the request because sessions started', () => {
    const { b, backend } = fakeBackend({ kind: 'desktop' });
    const { service } = make(backend);
    service.start({ id: 'peer-1', name: 'Pixel 8' });
    b.progress('downloading');
    b.progress({ ended: 'sessions' });
    expect(service.state()).toMatchObject({ updating: false, failed: '0.36.0', failedReason: 'sessions', startedBy: null });
    expect(service.start()).toMatchObject({ ok: true, state: { failed: null, failedReason: null } });
    // Any other end fails it too, with no reason the screens word.
    b.progress({ ended: 'restart' });
    expect(service.state()).toMatchObject({ updating: false, failed: '0.36.0', failedReason: null });
    service.stop();
  });
});

describe('updateAsker', () => {
  const dir = (self: string | null, names: Record<string, string> = {}) => ({
    selfId: () => self, selfName: () => 'nuc', nameOf: (id: string) => names[id] ?? null,
  });

  it('is the channel\'s peer by its name here, else by the start of its id', () => {
    expect(updateAsker('peer-1', dir('me', { 'peer-1': 'Pixel 8' }))).toEqual({ id: 'peer-1', name: 'Pixel 8' });
    expect(updateAsker('abcdefghijkl', dir('me'))).toEqual({ id: 'abcdefghijkl', name: 'abcdefgh' });
  });

  it('is this device for a request made on it, and no one on a device without an id', () => {
    expect(updateAsker(undefined, dir('me'))).toEqual({ id: 'me', name: 'nuc' });
    expect(updateAsker('', dir('me'))).toEqual({ id: 'me', name: 'nuc' });
    expect(updateAsker(['a', 'b'], dir('me'))).toEqual({ id: 'me', name: 'nuc' });
    expect(updateAsker(undefined, dir(null))).toBeNull();
  });
});

describe('/api/server/update', () => {
  async function server(backend: UpdateBackend, dataDir = makeTmpDir('update-data'), claudeDir = makeTmpDir('update-routes')) {
    mkdirSync(join(claudeDir, 'projects'), { recursive: true });
    mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
    return buildServer({
      claudeDir, dbPath: join(claudeDir, 'index.db'), dataDir, queryFn: (() => {}) as any,
      updateBackend: backend, osVersion: null,
    });
  }

  it('names who started it: this device locally, a channel\'s peer by its paired name; a restart forgets it', async () => {
    const dataDir = makeTmpDir('update-asker');
    const self = deviceId(loadOrCreateIdentity(dataDir).identity.publicKey);
    const claudeDir = makeTmpDir('update-asker-claude');
    let app = await server(fakeBackend().backend, dataDir, claudeDir);
    try {
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { remote_mac_name: 'nuc' } });
      const local = await app.inject({ method: 'POST', url: '/api/server/update' });
      expect(local.json()).toMatchObject({ updating: true, startedBy: { id: self, name: 'nuc' } });
      expect((await app.inject({ method: 'GET', url: '/api/server/update' })).json().startedBy).toEqual({ id: self, name: 'nuc' });
    } finally {
      await app.close();
    }
    expect(readMarker(join(dataDir, UPDATE_MARKER_FILE))).toMatchObject({ to: '0.36.0' });

    // Restarted on the same version: the update failed, and it names no one any more.
    app = await server(fakeBackend().backend, dataDir, claudeDir);
    try {
      const after = (await app.inject({ method: 'GET', url: '/api/server/update' })).json();
      expect(after).toMatchObject({ updating: false, failed: '0.36.0', startedBy: null });

      const db = new BetterSqlite3(join(claudeDir, 'index.db'));
      db.prepare(`INSERT INTO remote_devices (id, name, platform, paired_at, notifications) VALUES ('p1', 'Pixel 8', 'android', 1, '{}')`).run();
      db.close();
      // A body naming someone else is not read: the channel's header is who asked.
      const viaPeer = await app.inject({
        method: 'POST', url: '/api/server/update', headers: { [DEVICE_HEADER]: 'p1' }, payload: { startedBy: { id: 'x', name: 'evil' } },
      });
      expect(viaPeer.statusCode).toBe(202);
      expect(viaPeer.json().startedBy).toEqual({ id: 'p1', name: 'Pixel 8' });
    } finally {
      await app.close();
    }
  });

  it('GET answers the state; POST starts once and refuses a second', async () => {
    const { b, backend } = fakeBackend();
    const app = await server(backend);
    try {
      const got = await app.inject({ method: 'GET', url: '/api/server/update' });
      expect(got.statusCode).toBe(200);
      expect(got.json()).toEqual({
        installed: '0.35.0', candidate: '0.36.0', packaged: true, updating: false, failed: null, sessions: 0, startedBy: null,
        failedReason: null,
      });
      // A body is ignored, whatever it names.
      const started = await app.inject({ method: 'POST', url: '/api/server/update', payload: { version: '9.9.9', package: 'evil' } });
      expect(started.statusCode).toBe(202);
      expect(started.json()).toMatchObject({ updating: true });
      const again = await app.inject({ method: 'POST', url: '/api/server/update' });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({ error: 'updating' });
      expect(b.requests).toBe(1);
    } finally {
      await app.close();
    }
    expect(b.stopped).toBe(true);
  });

  it('POST answers each refusal with its status', async () => {
    for (const [over, status, error] of [
      [{ kind: 'none' }, 501, 'not_packaged'],
      [{ candidate: null }, 409, 'no_update'],
      [{ answer: 'not_set_up' }, 409, 'not_set_up'],
    ] as const) {
      const app = await server(fakeBackend(over).backend);
      try {
        const res = await app.inject({ method: 'POST', url: '/api/server/update' });
        expect(res.statusCode, error).toBe(status);
        expect(res.json()).toEqual({ error });
      } finally {
        await app.close();
      }
    }
  });

  it('needs the token like every route', async () => {
    const claudeDir = makeTmpDir('update-token');
    mkdirSync(join(claudeDir, 'projects'), { recursive: true });
    mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
    const app = await buildServer({
      claudeDir, dbPath: join(claudeDir, 'index.db'), dataDir: makeTmpDir('update-data'), queryFn: (() => {}) as any,
      apiToken: 'test-token', updateBackend: fakeBackend().backend,
    });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/server/update' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/server/update' })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
