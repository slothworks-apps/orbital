import { describe, expect, it } from 'vitest';
import { deviceId, generateIdentity, sign, toBase64Url, type Identity } from '../src/remote/keys.js';
import {
  ROSTER_KIND_MAX_CHARS, ROSTER_MAX_ADDED_BY, ROSTER_MAX_ENTRIES, ROSTER_MAX_EPOCH, RosterEntrySchema, addMember,
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

  it('a signature is read only in its one canonical spelling', () => {
    const entry = one(group(), V);
    const last = entry.addedSig.at(-1)!;
    // 64 bytes in 86 characters leave spare bits in the last one; a decoder that ignores them reads another spelling.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const twin = alphabet[alphabet.indexOf(last) ^ 1];
    expect(verifyEntry({ ...entry, addedSig: entry.addedSig.slice(0, -1) + twin })).toBe(false);
    expect(verifyEntry({ ...entry, addedSig: `${entry.addedSig}=` })).toBe(false);
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
    expect(mergeRoster([], [founding])).toEqual([]);
  });

  it('a founding entry is not in the digest, and any membership replaces it', () => {
    const founding = foundingEntry(V, 'phone', about, 1);
    expect(rosterDigest([founding])).toBe(rosterDigest([]));
    const merged = mergeRoster([founding], group());
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
    const merged = mergeRoster(roster, [{ ...forged, addedBy: v.addedBy }]);
    expect(one(merged, V)).toEqual(v);
  });

  it('the device\'s own description wins over its adder\'s, even a later one', () => {
    const roster = group();
    const own = describeMember(roster, idOf(V), { ...about, name: 'own' }, V, 30, 'phone');
    const byAdder = describeMember(roster, idOf(V), { ...about, name: 'adder' }, A, 90);
    expect(one(mergeRoster(byAdder, own), V).name).toBe('own');
    expect(one(mergeRoster(own, byAdder), V).name).toBe('own');
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
    const merged = mergeRoster(roster, raised);
    expect(one(merged, V).kind).toBe('phone');
    expect(one(mergeRoster(raised, roster), V).kind).toBe('phone');
  });
});

describe('removal and re-adding', () => {
  it('a removal by a member is taken; a new membership signed by a device removed here is not', () => {
    const roster = group();
    const byMember = removeMember(roster, idOf(V), B, 50);
    expect(isLive(one(mergeRoster(roster, byMember), V))).toBe(false);
    // B is removed here; what it adds afterwards, a new id or a re-add, is refused.
    const bRemoved = removeMember(roster, idOf(B), A, 50);
    const newcomer = generateIdentity();
    expect(mergeRoster(bRemoved, added([], newcomer, B)).some((e) => e.id === idOf(newcomer))).toBe(false);
    const vRemoved = removeMember(bRemoved, idOf(V), A, 60);
    expect(isLive(one(mergeRoster(vRemoved, added(vRemoved, V, B, 'phone')), V))).toBe(false);
  });

  it('a chain of keys from a device removed here is refused, link by link', () => {
    // R was removed here; while it was live on an asleep member it added Y, and Y added Z.
    const R = generateIdentity();
    const Y = generateIdentity();
    const Z = generateIdentity();
    const withR = added(group(), R, A);
    const here = removeMember(withR, idOf(R), A, 50);
    const asleep = added(added(withR, Y, R), Z, Y);
    const merged = mergeRoster(here, asleep, { from: idOf(B), self: idOf(A) });
    expect(merged.some((e) => e.id === idOf(Y) || e.id === idOf(Z))).toBe(false);
    // Nor a removal R signs at the same epoch.
    const byR = removeMember(here, idOf(V), R, 60);
    expect(isLive(one(mergeRoster(here, byR, { from: idOf(B), self: idOf(A) }), V))).toBe(true);
  });

  it('a member that missed both "A adds D" and "A removed" takes D and the removal from one frame', () => {
    const D = generateIdentity();
    const missed = group();
    const later = removeMember(added(missed, D, A), idOf(A), B, 70);
    const merged = mergeRoster(missed, later, { from: idOf(B), self: idOf(V) });
    expect(isLive(one(merged, D))).toBe(true);
    expect(isLive(one(merged, A))).toBe(false);
  });

  it('who signed an entry need not be known to a device that holds no roster yet: joining through the newest member learns them all', () => {
    // A and B added each other; C joined through B; J joins through C and holds only its own entry.
    const C = generateIdentity();
    const J = generateIdentity();
    const full = added(added(added(added([], A, B), B, A), C, B), J, C);
    const merged = mergeRoster([foundingEntry(J, 'desktop', about, 1)], full);
    expect(merged.map((e) => e.id).sort()).toEqual([A, B, C, J].map(idOf).sort());
  });

  it('a removed device cannot re-add itself; another member can, one epoch up', () => {
    const removed = removeMember(group(), idOf(V), A, 50);
    const v = one(removed, V);
    // V signs a membership for itself at the next epoch.
    const self = handSigned(V, V, 'desktop', v.epoch + 1);
    expect(isLive(one(mergeRoster(removed, [self]), V))).toBe(false);
    const readded = added(removed, V, B, 'phone', 70);
    const merged = one(mergeRoster(removed, readded), V);
    expect(isLive(merged)).toBe(true);
    expect(merged.epoch).toBe(v.epoch + 1);
  });

  it('an old live entry never brings a removed device back', () => {
    const live = group();
    const removed = removeMember(live, idOf(V), A, 50);
    expect(isLive(one(mergeRoster(removed, live), V))).toBe(false);
    expect(isLive(one(mergeRoster(live, removed), V))).toBe(false);
  });

  it('a live device is not re-added behind its back; a member that missed its removal and re-add catches up once it described itself', () => {
    const roster = group();
    const v = one(roster, V);
    // M re-adds V, live, one epoch up, as a desktop: V never described itself under it.
    const behind = added(removeMember(roster, idOf(V), M, 1), V, M, 'desktop');
    expect(one(behind, V).epoch).toBe(v.epoch + 1);
    expect(one(mergeRoster(roster, behind), V)).toEqual(v);
    // V was removed and re-added by A; V took its new membership and described itself under it.
    const readded = added(removeMember(roster, idOf(V), A, 1), V, A, 'phone');
    const described = describeMember(readded, idOf(V), about, V, 40, 'phone');
    expect(one(mergeRoster(roster, readded), V)).toEqual(v);
    expect(one(mergeRoster(roster, described), V)).toEqual(one(described, V));
    // A removal at a higher epoch reaches it too.
    const removedAgain = removeMember(described, idOf(V), A, 50);
    expect(isLive(one(mergeRoster(roster, removedAgain), V))).toBe(false);
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
    expect(mergeRoster([], [past])).toEqual([]);
  });
});

describe('the size bound', () => {
  it('a merge takes no new id past ROSTER_MAX_ENTRIES, and still updates the ids it holds', () => {
    // Each device adds the next, so no adder reaches its quota.
    let full: RosterEntry[] = added(added([], A, B), V, A, 'phone');
    for (let by = A; full.length < ROSTER_MAX_ENTRIES;) {
      const next = generateIdentity();
      full = added(full, next, by);
      by = next;
    }
    const newcomer = generateIdentity();
    expect(added(full, newcomer, A)).toBe(full);
    const incoming = [...removeMember(full, idOf(V), A, 50), ...added([], newcomer, A)];
    const merged = mergeRoster(full, incoming);
    expect(merged).toHaveLength(ROSTER_MAX_ENTRIES);
    expect(merged.some((e) => e.id === idOf(newcomer))).toBe(false);
    expect(isLive(one(merged, V))).toBe(false);
    expect(RosterEntrySchema.array().max(ROSTER_MAX_ENTRIES).safeParse(merged).success).toBe(true);
  });
});

describe('the adder quota', () => {
  it('no device adds past ROSTER_MAX_ADDED_BY, here or in a merge', () => {
    let mine = added(added([], A, B), B, A);
    while (mine.filter((e) => e.addedBy === idOf(A)).length < ROSTER_MAX_ADDED_BY) mine = added(mine, generateIdentity(), A);
    const one_more = generateIdentity();
    expect(added(mine, one_more, A)).toBe(mine);
    // A member that held A's quota already refuses a seventeenth from A; B adds it fine.
    const extra = added([], one_more, A);
    const forged = [...mine.filter((e) => e.id !== idOf(B)), ...extra];
    expect(mergeRoster(mine, forged).some((e) => e.id === idOf(one_more))).toBe(false);
    expect(mergeRoster(mine, added(mine, one_more, B)).some((e) => e.id === idOf(one_more))).toBe(true);
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
    const ab = mergeRoster(byA, byB);
    const ba = mergeRoster(byB, byA);
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
