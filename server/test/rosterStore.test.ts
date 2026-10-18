import { describe, expect, it } from 'vitest';
import { deviceId, generateIdentity } from '@orbital/shared/remote/keys';
import { addMember, foundingEntry, removeMember, rosterDigest, verifyEntry } from '@orbital/shared/remote/roster';
import { RosterStore } from '../src/remote/rosterStore.js';
import { openTmpDb } from './tmp.js';

describe('RosterStore', () => {
  it('stores and lists a roster with its signatures, and says whether a replace changed it', () => {
    const [self, a, b] = [generateIdentity(), generateIdentity(), generateIdentity()];
    const about = { name: 'studio', os: 'macos', links: true };
    const founding = foundingEntry(self, 'desktop', about, 1);
    const roster = removeMember(
      addMember(addMember([founding], { id: deviceId(a.publicKey), kind: 'desktop', ...about }, self, 2),
        { id: deviceId(b.publicKey), kind: 'phone', ...about }, self, 3),
      deviceId(a.publicKey), self, 5,
    );
    const store = new RosterStore(openTmpDb('roster'));
    expect(store.list()).toEqual([]);
    expect(store.replace(roster)).toBe(true);
    expect(store.list()).toEqual(roster);
    expect(store.list().filter((e) => e.id !== deviceId(self.publicKey)).every(verifyEntry)).toBe(true);
    expect(store.replace(store.list())).toBe(false);
    // The founding entry is stored, though not digested: a change to it alone is still a change.
    expect(store.digest()).toBe(rosterDigest(roster.filter((e) => e.id !== deviceId(self.publicKey))));
    const renamed = roster.map((e) => (e.id === founding.id ? foundingEntry(self, 'desktop', { ...about, name: 'home' }, 9) : e));
    expect(store.replace(renamed)).toBe(true);
    expect(store.entry(deviceId(b.publicKey))?.kind).toBe('phone');
  });
});
