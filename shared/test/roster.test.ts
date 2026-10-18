import { describe, expect, it } from 'vitest';
import { deviceId, generateIdentity, sign, toBase64Url, type Identity } from '../src/remote/keys.js';
import {
  ROSTER_KIND_MAX_CHARS, ROSTER_MAX_ENTRIES, ROSTER_MAX_EPOCH, ROSTER_MAX_EPOCH_STEP, RosterEntrySchema, addMember,
  describeMember, descriptionBytes, foundingEntry, isLive, membershipBytes, mergeRoster, removeMember, rosterDigest,
  verifyEntry, type RosterEntry,
} from '../src/remote/roster.js';
import { PAIR_NAME_MAX_CHARS } from '../src/remote/relayApi.js';
import { MAX_INNER_BYTES } from '../src/remote/channel.js';
import { GroupMessage, encodeInner } from '../src/remote/messages.js';

const about = { name: 'studio', os: 'macos', links: true };
const idOf = (who: Identity) => deviceId(who.publicKey);
const A = generateIdentity();
const B = generateIdentity();
const V = generateIdentity();
const M = generateIdentity();

/** `who` added by `by` at the next epoch. */
const added = (roster: RosterEntry[], who: Identity, by: Identity, kind = 'desktop', at = 10) =>
  addMember(roster, { id: idOf(who), kind, ...about }, by, at);
const one = (roster: RosterEntry[], who: Identity) => roster.find((e) => e.id === idOf(who))!;

/** An entry signed by hand, as `addMember` would never write it. */
function handSigned(who: Identity, by: Identity, kind: string, epoch: number): RosterEntry {
  const membership = { id: idOf(who), kind, epoch, addedBy: idOf(by), addedAt: 1 };
  const addedSig = toBase64Url(sign(by.secretKey, membershipBytes(membership)));
  const described = { ...membership, ...about, addedSig, describedAt: 1, describedBy: idOf(by) };
  return { ...described, describedSig: toBase64Url(sign(by.secretKey, descriptionBytes(described))) };
}

/** A group of A and B, each added by the other, and V added by A. */
function group(): RosterEntry[] {
  return added(added(added([], A, B), B, A), V, A, 'phone');
}

describe('signatures', () => {
  it('an entry a member wrote checks; a change of any field it covers breaks it', () => {
    const removed = removeMember(group(), idOf(V), A, 20);
    const entry = one(removed, V);
    expect(verifyEntry(entry)).toBe(true);
    const changes: Partial<RosterEntry>[] = [
      { kind: 'desktop' }, { epoch: 2 }, { addedBy: idOf(B) }, { addedAt: 11 },
      { name: 'other' }, { os: 'linux' }, { links: false }, { describedAt: 11 }, { describedBy: idOf(V) },
      { removedBy: idOf(B) }, { removedAt: 21 }, { id: idOf(M) },
    ];
    for (const change of changes) expect(verifyEntry({ ...entry, ...change }), JSON.stringify(change)).toBe(false);
  });

  it('a description fits only the membership it was signed under', () => {
    const v = one(group(), V);
    const other = one(added([], V, B, 'phone', 99), V);
    expect(verifyEntry({ ...v, addedSig: other.addedSig, addedBy: other.addedBy, addedAt: other.addedAt })).toBe(false);
  });

  it('no device adds itself: its founding entry is never taken from another member', () => {
    expect(addMember([], { id: idOf(V), kind: 'desktop', ...about }, V, 1)).toEqual([]);
    const founding = foundingEntry(V, 'desktop', about, 1);
    expect(verifyEntry(founding)).toBe(false);
    expect(mergeRoster([], [founding], { from: idOf(V) })).toEqual([]);
  });

  it('a founding entry is not in the digest, and any membership replaces it', () => {
    const founding = foundingEntry(V, 'phone', about, 1);
    expect(rosterDigest([founding])).toBe(rosterDigest([]));
    const merged = mergeRoster([founding], group(), { from: idOf(A), self: idOf(V) });
    expect(one(merged, V).addedBy).toBe(idOf(A));
  });
});

describe('descriptions', () => {
  it('a member that did not add a device cannot describe it, and nobody can once it described itself', () => {
    const roster = group();
    // B did not add V.
    expect(describeMember(roster, idOf(V), { ...about, name: 'mine' }, B, 30)).toBe(roster);
    const own = describeMember(roster, idOf(V), { ...about, name: 'my phone', links: true }, V, 30, 'phone');
    expect(one(own, V).describedBy).toBe(idOf(V));
    // A added V, but V described itself.
    expect(describeMember(own, idOf(V), { ...about, name: 'renamed by A' }, A, 40)).toBe(own);
  });

  it('a description forged by another member is not taken', () => {
    const roster = group();
    const v = one(roster, V);
    const forged = describeMember([{ ...v, addedBy: idOf(M) }], idOf(V), { ...about, links: false }, M, 50)[0];
    const merged = mergeRoster(roster, [{ ...forged, addedBy: v.addedBy }], { from: idOf(M), self: idOf(B) });
    expect(one(merged, V)).toEqual(v);
  });

  it('the device\'s own description wins over its adder\'s, even a later one', () => {
    const roster = group();
    const own = describeMember(roster, idOf(V), { ...about, name: 'own' }, V, 30, 'phone');
    const byAdder = describeMember(roster, idOf(V), { ...about, name: 'adder' }, A, 90);
    expect(one(mergeRoster(byAdder, own, { self: idOf(B) }), V).name).toBe('own');
    expect(one(mergeRoster(own, byAdder, { self: idOf(B) }), V).name).toBe('own');
  });

  it('a device describes itself only under a membership of its own kind', () => {
    const asDesktop = added(added([], A, B), V, A, 'desktop');
    expect(describeMember(asDesktop, idOf(V), about, V, 30, 'phone')).toBe(asDesktop);
  });
});

describe('kind', () => {
  it('a member re-signing a device\'s membership at its epoch loses to the one the device stands behind', () => {
    const roster = describeMember(group(), idOf(V), about, V, 30, 'phone');
    // M re-adds V as a desktop at V's own epoch, with a later time so its membership sorts higher.
    const v = one(roster, V);
    const raised = added([{ ...v, epoch: v.epoch - 1, addedBy: idOf(M) }], V, M, 'desktop', 999);
    expect(one(raised, V).epoch).toBe(v.epoch);
    const merged = mergeRoster(roster, raised, { from: idOf(M), self: idOf(B) });
    expect(one(merged, V).kind).toBe('phone');
    expect(one(mergeRoster(raised, roster, { from: idOf(A), self: idOf(M) }), V).kind).toBe('phone');
  });
});

describe('removal and re-adding', () => {
  it('a removal by a member is taken; one by a key no member knows is not', () => {
    const roster = group();
    const byMember = removeMember(roster, idOf(V), B, 50);
    expect(isLive(one(mergeRoster(roster, byMember, { self: idOf(A) }), V))).toBe(false);
    const stranger = generateIdentity();
    const byStranger = removeMember(roster, idOf(V), stranger, 50);
    expect(verifyEntry(one(byStranger, V))).toBe(true);
    expect(isLive(one(mergeRoster(roster, byStranger, { from: idOf(B), self: idOf(A) }), V))).toBe(true);
  });

  it('a removed device cannot re-add itself; another member can, one epoch up', () => {
    const removed = removeMember(group(), idOf(V), A, 50);
    const v = one(removed, V);
    // V signs a membership for itself at the next epoch.
    const self = handSigned(V, V, 'desktop', v.epoch + 1);
    expect(isLive(one(mergeRoster(removed, [self], { from: idOf(V), self: idOf(B) }), V))).toBe(false);
    const readded = added(removed, V, B, 'phone', 70);
    const merged = one(mergeRoster(removed, readded, { from: idOf(B), self: idOf(A) }), V);
    expect(isLive(merged)).toBe(true);
    expect(merged.epoch).toBe(v.epoch + 1);
  });

  it('an old live entry never brings a removed device back', () => {
    const live = group();
    const removed = removeMember(live, idOf(V), A, 50);
    expect(isLive(one(mergeRoster(removed, live, { self: idOf(B) }), V))).toBe(false);
    expect(isLive(one(mergeRoster(live, removed, { self: idOf(B) }), V))).toBe(false);
  });

  it('an epoch far above the one held is not taken', () => {
    const roster = group();
    let far = roster;
    for (let i = 0; i <= ROSTER_MAX_EPOCH_STEP; i++) far = added(removeMember(far, idOf(V), M, 1), V, M);
    expect(one(far, V).epoch).toBe(one(roster, V).epoch + ROSTER_MAX_EPOCH_STEP + 1);
    expect(one(mergeRoster(roster, far, { from: idOf(M), self: idOf(B) }), V)).toEqual(one(roster, V));
  });
});

describe('the epoch ceiling', () => {
  it('an entry above ROSTER_MAX_EPOCH is not taken, and addMember never writes past it', () => {
    const atCeiling = added([{ ...one(group(), V), epoch: ROSTER_MAX_EPOCH - 1 }], V, A);
    expect(one(atCeiling, V).epoch).toBe(ROSTER_MAX_EPOCH);
    expect(verifyEntry(one(atCeiling, V))).toBe(true);
    const removed = removeMember(atCeiling, idOf(V), A, 1);
    expect(added(removed, V, A)).toBe(removed);

    const past = handSigned(V, M, 'desktop', ROSTER_MAX_EPOCH + 1);
    expect(verifyEntry(past)).toBe(false);
    expect(mergeRoster([], [past], { from: idOf(M) })).toEqual([]);
  });
});

describe('the size bound', () => {
  it('a merge takes no new id past ROSTER_MAX_ENTRIES, and still updates the ids it holds', () => {
    let full: RosterEntry[] = added([], V, A, 'phone');
    while (full.length < ROSTER_MAX_ENTRIES) full = added(full, generateIdentity(), A);
    const newcomer = generateIdentity();
    const incoming = removeMember(added(full, newcomer, A), idOf(V), A, 50);
    const merged = mergeRoster(full, incoming, { from: idOf(A) });
    expect(merged).toHaveLength(ROSTER_MAX_ENTRIES);
    expect(merged.some((e) => e.id === idOf(newcomer))).toBe(false);
    expect(isLive(one(merged, V))).toBe(false);
    expect(RosterEntrySchema.array().max(ROSTER_MAX_ENTRIES).safeParse(merged).success).toBe(true);
  });
});

describe('the frame', () => {
  it('a full roster of the longest entries, every character escaped, fits one channel frame', () => {
    const escaped = (n: number) => '\u0001'.repeat(n);
    const longest: RosterEntry = {
      id: idOf(V), kind: escaped(ROSTER_KIND_MAX_CHARS), name: escaped(PAIR_NAME_MAX_CHARS), os: escaped(ROSTER_KIND_MAX_CHARS),
      links: false, epoch: Number.MAX_SAFE_INTEGER, addedBy: idOf(A), addedAt: Number.MAX_SAFE_INTEGER, addedSig: 's'.repeat(86),
      describedAt: Number.MAX_SAFE_INTEGER, describedBy: idOf(A), describedSig: 's'.repeat(86),
      removedBy: idOf(B), removedAt: Number.MAX_SAFE_INTEGER, removedSig: 's'.repeat(86),
    };
    const msg = { t: 'roster', entries: new Array(ROSTER_MAX_ENTRIES).fill(longest) };
    expect(GroupMessage.safeParse(msg).success).toBe(true);
    expect(encodeInner({ kind: 'json', value: msg }).length).toBeLessThanOrEqual(MAX_INNER_BYTES);
  });
});

describe('convergence', () => {
  it('two members that added one device at one epoch agree, whichever roster arrives first', () => {
    const byA = added(added([], A, B), V, A, 'phone', 5);
    const byB = added(added([], A, B), V, B, 'phone', 6);
    const ab = mergeRoster(byA, byB, { from: idOf(B), self: idOf(A) });
    const ba = mergeRoster(byB, byA, { from: idOf(A), self: idOf(B) });
    expect(ab).toEqual(ba);
    expect(rosterDigest(ab)).toBe(rosterDigest(ba));
  });
});

describe('describeMember', () => {
  it('leaves the roster as it is when nothing changes', () => {
    const roster = describeMember(group(), idOf(V), about, V, 30, 'phone');
    expect(describeMember(roster, idOf(V), about, V, 40, 'phone')).toBe(roster);
  });
});

describe('RosterEntrySchema', () => {
  it('holds a name, kind and os up to their bounds and no further, and an epoch only while it is a safe integer', () => {
    const entry = one(group(), V);
    const at = (over: Partial<RosterEntry>) => RosterEntrySchema.safeParse({ ...entry, ...over }).success;
    expect(at({ name: 'n'.repeat(PAIR_NAME_MAX_CHARS), kind: 'k'.repeat(ROSTER_KIND_MAX_CHARS), os: 'o'.repeat(ROSTER_KIND_MAX_CHARS) })).toBe(true);
    expect(at({ name: 'n'.repeat(PAIR_NAME_MAX_CHARS + 1) })).toBe(false);
    expect(at({ os: 'o'.repeat(ROSTER_KIND_MAX_CHARS + 1) })).toBe(false);
    expect(at({ epoch: Number.MAX_SAFE_INTEGER })).toBe(true);
    expect(at({ epoch: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    const { addedSig: _unsigned, ...unsigned } = entry;
    expect(RosterEntrySchema.safeParse(unsigned).success).toBe(false);
  });
});
