import { describe, expect, it } from 'vitest';
import {
  LIMITS_STALE_AFTER_MS, groupLimitsByAccount, limitsAccountKey, limitsReadingStale, type LimitsEntry,
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
