import { describe, expect, it } from 'vitest';
import { deviceId, generateIdentity } from '@orbital/shared/remote/keys';
import { addMember, describeMember, foundingEntry, removeMember, rosterDigest, verifyEntry } from '@orbital/shared/remote/roster';
import { RosterStore } from '../src/remote/rosterStore.js';
import { openTmpDb } from './tmp.js';

describe('RosterStore', () => {
  it('stores and lists a roster with its signatures, and says whether a replace changed it', () => {
    const [self, a, b, c] = [generateIdentity(), generateIdentity(), generateIdentity(), generateIdentity()];
    const about = { name: 'studio', os: 'macos', links: true };
    const founding = foundingEntry(self, 'desktop', about, 1);
    const withA = addMember(addMember([founding], { id: deviceId(a.publicKey), kind: 'desktop', ...about }, self, 2),
      { id: deviceId(b.publicKey), kind: 'phone', ...about }, self, 3);
    // A adds C, which describes itself, and removes B; removing A, this device endorses both.
    const byA = removeMember(describeMember(
      addMember(withA, { id: deviceId(c.publicKey), kind: 'desktop', ...about }, a, 4), deviceId(c.publicKey), about, c, 4, 'desktop',
    ), deviceId(b.publicKey), a, 4);
    const roster = removeMember(byA, deviceId(a.publicKey), self, 5);
    expect(roster.find((e) => e.id === deviceId(c.publicKey))?.endorsedBy).toBe(deviceId(self.publicKey));
    expect(roster.find((e) => e.id === deviceId(b.publicKey))?.removalEndorsedBy).toBe(deviceId(self.publicKey));
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
