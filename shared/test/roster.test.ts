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
const C = generateIdentity();
const V = generateIdentity();
const M = generateIdentity();

/** `who` added by `by` at the next epoch, as `by` signs it from `roster`. */
const added = (roster: RosterEntry[], who: Identity, by: Identity, kind = 'desktop', at = 10) =>
  addMember(roster, { id: idOf(who), kind, ...about }, by, at);
/** `who` describes itself, as a device of this release does once it holds its entry. */
const own = (roster: RosterEntry[], who: Identity, kind = 'desktop') => describeMember(roster, idOf(who), about, who, 30, kind);
const removed = (roster: RosterEntry[], who: Identity, by: Identity, at = 50) => removeMember(roster, idOf(who), by, at);
const one = (roster: RosterEntry[], who: Identity) => roster.find((e) => e.id === idOf(who))!;
const has = (roster: RosterEntry[], who: Identity) => roster.some((e) => e.id === idOf(who));
const ids = (roster: RosterEntry[]) => roster.map((e) => e.id).sort();
/** What `self` holds once `incoming` arrives. */
const at = (self: Identity, local: RosterEntry[], incoming: RosterEntry[]) => mergeRoster(local, incoming, { self: idOf(self) });

/** An entry signed by hand, as `addMember` would never write it. */
function handSigned(who: Identity, by: Identity, kind: string, epoch: number, addedEpoch = 0, addedAt = 1): RosterEntry {
  const membership = { id: idOf(who), kind, epoch, addedBy: idOf(by), addedEpoch, addedAt };
  const addedSig = toBase64Url(sign(by.secretKey, membershipBytes(membership)));
  const described = { ...membership, ...about, addedSig, describedAt: 1, describedBy: idOf(by) };
  return { ...described, describedSig: toBase64Url(sign(by.secretKey, descriptionBytes(described))) };
}

/** A and B, each added by the other. */
function pair(): RosterEntry[] {
  return own(own(added(added([], A, B), B, A), A), B);
}

/** A group of A and B, each added by the other, and V added by A. */
function group(): RosterEntry[] {
  return added(pair(), V, A, 'phone');
}

describe('signatures', () => {
  it('an entry a member wrote checks; a change of any field it covers breaks it', () => {
    const roster = removed(own(group(), V, 'phone'), V, A, 20);
    const entry = one(roster, V);
    expect(verifyEntry(entry)).toBe(true);
    const changes: Partial<RosterEntry>[] = [
      { kind: 'desktop' }, { epoch: 2 }, { addedBy: idOf(B) }, { addedEpoch: 7 }, { addedAt: 11 },
      { name: 'other' }, { os: 'linux' }, { links: false }, { describedAt: 11 }, { describedBy: idOf(A) },
      { removedBy: idOf(B) }, { removerEpoch: 7 }, { removedAt: 21 }, { id: idOf(M) },
    ];
    for (const change of changes) expect(verifyEntry({ ...entry, ...change }), JSON.stringify(change)).toBe(false);
  });

  it('an endorsement covers the write it names and its endorser\'s epoch, and is never the signer\'s own', () => {
    const D = generateIdentity();
    const roster = removed(own(added(pair(), D, A), D), A, B);
    const d = one(roster, D);
    expect(d.endorsedBy).toBe(idOf(B));
    expect(verifyEntry(d)).toBe(true);
    expect(verifyEntry({ ...d, endorsedEpoch: d.endorsedEpoch! + 1 })).toBe(false);
    expect(verifyEntry({ ...d, endorsedBy: idOf(A) })).toBe(false);
    const { endorsedSig: _half, ...partial } = d;
    expect(verifyEntry(partial)).toBe(false);
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
    expect(at(A, [], [founding])).toEqual([]);
  });

  it('a founding entry is not in the digest, and any membership replaces it', () => {
    const founding = foundingEntry(V, 'phone', about, 1);
    expect(rosterDigest([founding])).toBe(rosterDigest([]));
    expect(one(at(V, [founding], group()), V).addedBy).toBe(idOf(A));
  });
});

describe('descriptions', () => {
  it('a member that did not add a device cannot describe it, and nobody can once it described itself', () => {
    const roster = group();
    expect(describeMember(roster, idOf(V), { ...about, name: 'mine' }, B, 30)).toBe(roster);
    const described = describeMember(roster, idOf(V), { ...about, name: 'my phone' }, V, 30, 'phone');
    expect(one(described, V).describedBy).toBe(idOf(V));
    expect(describeMember(described, idOf(V), { ...about, name: 'renamed by A' }, A, 40)).toBe(described);
  });

  it('a description forged by another member is not taken', () => {
    const roster = group();
    const v = one(roster, V);
    const forged = describeMember([{ ...v, addedBy: idOf(M) }], idOf(V), { ...about, links: false }, M, 50)[0];
    expect(one(at(A, roster, [{ ...forged, addedBy: v.addedBy }]), V)).toEqual(v);
  });

  it('the device\'s own description wins over its adder\'s, even a later one', () => {
    const roster = group();
    const described = describeMember(roster, idOf(V), { ...about, name: 'own' }, V, 30, 'phone');
    const byAdder = describeMember(roster, idOf(V), { ...about, name: 'adder' }, A, 90);
    expect(one(at(B, byAdder, described), V).name).toBe('own');
    expect(one(at(B, described, byAdder), V).name).toBe('own');
  });

  it('a device describes itself only under a membership of its own kind', () => {
    const asDesktop = added(pair(), V, A, 'desktop');
    expect(describeMember(asDesktop, idOf(V), about, V, 30, 'phone')).toBe(asDesktop);
  });
});

describe('joining', () => {
  // A and B added each other, C joined through B, J joins through C.
  const J = generateIdentity();
  const P = generateIdentity();
  const theirs = () => added(own(added(pair(), C, B), C), J, C);

  it('a device that holds only its founding entry learns everyone from the member it joined through', () => {
    const merged = at(J, [foundingEntry(J, 'desktop', about, 1)], theirs());
    expect(ids(merged)).toEqual([A, B, C, J].map(idOf).sort());
  });

  it('a phone it added while alone comes along, and every member takes it', () => {
    const alone = added([foundingEntry(J, 'desktop', about, 1)], P, J, 'phone');
    const merged = at(J, alone, theirs());
    expect(ids(merged)).toEqual([A, B, C, J, P].map(idOf).sort());
    expect(has(at(C, theirs(), merged), P)).toBe(true);
    expect(has(at(A, at(B, pair(), theirs()), at(C, theirs(), merged)), P)).toBe(true);
  });

  it('a device that holds only removed entries learns everyone too', () => {
    const alone = removed(added([foundingEntry(J, 'desktop', about, 1)], P, J, 'phone'), P, J);
    const merged = at(J, alone, theirs());
    expect(merged.filter(isLive).map((e) => e.id).sort()).toEqual([A, B, C, J].map(idOf).sort());
    expect(isLive(one(merged, P))).toBe(false);
  });
});

describe('a removal freezes what the removed device signed', () => {
  it('a member that missed "A adds D" and "A removed" takes D (endorsed) and the removal from one frame, in either order', () => {
    const D = generateIdentity();
    const E = generateIdentity();
    const missed = own(added(pair(), C, B), C);
    // D described itself; E (a device that never signs) did not.
    const full = added(own(added(missed, D, A), D), E, A, 'phone');
    const later = removed(full, A, B);
    expect(one(later, D).endorsedBy).toBe(idOf(B));
    expect(one(later, E).endorsedBy).toBeUndefined();
    for (const frame of [later, [...later].reverse()]) {
      const merged = at(C, missed, frame);
      expect(isLive(one(merged, D))).toBe(true);
      expect(isLive(one(merged, A))).toBe(false);
      // What A added and nobody stood behind falls with A, here and at a member that held it.
      expect(has(merged, E)).toBe(false);
    }
    expect(has(at(C, full, later), E)).toBe(false);
  });

  it('a chain a removed device started through an asleep member is pruned there, and taken nowhere, once the removal is known', () => {
    const R = generateIdentity();
    const Y = generateIdentity();
    const Z = generateIdentity();
    const asleep = own(added(own(added(pair(), C, B), C), R, A), R);
    // R, live for C, adds Y; Y adds Z. C takes them.
    const fromR = own(added(own(added(asleep, Y, R), Y), Z, Y), Z);
    const atC = at(C, asleep, fromR);
    expect(has(atC, Y) && has(atC, Z)).toBe(true);
    // B removes R, never having seen Y or Z.
    const atB = removed(asleep, R, B);
    const learned = at(C, atC, atB);
    expect(has(learned, Y) || has(learned, Z)).toBe(false);
    expect(isLive(one(learned, R))).toBe(false);
    expect(has(at(B, atB, atC), Y) || has(at(B, atB, atC), Z)).toBe(false);
    // Both at once, at a member that saw neither.
    expect(has(at(A, asleep, [...atB, one(atC, Y), one(atC, Z)]), Y)).toBe(false);
  });

  it('removals a removed device signs at its epoch do not stand where its removal is known; an asleep member that acted on them recovers', () => {
    const R = generateIdentity();
    const base = own(added(own(own(added(added(pair(), C, B), V, A), V), C), R, A), R);
    // R removes A and V; C, asleep, takes it.
    const byR = removed(removed(base, A, R), V, R);
    const atC = at(C, base, byR);
    expect(isLive(one(atC, A)) || isLive(one(atC, V))).toBe(false);
    const atB = removed(base, R, B);
    // Where R's removal is known, nobody leaves.
    const known = at(B, atB, byR);
    expect([A, B, C, V].every((x) => isLive(one(known, x)))).toBe(true);
    // C learns it and has A and V back.
    const learned = at(C, atC, atB);
    expect([A, B, C, V].every((x) => isLive(one(learned, x)))).toBe(true);
    expect(isLive(one(learned, R))).toBe(false);
  });

  it('a removed device that removes the adder its remover depends on: the removal of it stands, the adder stays', () => {
    // W was added by V (V by A): W's standing hangs on V being live. R removes V; W removes R.
    const R = generateIdentity();
    const W = generateIdentity();
    const base = own(added(own(added(own(added(added(pair(), C, B), V, A), V), W, V), W), R, A), R);
    const byR = removed(base, V, R);
    const byW = removed(base, R, W);
    for (const [local, incoming] of [[byR, byW], [byW, byR]]) {
      const merged = at(C, at(C, base, local), incoming);
      expect(isLive(one(merged, R))).toBe(false);
      expect(isLive(one(merged, V)) && isLive(one(merged, W))).toBe(true);
    }
  });

  it('a removed device that removes its own remover takes it down too, with what the remover added; adding the remover again keeps the removed device out', () => {
    // The two removals cannot be told apart: each names the other's epoch. Both stand.
    const R = generateIdentity();
    const V2 = generateIdentity();
    const base = own(added(own(added(own(added(pair(), C, B), C), V2, A), V2), R, A), R);
    const merged = at(A, removed(base, B, R), removed(base, R, B));
    expect(isLive(one(merged, R)) || isLive(one(merged, B))).toBe(false);
    expect(isLive(one(merged, A)) && isLive(one(merged, V2))).toBe(true);
    // R endorsed nothing B signed: C, added by B, falls with it.
    expect(has(merged, C)).toBe(false);
    const back = added(merged, B, A);
    const stillOut = at(V2, at(V2, base, removed(base, B, R)), back);
    expect(isLive(one(stillOut, B))).toBe(true);
    expect(isLive(one(stillOut, R))).toBe(false);
  });

  it('a same-epoch membership a removed device signs for a shipped phone, with a kind that sorts higher, does not replace the real one', () => {
    const R = generateIdentity();
    const D = generateIdentity();
    const base = added(own(added(own(added(pair(), C, B), C), R, A), R), D, A, 'phone');
    const r = one(base, R);
    const d = one(base, D);
    const forged = handSigned(D, R, 'zzz', d.epoch, r.epoch, 999);
    const atB = removed(base, R, B);
    expect(one(at(B, atB, [forged]), D)).toEqual(d);
    // C, asleep, takes it while R is live for it, and has the real one back once it learns of the removal.
    const atC = at(C, base, [forged]);
    expect(one(atC, D).kind).toBe('zzz');
    expect(one(at(C, atC, atB), D)).toEqual(d);
  });

  it('a removed key that filled the roster through an asleep member frees it once the removal is known', () => {
    const R = generateIdentity();
    const asleep = own(added(own(added(pair(), C, B), C), R, A), R);
    // R adds sixteen keys, each of which adds sixteen more.
    const rEntry = one(asleep, R);
    const tree: RosterEntry[] = [];
    for (let i = 0; i < ROSTER_MAX_ADDED_BY; i++) {
      const Y = generateIdentity();
      const y = one(added([rEntry], Y, R), Y);
      tree.push(y);
      for (let k = 0; k < ROSTER_MAX_ADDED_BY; k++) {
        const Z = generateIdentity();
        tree.push(one(added([y], Z, Y), Z));
      }
    }
    const atC = at(C, asleep, [...asleep, ...tree]);
    expect(atC.length).toBe(ROSTER_MAX_ENTRIES);
    const learned = at(C, atC, removed(asleep, R, B));
    expect(ids(learned)).toEqual([A, B, C, R].map(idOf).sort());
  });

  it('of the adds a second key signed before its removal, only those its remover endorsed stand; none it signed after', () => {
    const T = generateIdentity();
    const Y = generateIdentity();
    const kept = generateIdentity();
    const silent = generateIdentity();
    const late = generateIdentity();
    const base = own(added(own(added(pair(), T, A), T), Y, T), Y);
    const byY = added(own(added(base, kept, Y), kept), silent, Y, 'phone');
    const atB = removed(byY, Y, B);
    const after = one(added(atB, late, Y), late);
    const merged = at(A, byY, [...atB, after]);
    expect(has(merged, kept)).toBe(true);
    expect(has(merged, silent) || has(merged, late)).toBe(false);
  });

  it('a device added again does not bring back what it signed at its old epoch after its removal', () => {
    const X = generateIdentity();
    const before = generateIdentity();
    const N = generateIdentity();
    const base = own(added(own(added(pair(), X, A), X), before, X), before);
    const atB = removed(base, X, B);
    const signedAfter = one(added(atB, N, X), N);
    const back = added(atB, X, A);
    const merged = at(B, back, [signedAfter]);
    expect(has(merged, N)).toBe(false);
    expect(has(merged, before)).toBe(true);
    expect(isLive(one(merged, X))).toBe(true);
  });
});

describe('what members do every day', () => {
  it('a removed device comes back one epoch up through another member, never by itself', () => {
    const roster = removed(group(), V, A);
    const v = one(roster, V);
    expect(isLive(one(at(B, roster, [handSigned(V, V, 'desktop', v.epoch + 1)]), V))).toBe(false);
    const merged = one(at(B, roster, added(roster, V, B, 'phone', 70)), V);
    expect(isLive(merged)).toBe(true);
    expect(merged.epoch).toBe(v.epoch + 1);
  });

  it('an old live entry never brings a removed device back', () => {
    const live = group();
    const gone = removed(live, V, A);
    expect(isLive(one(at(B, gone, live), V))).toBe(false);
    expect(isLive(one(at(B, live, gone), V))).toBe(false);
  });

  it('a live device is not re-added behind its back; a member that missed several epochs catches up once it described itself', () => {
    const roster = own(group(), V, 'phone');
    const v = one(roster, V);
    const behind = added(roster, V, B, 'desktop');
    expect(one(at(A, roster, behind), V)).toEqual(v);
    let moved = roster;
    for (let i = 0; i < 3; i++) moved = added(removed(moved, V, i % 2 ? A : B), V, i % 2 ? B : A, 'phone');
    const described = own(moved, V, 'phone');
    expect(one(at(A, roster, moved), V)).toEqual(v);
    expect(one(at(A, roster, described), V)).toEqual(one(described, V));
    expect(isLive(one(at(A, roster, removed(described, V, A)), V))).toBe(false);
  });

  it('a device that leaves keeps what it added in the group, and joins another group alone', () => {
    const K1 = generateIdentity();
    const K2 = generateIdentity();
    const base = own(added(own(added(pair(), C, B), C), V, B), V);
    const left = removed(base, B, B);
    const atA = at(A, base, left);
    expect(isLive(one(atA, B))).toBe(false);
    expect(isLive(one(atA, C)) && isLive(one(atA, V))).toBe(true);
    const other = added(added(added([], K1, K2), K2, K1), B, K1);
    expect(ids(at(B, [foundingEntry(B, 'desktop', about, 1)], other))).toEqual([B, K1, K2].map(idOf).sort());
    // Added again, what it added before it left still stands.
    const back = added(atA, B, A);
    const atC = at(C, base, back);
    expect([B, C, V].every((x) => isLive(one(atC, x)))).toBe(true);
  });

  it('a member that removes the device that added it stays in the group, and when it adds that device again', () => {
    const base = own(added(pair(), C, B), C);
    const atC = removed(base, B, C);
    const atA = at(A, base, atC);
    expect(isLive(one(atA, C))).toBe(true);
    expect(isLive(one(atA, B))).toBe(false);
    const back = at(A, atA, added(atC, B, C));
    expect(isLive(one(back, C)) && isLive(one(back, B))).toBe(true);
  });

  it('a shipped phone added at its hello stands everywhere, described by its adder', () => {
    const P = generateIdentity();
    const roster = added(group(), P, B, 'phone');
    expect(one(at(C, at(C, [], added(roster, C, A)), roster), P).describedBy).toBe(idOf(B));
  });

  it('two members that added one device at one epoch agree, whichever roster arrives first', () => {
    const byA = added(pair(), V, A, 'phone', 5);
    const byB = added(pair(), V, B, 'phone', 6);
    expect(at(C, byA, byB)).toEqual(at(C, byB, byA));
    expect(rosterDigest(at(C, byA, byB))).toBe(rosterDigest(at(C, byB, byA)));
  });
});

describe('the epoch ceiling', () => {
  it('an entry above ROSTER_MAX_EPOCH is not taken, and addMember never writes past it', () => {
    const atCeiling = added([...pair(), { ...one(group(), V), epoch: ROSTER_MAX_EPOCH - 1 }], V, A);
    expect(one(atCeiling, V).epoch).toBe(ROSTER_MAX_EPOCH);
    expect(verifyEntry(one(atCeiling, V))).toBe(true);
    const gone = removed(atCeiling, V, A);
    expect(added(gone, V, A)).toBe(gone);
    const past = handSigned(V, M, 'desktop', ROSTER_MAX_EPOCH + 1);
    expect(verifyEntry(past)).toBe(false);
    expect(at(A, [], [past])).toEqual([]);
  });
});

describe('the bounds', () => {
  it('a merge keeps no more than ROSTER_MAX_ENTRIES, and still updates the ids it holds', () => {
    // Each device adds the next, so no adder reaches its quota.
    let full = group();
    for (let by = A; full.length < ROSTER_MAX_ENTRIES;) {
      const next = generateIdentity();
      full = added(full, next, by);
      by = next;
    }
    const newcomer = generateIdentity();
    expect(added(full, newcomer, A)).toBe(full);
    const incoming = [...removed(full, V, A), one(added(pair(), newcomer, A), newcomer)];
    const merged = at(B, full, incoming);
    expect(merged).toHaveLength(ROSTER_MAX_ENTRIES);
    expect(has(merged, newcomer)).toBe(false);
    expect(isLive(one(merged, V))).toBe(false);
  });

  it('one signer adds at most ROSTER_MAX_ADDED_BY devices at one of its epochs, here and in a merge', () => {
    let mine = pair();
    while (mine.filter((e) => e.addedBy === idOf(A)).length < ROSTER_MAX_ADDED_BY) mine = added(mine, generateIdentity(), A);
    const extra = generateIdentity();
    expect(added(mine, extra, A)).toBe(mine);
    const forged = one(added(mine.filter((e) => e.addedBy !== idOf(A) || e.id === idOf(B)), extra, A), extra);
    expect(at(B, mine, [forged]).filter((e) => e.addedBy === idOf(A))).toHaveLength(ROSTER_MAX_ADDED_BY);
    expect(has(at(B, mine, added(mine, extra, B)), extra)).toBe(true);
  });

  it('one signer removes at most ROSTER_MAX_ADDED_BY devices at one of its epochs', () => {
    let roster = pair();
    for (let i = 0; i <= ROSTER_MAX_ADDED_BY; i++) roster = added(roster, generateIdentity(), i % 2 ? A : B);
    const targets = roster.filter((e) => e.id !== idOf(A) && e.id !== idOf(B));
    let gone = roster;
    for (const t of targets) gone = removeMember(gone, t.id, A, 50);
    expect(gone.filter((e) => e.removedBy === idOf(A))).toHaveLength(ROSTER_MAX_ADDED_BY);
  });
});

describe('the frame', () => {
  it('a full roster of the longest entries, both endorsements present and every character escaped, fits one channel frame', () => {
    const escaped = (n: number) => '\u0001'.repeat(n);
    const big = Number.MAX_SAFE_INTEGER;
    const longest: RosterEntry = {
      id: idOf(V), kind: escaped(ROSTER_KIND_MAX_CHARS), name: escaped(PAIR_NAME_MAX_CHARS), os: escaped(ROSTER_KIND_MAX_CHARS),
      links: false, epoch: big, addedBy: idOf(A), addedEpoch: big, addedAt: big, addedSig: 's'.repeat(86),
      endorsedBy: idOf(B), endorsedEpoch: big, endorsedSig: 's'.repeat(86),
      describedAt: big, describedBy: idOf(A), describedSig: 's'.repeat(86),
      removedBy: idOf(B), removerEpoch: big, removedAt: big, removedSig: 's'.repeat(86),
      removalEndorsedBy: idOf(C), removalEndorsedEpoch: big, removalEndorsedSig: 's'.repeat(86),
    };
    const msg = { t: 'roster', entries: new Array(ROSTER_MAX_ENTRIES).fill(longest) };
    expect(GroupMessage.safeParse(msg).success).toBe(true);
    expect(encodeInner({ kind: 'json', value: msg }).length).toBeLessThanOrEqual(MAX_INNER_BYTES);
  });
});

describe('describeMember', () => {
  it('leaves the roster as it is when nothing changes', () => {
    const roster = own(group(), V, 'phone');
    expect(own(roster, V, 'phone')).toBe(roster);
  });
});

describe('RosterEntrySchema', () => {
  it('holds a name, kind and os up to their bounds and no further, and an epoch only while it is a safe integer', () => {
    const entry = one(group(), V);
    const fits = (over: Partial<RosterEntry>) => RosterEntrySchema.safeParse({ ...entry, ...over }).success;
    expect(fits({ name: 'n'.repeat(PAIR_NAME_MAX_CHARS), kind: 'k'.repeat(ROSTER_KIND_MAX_CHARS), os: 'o'.repeat(ROSTER_KIND_MAX_CHARS) })).toBe(true);
    expect(fits({ name: 'n'.repeat(PAIR_NAME_MAX_CHARS + 1) })).toBe(false);
    expect(fits({ os: 'o'.repeat(ROSTER_KIND_MAX_CHARS + 1) })).toBe(false);
    expect(fits({ epoch: Number.MAX_SAFE_INTEGER })).toBe(true);
    expect(fits({ epoch: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    const { addedEpoch: _unsigned, ...older } = entry;
    expect(RosterEntrySchema.safeParse(older).success).toBe(false);
  });
});
