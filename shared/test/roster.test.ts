import { describe, expect, it } from 'vitest';
import { deviceId, generateIdentity, sign, toBase64Url, type Identity } from '../src/remote/keys.js';
import {
  EMPTY_ROSTER, ROSTER_KIND_MAX_CHARS, ROSTER_MAX_ENTRIES, ROSTER_MAX_VERSION, RosterStateSchema, describeDevice,
  dissolveRoster, foundRoster, leftNotice, memberIds, nextRoster, rosterBytes, rosterDigest, rosterMembers, takeRoster,
  verifyRoster, type RosterDoc, type RosterState, type TakeOptions,
} from '../src/remote/roster.js';
import { PAIR_NAME_MAX_CHARS } from '../src/remote/relayApi.js';
import { MAX_INNER_BYTES } from '../src/remote/channel.js';
import { GroupMessage, encodeInner } from '../src/remote/messages.js';

const about = { name: 'studio', os: 'macos', links: true };
const idOf = (who: Identity) => deviceId(who.publicKey);
const P = generateIdentity();
const A = generateIdentity();
const B = generateIdentity();
const R = generateIdentity();

/** P's group of P, A, B and R, at version 1, each described by P. */
function group(): RosterState {
  const doc = foundRoster(P, 'desktop', [A, B, R].map((x) => ({ id: idOf(x), kind: 'desktop' })), 1)!;
  return { roster: doc, descriptions: [P, A, B, R].map((x) => describeDevice(idOf(x), about, P, 1)), left: [] };
}

/** `state` with its document moved on by the primary. */
const next = (state: RosterState, change: { add?: Identity[]; remove?: Identity[] }): RosterState => ({
  ...state,
  roster: nextRoster(state.roster!, P, {
    add: (change.add ?? []).map((x) => ({ id: idOf(x), kind: 'desktop' })), remove: (change.remove ?? []).map(idOf),
  }, 2)!,
});

/** What `self` holds once `incoming` arrives from a paired device. */
const at = (self: Identity, held: RosterState, incoming: RosterState, opts: Partial<TakeOptions> = {}) =>
  takeRoster(held, incoming, { self: idOf(self), alone: false, paired: () => true, ...opts });

/** A document signed by hand, as no primary would sign it. */
function forged(signer: Identity, doc: Omit<RosterDoc, 'sig'>): RosterDoc {
  return { ...doc, sig: toBase64Url(sign(signer.secretKey, rosterBytes(doc))) };
}

describe('taking a roster', () => {
  it('takes a newer version of its group, whichever member passed it on', () => {
    const held = group();
    const v2 = next(held, { remove: [R] });
    // B passes on what P signed: the version cannot be forged, so the sender does not matter.
    expect(at(A, held, v2).roster).toEqual(v2.roster);
    expect(memberIds(at(A, held, v2))).not.toContain(idOf(R));
  });

  it('refuses an older or equal version', () => {
    const v1 = group();
    const v2 = next(v1, { add: [generateIdentity()] });
    expect(at(A, v2, v1).roster).toEqual(v2.roster);
    const otherV2 = next(v1, { remove: [B] });
    expect(at(A, v2, otherV2).roster).toEqual(v2.roster);
  });

  it('refuses a version a member signed, and one a removed device signed', () => {
    const v2 = next(group(), { remove: [R] });
    const base = { group: idOf(P), version: 9, members: v2.roster!.members.filter((m) => m.id !== idOf(B)) };
    // A member signs in the primary's name.
    expect(verifyRoster(forged(A, base))).toBe(false);
    expect(at(B, v2, { ...v2, roster: forged(A, base) }).roster).toEqual(v2.roster);
    // The removed device signs a version that names it again.
    const back = { ...base, members: [...v2.roster!.members, { id: idOf(R), kind: 'desktop', addedAt: 3 }].sort((x, y) => (x.id < y.id ? -1 : 1)) };
    expect(at(A, v2, { ...v2, roster: forged(R, back) }).roster).toEqual(v2.roster);
    // A removed device as the primary of its own group: not this group, so nothing.
    const own = foundRoster(R, 'desktop', [{ id: idOf(A), kind: 'desktop' }], 3)!;
    expect(at(A, v2, { roster: own, descriptions: [], left: [] }).roster).toEqual(v2.roster);
  });

  it('refuses a document with a phone as its primary, members out of order, or a canonical form changed', () => {
    const phone = generateIdentity();
    expect(foundRoster(phone, 'phone', [], 1)).toBeNull();
    const asPhone = forged(phone, { group: idOf(phone), version: 1, members: [{ id: idOf(phone), kind: 'phone', addedAt: 1 }] });
    expect(verifyRoster(asPhone)).toBe(false);
    const doc = group().roster!;
    expect(verifyRoster(doc)).toBe(true);
    expect(verifyRoster({ ...doc, members: [...doc.members].reverse() })).toBe(false);
    expect(verifyRoster({ ...doc, version: 2 })).toBe(false);
    expect(verifyRoster({ ...doc, sig: `${doc.sig}=` })).toBe(false);
  });

  it('a device alone takes the document of a primary paired here that names it, and no other', () => {
    const joiner = generateIdentity();
    const v2 = next(group(), { add: [joiner] });
    const alone = { alone: true, paired: (id: string) => id === idOf(P) };
    expect(at(joiner, EMPTY_ROSTER, v2, alone).roster).toEqual(v2.roster);
    // Not named, or a primary not paired here, or a member of another group: nothing.
    expect(at(generateIdentity(), EMPTY_ROSTER, v2, alone).roster).toBeNull();
    expect(at(joiner, EMPTY_ROSTER, v2, { alone: true, paired: () => false }).roster).toBeNull();
    const elsewhere = foundRoster(B, 'desktop', [{ id: idOf(A), kind: 'desktop' }], 1)!;
    expect(at(A, group(), { roster: elsewhere, descriptions: [], left: [] }).roster).toEqual(group().roster);
  });
});

describe('descriptions', () => {
  it('a device describes itself, and its own word beats the primary\'s, even a later one', () => {
    const held = group();
    const own = describeDevice(idOf(A), { ...about, name: 'own' }, A, 5);
    const byPrimary = describeDevice(idOf(A), { ...about, name: 'primary' }, P, 9);
    const taken = at(B, held, { ...held, descriptions: [own, byPrimary] });
    expect(rosterMembers(taken).find((m) => m.id === idOf(A))?.name).toBe('own');
  });

  it('between two descriptions of one signer the later wins, and a clock that went back still moves on', () => {
    const first = describeDevice(idOf(A), { ...about, name: 'first' }, A, 50);
    const second = describeDevice(idOf(A), { ...about, name: 'second' }, A, 10, first);
    expect(second.describedAt).toBe(51);
    const held = { ...group(), descriptions: [first] };
    expect(rosterMembers(at(B, held, { ...held, descriptions: [second] })).find((m) => m.id === idOf(A))?.name).toBe('second');
  });

  it('a description signed by another member, or a forged one, is refused', () => {
    const held = group();
    const byB = describeDevice(idOf(A), { ...about, name: 'by B' }, B, 99);
    const forgedOwn = { ...describeDevice(idOf(A), { ...about, name: 'x' }, A, 99), name: 'changed' };
    const taken = at(R, held, { ...held, descriptions: [byB, forgedOwn] });
    expect(rosterMembers(taken).find((m) => m.id === idOf(A))?.name).toBe('studio');
  });
});

describe('leaving', () => {
  it('a left notice is honoured while no later version names the device; a re-add overrides it', () => {
    const held = group();
    const notice = leftNotice(A, held.roster!, 7);
    const taken = at(B, held, { roster: null, descriptions: [], left: [notice] });
    expect(memberIds(taken)).not.toContain(idOf(A));
    // A member behind at an older version takes it too.
    const v2 = next(held, { add: [generateIdentity()] });
    const later = leftNotice(A, v2.roster!, 7);
    expect(memberIds(at(B, held, { roster: null, descriptions: [], left: [later] }))).not.toContain(idOf(A));
    // The primary leaves it out, then adds it again: the notice says nothing any more.
    const without = next(taken, { remove: [A] });
    const readded = next(without, { add: [A] });
    expect(memberIds(at(B, taken, readded))).toContain(idOf(A));
    expect(at(B, taken, readded).left).toEqual([]);
    // Signed by another device, it is no notice.
    const forgedNotice = { ...leftNotice(B, held.roster!, 7), id: idOf(A) };
    expect(memberIds(at(R, held, { roster: null, descriptions: [], left: [forgedNotice] }))).toContain(idOf(A));
  });

  it('the primary leaving dissolves the group: the last version names it alone', () => {
    const held = group();
    const last = dissolveRoster(held.roster!, P)!;
    expect(last).toMatchObject({ version: 2, dissolved: true, members: [{ id: idOf(P) }] });
    expect(dissolveRoster(held.roster!, A)).toBeNull();
    const taken = at(A, held, { roster: last, descriptions: [], left: [] });
    expect(taken.roster?.dissolved).toBe(true);
    expect(memberIds(taken)).toEqual([]);
    // Founding again goes on from the dissolved version, so a member asleep since takes it.
    expect(foundRoster(P, 'desktop', [{ id: idOf(A), kind: 'desktop' }], 9, last)?.version).toBe(3);
  });
});

describe('writing', () => {
  it('only the primary signs the next version; the primary is never left out', () => {
    const doc = group().roster!;
    expect(nextRoster(doc, A, { remove: [idOf(B)] }, 2)).toBeNull();
    expect(nextRoster(doc, P, { remove: [idOf(P)] }, 2)).toBeNull();
    expect(nextRoster(doc, P, { remove: [idOf(B)] }, 2)?.version).toBe(2);
  });

  it('holds at most ROSTER_MAX_ENTRIES members and stops at ROSTER_MAX_VERSION', () => {
    const others = Array.from({ length: ROSTER_MAX_ENTRIES - 1 }, () => ({ id: idOf(generateIdentity()), kind: 'phone' }));
    const full = foundRoster(P, 'desktop', others, 1)!;
    expect(full.members).toHaveLength(ROSTER_MAX_ENTRIES);
    expect(nextRoster(full, P, { add: [{ id: idOf(A), kind: 'desktop' }] }, 2)).toBeNull();
    expect(foundRoster(P, 'desktop', [...others, { id: idOf(A), kind: 'desktop' }], 1)).toBeNull();
    const last = forged(P, { group: idOf(P), version: ROSTER_MAX_VERSION, members: full.members });
    expect(nextRoster(last, P, { remove: [others[0].id] }, 2)).toBeNull();
  });

  it('the digest tells two states apart, whatever order their parts came in', () => {
    const held = group();
    const shuffled = { ...held, descriptions: [...held.descriptions].reverse() };
    expect(rosterDigest(shuffled)).toBe(rosterDigest(held));
    expect(rosterDigest(next(held, { remove: [R] }))).not.toBe(rosterDigest(held));
  });
});

describe('the frame', () => {
  it('a full roster with every description and left notice at its longest, every character escaped, fits one channel frame', () => {
    const escaped = (n: number) => '\u0001'.repeat(n);
    const big = Number.MAX_SAFE_INTEGER;
    const id = idOf(A);
    const members = new Array(ROSTER_MAX_ENTRIES).fill({ id, kind: escaped(ROSTER_KIND_MAX_CHARS), addedAt: big });
    const msg = {
      t: 'roster',
      roster: { group: id, version: ROSTER_MAX_VERSION, members, dissolved: true, sig: 's'.repeat(86) },
      descriptions: new Array(ROSTER_MAX_ENTRIES).fill({
        id, name: escaped(PAIR_NAME_MAX_CHARS), os: escaped(ROSTER_KIND_MAX_CHARS), links: false, describedAt: big, by: id,
        sig: 's'.repeat(86),
      }),
      left: new Array(ROSTER_MAX_ENTRIES).fill({ id, group: id, version: ROSTER_MAX_VERSION, at: big, sig: 's'.repeat(86) }),
    };
    expect(GroupMessage.safeParse(msg).success).toBe(true);
    expect(encodeInner({ kind: 'json', value: msg }).length).toBeLessThanOrEqual(MAX_INNER_BYTES);
    // One past the bound is refused whole.
    expect(RosterStateSchema.safeParse({ ...msg, left: [...msg.left, msg.left[0]] }).success).toBe(false);
  });
});
