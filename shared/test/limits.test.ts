import { describe, expect, it } from 'vitest';
import {
  LIMITS_STALE_AFTER_MS, groupLimitsByAccount, isOwnLimitsEntry, limitsAccountKey, limitsReadingStale, memberLimitsEntries,
  type LimitsDir, type LimitsEntry,
} from '../src/limits.js';

type Entry = LimitsEntry & { name: string };

const entry = (over: Partial<Entry> & Pick<Entry, 'id'>): Entry => ({
  name: `dir ${over.id}`, account: null, readAt: '2026-10-20T10:00:00.000Z', stale: false, ...over,
});

const studio = { id: 'm-studio', name: 'Studio' };
const laptop = { id: 'm-laptop', name: 'Laptop' };

describe('groupLimitsByAccount', () => {
  it('puts the same e-mail in one group, across directories and members, in the order first seen', () => {
    const groups = groupLimitsByAccount([
      entry({ id: 1, account: 'me@example.com' }),
      entry({ id: 2, account: 'work@example.com' }),
      entry({ id: 1, account: 'ME@Example.com', machine: studio }),
      entry({ id: 3, account: 'me@example.com', machine: studio }),
      entry({ id: 1, account: 'me@example.com', machine: laptop }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['me@example.com', 'work@example.com']);
    const [me, work] = groups;
    expect(me.entries.map((e) => [e.machine?.id ?? 'self', e.id])).toEqual([['self', 1], ['m-studio', 1], ['m-studio', 3], ['m-laptop', 1]]);
    expect(me.machines).toEqual([studio, laptop]);
    expect(me.local).toBe(true);
    expect(work.machines).toEqual([]);
  });

  it('keeps a directory of unknown account on its own, keyed by device and directory', () => {
    const groups = groupLimitsByAccount([
      entry({ id: 1 }),
      entry({ id: 1, machine: studio }),
      entry({ id: 2, account: '  ' }),
    ]);
    expect(groups.map((g) => [g.key, g.account])).toEqual([['self:1', null], ['m-studio:1', null], ['self:2', null]]);
    expect(groups[1].local).toBe(false);
    expect(limitsAccountKey({ id: 4, machine: laptop })).toBe('m-laptop:4');
  });

  it('tells one e-mail in two organizations apart by the account id, and groups by the e-mail an older Mac sends', () => {
    const groups = groupLimitsByAccount([
      entry({ id: 1, account: 'me@example.com', accountId: 'u1:personal' }),
      entry({ id: 2, account: 'me@example.com', accountId: 'u1:company' }),
      entry({ id: 1, account: 'me@example.com', accountId: 'u1:company', machine: studio }),
      entry({ id: 1, account: 'me@example.com', machine: laptop }),
    ]);
    expect(groups.map((g) => [g.key, g.account, g.entries.length])).toEqual([
      ['u1:personal', 'me@example.com', 1], ['u1:company', 'me@example.com', 2], ['me@example.com', 'me@example.com', 1],
    ]);
  });

  it('shows the freshest reading that is not stale, a stale one only when all are, never-read last', () => {
    const old = entry({ id: 1, account: 'a@x', readAt: '2026-10-20T09:00:00.000Z' });
    const fresh = entry({ id: 2, account: 'a@x', readAt: '2026-10-20T11:00:00.000Z' });
    // An offline member's reading is marked stale: newer than both, it still loses.
    const offline = entry({ id: 1, account: 'a@x', machine: studio, readAt: '2026-10-20T12:00:00.000Z', stale: true });
    const never = entry({ id: 3, account: 'a@x', readAt: null });
    expect(groupLimitsByAccount([never, old, offline, fresh])[0].reading).toBe(fresh);
    expect(groupLimitsByAccount([never, old])[0].reading).toBe(old);
    // A stale reading still beats none at all.
    expect(groupLimitsByAccount([never, offline])[0].reading).toBe(offline);
    const offlineToo = { ...offline, readAt: '2026-10-20T08:00:00.000Z' };
    expect(groupLimitsByAccount([offlineToo, offline])[0].reading).toBe(offline);
  });
});

describe('limitsReadingStale', () => {
  it('is stale after a failed read, without a read, or once the read is older than the limit', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const readAt = (ago: number) => new Date(now - ago).toISOString();
    expect(limitsReadingStale({ readAt: readAt(60_000), stale: false }, now)).toBe(false);
    expect(limitsReadingStale({ readAt: readAt(60_000), stale: true }, now)).toBe(true);
    expect(limitsReadingStale({ readAt: null, stale: false }, now)).toBe(true);
    expect(limitsReadingStale({ readAt: readAt(LIMITS_STALE_AFTER_MS + 1), stale: false }, now)).toBe(true);
  });
});

describe('memberLimitsEntries', () => {
  const window = { kind: 'session', percent: 30, estimate: { runsOutAt: null, basis: 'window' } };
  const dir = {
    id: 1, name: 'Personal', account: ' Me@Example.com ', accountId: 'u1:o1', plan: 'max', tracked: true,
    readAt: '2026-10-20T09:00:00.000Z', stale: false, windows: [window], extraUsage: null, waits: [],
  };

  it('tags the member\'s own directories, lower-cases the e-mail, and leaves out a third device\'s and junk', () => {
    const out = memberLimitsEntries<LimitsDir>([dir, { ...dir, id: 2, machine: { id: 'c' } }, 'junk', { name: 'no id' }, null], studio, { offline: false });
    expect(out).toEqual([{ ...dir, account: 'me@example.com', machine: studio }]);
    expect(out[0].windows[0]).toBe(window);
  });

  it('marks an offline member\'s reading stale and drops its estimates', () => {
    const [out] = memberLimitsEntries<LimitsDir>([dir], studio, { offline: true });
    expect(out.stale).toBe(true);
    expect(out.windows).toEqual([{ ...window, estimate: null }]);
  });

  it('reads an older Mac\'s answer, with no account, plan or windows, as unknown', () => {
    const [out] = memberLimitsEntries<LimitsDir>([{ id: 3, readAt: null }], studio, { offline: false });
    expect(out).toEqual({
      id: 3, name: '', account: null, accountId: null, plan: null, machine: studio, tracked: true, readAt: null, stale: false,
      windows: [], extraUsage: null, waits: [],
    });
  });
});

describe('isOwnLimitsEntry', () => {
  it('is this device\'s own without a machine, another\'s with one', () => {
    expect(isOwnLimitsEntry({})).toBe(true);
    expect(isOwnLimitsEntry({ machine: null })).toBe(true);
    expect(isOwnLimitsEntry({ machine: studio })).toBe(false);
  });
});
