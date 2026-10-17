import { describe, expect, it } from 'vitest';
import { rosterDigest, type RosterEntry } from '@orbital/shared/remote/roster';
import { RosterStore } from '../src/remote/rosterStore.js';
import { openTmpDb } from './tmp.js';

const e = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  id, kind: 'desktop', name: id, os: 'macos', links: true, epoch: 1, addedBy: 'A', addedAt: 1, describedAt: 1, ...over,
});

describe('RosterStore', () => {
  it('stores and lists a roster, and says whether a replace changed it', () => {
    const store = new RosterStore(openTmpDb('roster'));
    expect(store.list()).toEqual([]);
    expect(store.replace([e('B'), e('A', { removedBy: 'B', removedAt: 5 })])).toBe(true);
    expect(store.list()).toEqual([e('A', { removedBy: 'B', removedAt: 5 }), e('B')]);
    expect(store.replace(store.list())).toBe(false);
    expect(store.digest()).toBe(rosterDigest(store.list()));
    expect(store.entry('B')?.name).toBe('B');
  });
});
