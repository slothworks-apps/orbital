import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import type { FederationService } from '../src/federation/service.js';
import { LimitHistory } from '../src/limits/history.js';
import { FIVE_HOUR_WINDOW_MS, SAME_WINDOW_TOLERANCE_MS } from '../src/limits/estimate.js';
import {
  LIMITS_REFRESH_INTERVAL_MS,
  LIMITS_TRAILING_READ_MS,
  backgroundReadDue,
  readEventUsage,
} from '../src/limits/logic.js';
import { LimitsService, memberDirs, type LimitsClaudeDirs } from '../src/limits/service.js';
import { DEVICE_HEADER } from '../src/remote/inject.js';
import { makeTmpDir, openTmpDb } from './tmp.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-20T08:00:00.000Z');
const RESET = T0 + FIVE_HOUR_WINDOW_MS;

// ---- Pure ----------------------------------------------------------------

describe('readEventUsage', () => {
  it('reads utilization as a fraction up to 1 and as a percent above, with the window type', () => {
    expect(readEventUsage({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.82, resetsAt: 1_792_000_000 }))
      .toEqual({ rateLimitType: 'five_hour', percent: 82, resetsAt: 1_792_000_000_000 });
    expect(readEventUsage({ status: 'allowed', rateLimitType: 'seven_day', utilization: 64 }))
      .toEqual({ rateLimitType: 'seven_day', percent: 64, resetsAt: null });
  });

  it('is nothing without a utilization or a type', () => {
    expect(readEventUsage({ status: 'allowed', rateLimitType: 'five_hour' })).toBeNull();
    expect(readEventUsage({ status: 'allowed', utilization: 0.5 })).toBeNull();
    expect(readEventUsage({ status: 'allowed', rateLimitType: 'five_hour', utilization: -1 })).toBeNull();
    expect(readEventUsage(null)).toBeNull();
  });
});

describe('backgroundReadDue', () => {
  const now = T0;
  it('reads a directory working now, or within the trailing time, once its last read is an interval old', () => {
    expect(backgroundReadDue(now, null, now)).toBe(true);
    expect(backgroundReadDue(now, now - LIMITS_REFRESH_INTERVAL_MS, now)).toBe(true);
    expect(backgroundReadDue(now, now - LIMITS_REFRESH_INTERVAL_MS + 1, now)).toBe(false);
    expect(backgroundReadDue(now - LIMITS_TRAILING_READ_MS, null, now)).toBe(true);
  });

  it('never reads a directory never seen working, or one past the trailing time', () => {
    expect(backgroundReadDue(null, null, now)).toBe(false);
    expect(backgroundReadDue(now - LIMITS_TRAILING_READ_MS - 1, null, now)).toBe(false);
  });
});

// ---- The history ---------------------------------------------------------

describe('LimitHistory', () => {
  it('keeps the readings across a restart, pruned to the window as it stands', () => {
    const dir = makeTmpDir('limit-history');
    const path = join(dir, 'index.db');
    const db = openDb(path);
    const history = new LimitHistory(db);
    history.record('me@x', 'session|5-hour window', 10, RESET, T0 + 60 * MIN);
    history.record('me@x', 'session|5-hour window', 20, RESET + SAME_WINDOW_TOLERANCE_MS, T0 + 90 * MIN);
    history.record('me@x', 'weekly_all|Weekly', 5, RESET, T0 + 90 * MIN);
    history.record('other@x', 'session|5-hour window', 70, RESET, T0 + 90 * MIN);
    expect(history.readings('me@x', 'session|5-hour window').map((r) => r.percent)).toEqual([10, 20]);
    db.$client.close();

    const again = openDb(path);
    const reopened = new LimitHistory(again);
    expect(reopened.readings('me@x', 'session|5-hour window')).toEqual([
      { percent: 10, at: T0 + 60 * MIN, resetsAt: RESET },
      { percent: 20, at: T0 + 90 * MIN, resetsAt: RESET + SAME_WINDOW_TOLERANCE_MS },
    ]);
    // A new window: the old one's readings go, the other windows and accounts stay.
    reopened.record('me@x', 'session|5-hour window', 3, RESET + FIVE_HOUR_WINDOW_MS, RESET + 10 * MIN);
    expect(reopened.readings('me@x', 'session|5-hour window').map((r) => r.percent)).toEqual([3]);
    expect(reopened.readings('me@x', 'weekly_all|Weekly')).toHaveLength(1);
    expect(reopened.readings('other@x', 'session|5-hour window')).toHaveLength(1);
    again.$client.close();
  });

  it('drops what came before a percent that fell, but not a rounding apart', () => {
    const history = new LimitHistory(openTmpDb('limit-history-drop'));
    const w = 'session|5-hour window';
    history.record('k', w, 40.4, RESET, T0 + 10 * MIN);
    history.record('k', w, 40, RESET, T0 + 15 * MIN);
    expect(history.readings('k', w)).toHaveLength(2);
    history.record('k', w, 12, RESET, T0 + 20 * MIN);
    expect(history.readings('k', w).map((r) => r.percent)).toEqual([12]);
  });
});

// ---- The service ---------------------------------------------------------

/** A fake SDK whose probe answers per `CLAUDE_CONFIG_DIR`, counting the probes. */
function probeFn(percentFor: (dir: string | undefined) => number, resetsAt = new Date(RESET).toISOString()) {
  const probed: (string | undefined)[] = [];
  const fn = (({ options }: { options: { env?: Record<string, string> } }) => {
    const dir = options.env?.CLAUDE_CONFIG_DIR;
    probed.push(dir);
    async function* gen(): AsyncGenerator<any> {}
    const g = gen() as any;
    g.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => ({
      rate_limits_available: true,
      rate_limits: { limits: [{ kind: 'session', percent: percentFor(dir), resets_at: resetsAt, severity: 'normal' }] },
    });
    return g;
  }) as any;
  return { fn, probed };
}

function service(opts: {
  db?: ReturnType<typeof openTmpDb>;
  dirs?: { id: number; name: string; account: string | null }[];
  percent?: (dir: string | undefined) => number;
  working?: () => number[];
  tracked?: boolean;
  now: { t: number };
}) {
  const db = opts.db ?? openTmpDb('limits-accounts');
  const dirs = opts.dirs ?? [{ id: 1, name: 'Personal', account: 'Me@Example.com' }, { id: 2, name: 'Spare', account: 'me@example.com' }];
  const probe = probeFn(opts.percent ?? (() => 50));
  const published: any[] = [];
  const claudeDirs: LimitsClaudeDirs = {
    list: () => dirs.map(({ id, name }) => ({ id, name })),
    envFor: (id) => ({ CLAUDE_CONFIG_DIR: `/dir${id}` }),
    dirOf: (sessionId) => Number(sessionId.split('-')[1] ?? 1),
    accountOf: (id) => dirs.find((d) => d.id === id)?.account ?? null,
  };
  const limits = new LimitsService({
    db, hub: { publish: (topic, payload) => published.push({ topic, ...payload }) }, settings: { get: () => '' },
    queryFn: probe.fn, tracked: opts.tracked ?? true, republish: () => {}, claudeDirs,
    workingDirs: opts.working, now: () => opts.now.t,
  });
  return { db, limits, probed: probe.probed, published };
}

describe('LimitsService — accounts', () => {
  it('reads two directories of one account with one probe, and both carry the account and the reading', async () => {
    const now = { t: T0 + 2 * 3_600_000 };
    const { limits, probed } = service({ now });
    await limits.refresh();
    expect(probed).toEqual(['/dir1']);
    const [a, b] = limits.snapshot().dirs;
    expect(a).toMatchObject({ id: 1, account: 'me@example.com', windows: [expect.objectContaining({ percent: 50 })] });
    expect(b).toMatchObject({ id: 2, account: 'me@example.com', readAt: a.readAt, windows: a.windows });
  });

  it('reads a directory of unknown account on its own', async () => {
    const now = { t: T0 + 2 * 3_600_000 };
    const { limits, probed } = service({
      now, dirs: [{ id: 1, name: 'A', account: null }, { id: 2, name: 'B', account: null }],
      percent: (dir) => (dir === '/dir2' ? 80 : 10),
    });
    await limits.refresh();
    expect(probed.sort()).toEqual(['/dir1', '/dir2']);
    expect(limits.snapshot().dirs.map((d) => [d.account, d.windows[0].percent])).toEqual([[null, 10], [null, 80]]);
  });

  it('puts the run-out estimate on each window, paced from readings kept across a restart', async () => {
    const db = openTmpDb('limits-estimate');
    const now = { t: T0 + 2 * 3_600_000 };
    let percent = 20;
    const first = service({ db, now, percent: () => percent });
    // 20 % at 2 h, 40 % at 2.5 h, 60 % at 3 h: 40 %/h of late, against the window's 20 %/h.
    await first.limits.refresh();
    expect(first.limits.snapshot().dirs[0].windows[0].estimate).toEqual({ runsOutAt: null, basis: 'window' });
    for (const step of [1, 2]) {
      now.t += 30 * MIN;
      percent = 20 + 20 * step;
      await first.limits.refresh();
    }
    first.limits.dispose();

    const second = service({ db, now, percent: () => percent });
    await second.limits.refresh();
    // 40 points left at 40 %/h: an hour from now.
    expect(second.limits.snapshot().dirs[0].windows[0].estimate)
      .toEqual({ runsOutAt: new Date(now.t + 3_600_000).toISOString(), basis: 'recent' });
  });

  it('keeps a rate-limit event\'s use as a reading of its window, and reads again', async () => {
    const now = { t: T0 + 2 * 3_600_000 };
    const { db, limits, probed } = service({ now });
    await limits.refresh();
    now.t += MIN;
    limits.rateLimitEvent('s-2', { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.505, resetsAt: RESET / 1000 });
    await limits.refresh();
    expect(probed).toEqual(['/dir1', '/dir2']);
    const kept = new LimitHistory(db).readings('me@example.com', 'session|5-hour window');
    expect(kept.map((r) => r.percent)).toEqual([50, 50.5, 50]);
  });

  it('reads in the background while a directory works and a while after, never without plan limits', async () => {
    const now = { t: T0 };
    let working: number[] = [1];
    const { limits, probed } = service({ now, working: () => working, dirs: [{ id: 1, name: 'A', account: 'a@x' }, { id: 2, name: 'B', account: 'b@x' }] });
    limits.backgroundTick();
    await limits.refresh(1);
    expect(probed).toEqual(['/dir1']);
    now.t += MIN;
    limits.backgroundTick();
    expect(probed).toHaveLength(1);
    // Stopped: read once more within the trailing time, then not at all.
    working = [];
    now.t += LIMITS_REFRESH_INTERVAL_MS;
    limits.backgroundTick();
    await limits.refresh(1);
    expect(probed).toEqual(['/dir1', '/dir1']);
    now.t += LIMITS_TRAILING_READ_MS;
    limits.backgroundTick();
    expect(probed).toHaveLength(2);

    const keyed = service({ now, working: () => [1], tracked: false });
    keyed.limits.backgroundTick();
    expect(keyed.probed).toEqual([]);
  });
});

describe('LimitsService — the other members', () => {
  const studio = { id: 'm-studio', name: 'Studio', kind: 'desktop', os: 'macos', online: true, asOf: null };
  const memberDir = {
    id: 1, name: 'Personal', account: 'Me@Example.com', tracked: true, readAt: '2026-10-20T09:00:00.000Z', stale: false,
    windows: [{ kind: 'session', label: '5-hour window', percent: 30, resetsAt: null, severity: 'normal', estimate: { runsOutAt: null, basis: 'window' } }],
    extraUsage: null, waits: [],
  };

  it('merges every member\'s directories after its own, tagged, unless asked for its own', () => {
    const now = { t: T0 };
    const { limits } = service({ now });
    limits.members = { limits: () => [{ machine: studio, dirs: [memberDir] }], refreshLimits: async () => {} };
    const merged = limits.snapshot().dirs;
    expect(merged.map((d) => [d.machine?.id ?? 'self', d.id])).toEqual([['self', 1], ['self', 2], ['m-studio', 1]]);
    expect(merged[2]).toMatchObject({ account: 'me@example.com', stale: false, windows: memberDir.windows });
    expect(limits.snapshot(true).dirs.every((d) => d.machine === undefined)).toBe(true);
  });

  it('shows an offline member stale and without estimates, and leaves out what it carries of a third device', () => {
    const offline = { ...studio, online: false, asOf: T0 };
    const dirs = memberDirs({ machine: offline, dirs: [memberDir, { ...memberDir, id: 2, machine: { id: 'c' } }, 'junk', { name: 'no id' }] });
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatchObject({ stale: true, machine: offline });
    expect(dirs[0].windows[0].estimate).toBeNull();
    // An older Mac's answer, with no account at all.
    const { account: _, ...older } = memberDir;
    expect(memberDirs({ machine: studio, dirs: [older] })[0].account).toBeNull();
  });
});

describe('limits routes — the device group', () => {
  it('answers this device\'s own directories to a request that came over a channel, the members\' too otherwise', async () => {
    const dir = makeTmpDir('limits-group');
    let federation: FederationService | undefined;
    const queryFn = (() => {
      async function* gen(): AsyncGenerator<any> {}
      const g = gen() as any;
      g.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => ({ rate_limits_available: true, rate_limits: { limits: [] } });
      return g;
    }) as any;
    const server = await buildServer({
      dbPath: join(dir, 'index.db'), claudeDir: dir, dataDir: dir, queryFn,
      exposeFederation: (f) => { federation = f; },
    });
    const studio = { id: 'm-studio', name: 'Studio', kind: 'desktop', os: 'macos', online: true, asOf: null };
    let refreshed = 0;
    federation!.limits = () => [{ machine: studio, dirs: [{ id: 1, name: 'Personal', account: 'a@x', readAt: null, stale: false, windows: [], waits: [] }] }];
    federation!.refreshLimits = async () => { refreshed++; };

    const merged = (await server.inject({ method: 'GET', url: '/api/limits' })).json();
    expect(merged.dirs.map((d: any) => d.machine?.id ?? 'self')).toEqual(['self', 'm-studio']);
    expect(merged.dirs[0]).toHaveProperty('account');
    const own = (await server.inject({ method: 'GET', url: '/api/limits', headers: { [DEVICE_HEADER]: 'm-studio' } })).json();
    expect(own.dirs.map((d: any) => d.machine?.id ?? 'self')).toEqual(['self']);

    const ownRead = (await server.inject({ method: 'POST', url: '/api/limits/refresh', headers: { [DEVICE_HEADER]: 'm-studio' } })).json();
    expect(ownRead.dirs).toHaveLength(1);
    expect(refreshed).toBe(0);
    await server.inject({ method: 'POST', url: '/api/limits/refresh' });
    expect(refreshed).toBe(1);
    await server.close();
  });
});
