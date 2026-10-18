import { describe, expect, it } from 'vitest';
import { deviceId, generateIdentity } from '@orbital/shared/remote/keys';
import {
  EMPTY_ROSTER, describeDevice, dissolveRoster, foundRoster, leftNotice, rosterDigest, takeRoster, type RosterState,
} from '@orbital/shared/remote/roster';
import { GroupExitStore, GroupMembershipStore, RosterStore } from '../src/remote/rosterStore.js';
import { openTmpDb } from './tmp.js';
import { groupExits } from '../src/db/schema.js';

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
    const joining = { group: deviceId(primary.publicKey), founding: null, version: 0, member: true };
    const taken = takeRoster(EMPTY_ROSTER, store.read(), { self: deviceId(b.publicKey), membership: joining, from: joining.group });
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
    const ended = { why: 'dissolved' as const, by: { id: 'group-b', name: 'studio' } };
    membership.set({ ...kept, ended });
    expect(membership.get()).toEqual({ ...kept, ended });
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
    exits.set({ id: 'a', state, since: 3 });
    exits.set({ id: 'a', state, since: 3 });
    expect(exits.list()).toEqual([{ id: 'a', state, since: 3 }]);
    // A row whose state does not read is still an exit: its device stays served nothing.
    db.update(groupExits).set({ state: 'not json' }).run();
    expect(exits.list()).toEqual([{ id: 'a', state: null, since: 3 }]);
    // `has` reads the ids once, from the rows another store left, and follows this one's writes.
    expect(new GroupExitStore(db).has('a')).toBe(true);
    expect([exits.has('a'), exits.has('b')]).toEqual([true, false]);
    exits.set({ id: 'b', state, since: 4 });
    expect(exits.has('b')).toBe(true);
    exits.remove('a');
    expect(exits.has('a')).toBe(false);
    exits.remove('b');
    expect(exits.list()).toEqual([]);
  });
});
