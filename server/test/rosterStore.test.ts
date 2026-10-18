import { describe, expect, it } from 'vitest';
import { deviceId, generateIdentity } from '@orbital/shared/remote/keys';
import {
  EMPTY_ROSTER, describeDevice, dissolveRoster, foundRoster, leftNotice, rosterDigest, takeRoster, type RosterState,
} from '@orbital/shared/remote/roster';
import { GroupExitStore, GroupMembershipStore, RosterStore } from '../src/remote/rosterStore.js';
import { openTmpDb } from './tmp.js';

describe('RosterStore', () => {
  it('stores the document, the descriptions and the left notices, signatures included, and says whether a replace changed it', () => {
    const [primary, a, b] = [generateIdentity(), generateIdentity(), generateIdentity()];
    const about = { name: 'studio', os: 'macos', links: true };
    const doc = foundRoster(primary, 'desktop', [{ id: deviceId(a.publicKey), kind: 'desktop' }, { id: deviceId(b.publicKey), kind: 'phone' }], 1)!;
    const state: RosterState = {
      roster: doc,
      descriptions: [
        describeDevice(deviceId(primary.publicKey), about, primary, 1),
        describeDevice(deviceId(a.publicKey), { ...about, name: 'a' }, a, 2),
        describeDevice(deviceId(b.publicKey), { ...about, links: false }, primary, 1),
      ],
      left: [leftNotice(a, doc, 3)],
    };
    const store = new RosterStore(openTmpDb('roster'));
    expect(store.read()).toEqual(EMPTY_ROSTER);
    expect(store.replace(state)).toBe(true);
    expect(store.replace(store.read())).toBe(false);
    expect(store.digest()).toBe(rosterDigest(state));
    // What comes back verifies as it went in: another member takes all of it.
    const taken = takeRoster(EMPTY_ROSTER, store.read(), { self: deviceId(b.publicKey), membership: null, paired: () => true });
    expect(rosterDigest(taken)).toBe(rosterDigest(state));
    // A dissolved document reads back as one.
    expect(store.replace({ roster: dissolveRoster(doc, primary)!, descriptions: [], left: [] })).toBe(true);
    expect(store.read().roster).toMatchObject({ dissolved: true, version: 2 });
    expect(store.replace(EMPTY_ROSTER)).toBe(true);
    expect(store.read()).toEqual(EMPTY_ROSTER);
  });

  it('keeps the membership and the pending exits apart from the document, across a dropped roster', () => {
    const db = openTmpDb('membership');
    const membership = new GroupMembershipStore(db);
    expect(membership.get()).toBeNull();
    membership.set({ group: 'group-a', founding: null, version: 0, member: true, left: { founding: 'f0', version: 4 } });
    const kept = { group: 'group-b', founding: 'f1', version: 7, member: false };
    membership.set(kept);
    expect(membership.get()).toEqual(kept);
    membership.set({ ...kept, member: true, left: { founding: 'f0', version: 4 } });
    expect(membership.get()?.left).toEqual({ founding: 'f0', version: 4 });
    new RosterStore(db).replace(EMPTY_ROSTER);
    expect(membership.get()?.group).toBe('group-b');
    membership.set(null);
    expect(membership.get()).toBeNull();
    const exits = new GroupExitStore(db);
    const state = { roster: null, descriptions: [], left: [] };
    exits.set({ id: 'a', state });
    exits.set({ id: 'a', state });
    expect(exits.list()).toEqual([{ id: 'a', state }]);
    exits.remove('a');
    expect(exits.list()).toEqual([]);
  });
});
