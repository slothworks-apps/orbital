import { describe, expect, it } from 'vitest';
import { deviceId, generateIdentity } from '@orbital/shared/remote/keys';
import {
  EMPTY_ROSTER, describeDevice, dissolveRoster, foundRoster, leftNotice, rosterDigest, takeRoster, type RosterState,
} from '@orbital/shared/remote/roster';
import { RosterStore } from '../src/remote/rosterStore.js';
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
    const taken = takeRoster(EMPTY_ROSTER, store.read(), { self: deviceId(b.publicKey), alone: true, paired: () => true });
    expect(rosterDigest(taken)).toBe(rosterDigest(state));
    // A dissolved document reads back as one.
    expect(store.replace({ roster: dissolveRoster(doc, primary)!, descriptions: [], left: [] })).toBe(true);
    expect(store.read().roster).toMatchObject({ dissolved: true, version: 2 });
    expect(store.replace(EMPTY_ROSTER)).toBe(true);
    expect(store.read()).toEqual(EMPTY_ROSTER);
  });
});
