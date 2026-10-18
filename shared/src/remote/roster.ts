/**
 * The group's roster (spec 2026-10-16-device-group-design § 2): every member
 * keeps all of it and they converge on it by merging. Every entry is signed
 * (ADR roster-entries-are-signed): its membership by the member that added
 * it, its description by the device itself (or, until the device describes
 * itself, by its adder), its removal by the member that removed it. A merge
 * takes only entries whose signatures hold, signed by devices the roster
 * knows, so a member can add and remove devices but never change how
 * another device reads. No I/O: the server stores it, the channel carries it.
 */
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deviceId, fromBase64Url, publicKeyOf, sign, toBase64Url, verify, type Identity } from './keys.js';
import { PAIR_NAME_MAX_CHARS, PAIR_PLATFORM_MAX_CHARS } from './relayApi.js';

/**
 * The most entries a roster holds, removed ones included: a merge takes no
 * new id past it, so every roster a member sends fits the frame schema
 * (`RosterSchema`) and one channel frame, even with every field at its
 * longest and every character escaped.
 */
export const ROSTER_MAX_ENTRIES = 128;

/**
 * The highest epoch an entry may carry, far below what the schema and the
 * database hold: an entry above it is not taken, and `addMember` never
 * writes past it, so no member can push another's entry where its next
 * epoch no longer reads.
 */
export const ROSTER_MAX_EPOCH = 2 ** 31;

/**
 * How far above the epoch held here an entry may jump and still be taken.
 * An honest member writes one epoch up from what it knows (`addMember`);
 * a member that missed a few removals and re-adds of one device still
 * catches up. Past it, a member would need this many signed rounds per step
 * to walk a device's epoch to `ROSTER_MAX_EPOCH`.
 */
export const ROSTER_MAX_EPOCH_STEP = 8;

/**
 * The longest `kind` and `os` an entry carries: what a pairing cuts a
 * platform to, and a hello its `kind` and `os` (`HELLO_KIND_MAX_CHARS`).
 * A name is bound by `PAIR_NAME_MAX_CHARS`, as a pairing and a hello cut it.
 * One entry past a bound refuses the whole roster, so every writer cuts first.
 */
export const ROSTER_KIND_MAX_CHARS = PAIR_PLATFORM_MAX_CHARS;

/** An Ed25519 signature in base64url is 86 characters; anything else fails the check. */
const SignatureSchema = z.string().max(86);
/** A device id is 43 characters (`publicKeyOf`); anything else fails the check. */
const IdSchema = z.string().max(43);
/** A time in epoch ms. */
const TimeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const RosterEntrySchema = z.object({
  id: IdSchema,
  /** What the adder learned at the pairing; covered by `addedSig`, so never a later claim of the device. */
  kind: z.string().max(ROSTER_KIND_MAX_CHARS),
  name: z.string().max(PAIR_NAME_MAX_CHARS),
  os: z.string().max(ROSTER_KIND_MAX_CHARS),
  /** The device links with other members: its hello named the `group` capability. */
  links: z.boolean(),
  /** Read within the schema's bound so one entry past `ROSTER_MAX_EPOCH` drops alone, not the whole roster. */
  epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  addedBy: IdSchema,
  addedAt: TimeSchema,
  /** `addedBy`'s signature over `membershipBytes`. */
  addedSig: SignatureSchema,
  describedAt: TimeSchema,
  /** Who signed the description: the device itself, or its adder until the device describes itself. */
  describedBy: IdSchema,
  /** `describedBy`'s signature over `descriptionBytes`. */
  describedSig: SignatureSchema,
  removedBy: IdSchema.optional(),
  removedAt: TimeSchema.optional(),
  /** `removedBy`'s signature over `removalBytes`. */
  removedSig: SignatureSchema.optional(),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;
export const RosterSchema = z.array(RosterEntrySchema).max(ROSTER_MAX_ENTRIES);

/** An entry without its signatures: what Settings and the status show. */
export type RosterFields = Omit<RosterEntry, 'addedSig' | 'describedBy' | 'describedSig' | 'removedSig'>;

/** What a device's description says. */
export type RosterDescription = Pick<RosterEntry, 'name' | 'os' | 'links'>;

export function isLive(e: Pick<RosterEntry, 'removedAt'>): boolean {
  return e.removedAt === undefined;
}

/**
 * This device's own entry while no other member has added it: epoch 0,
 * added by itself. It is never sent and never taken from another member
 * (`shareable`, `mergeRoster`); any membership another member signs replaces it.
 */
export function isFounding(e: Pick<RosterEntry, 'id' | 'addedBy'>): boolean {
  return e.addedBy === e.id;
}

/** The entries a member sends and digests: every entry but a founding one. */
export function shareable(entries: RosterEntry[]): RosterEntry[] {
  return entries.filter((e) => !isFounding(e));
}

/** The signatures stripped off, for a status. */
export function rosterFields(e: RosterEntry): RosterFields {
  const { addedSig: _a, describedBy: _b, describedSig: _c, removedSig: _d, ...fields } = e;
  return fields;
}

const encoder = new TextEncoder();

/** The bytes `addedBy` signs: a fixed-order array, domain-separated by its tag. */
export function membershipBytes(e: Pick<RosterEntry, 'id' | 'kind' | 'epoch' | 'addedBy' | 'addedAt'>): Uint8Array {
  return encoder.encode(JSON.stringify(['orbital-roster-membership-v1', e.id, e.kind, e.epoch, e.addedBy, e.addedAt]));
}

/**
 * The bytes `describedBy` signs. They name the membership the description
 * belongs to (`addedSig`): a description fits only that membership, so a
 * device's own description also says which adder's word on its kind it
 * stands behind.
 */
export function descriptionBytes(
  e: Pick<RosterEntry, 'id' | 'epoch' | 'addedSig' | 'name' | 'os' | 'links' | 'describedAt' | 'describedBy'>,
): Uint8Array {
  return encoder.encode(JSON.stringify([
    'orbital-roster-description-v1', e.id, e.epoch, e.addedSig, e.name, e.os, e.links, e.describedAt, e.describedBy,
  ]));
}

/** The bytes `removedBy` signs. */
export function removalBytes(e: { id: string; epoch: number; removedBy: string; removedAt: number }): Uint8Array {
  return encoder.encode(JSON.stringify(['orbital-roster-removal-v1', e.id, e.epoch, e.removedBy, e.removedAt]));
}

function signed(signer: Identity, bytes: Uint8Array): string {
  return toBase64Url(sign(signer.secretKey, bytes));
}

function checks(id: string, bytes: Uint8Array, signature: string): boolean {
  const key = publicKeyOf(id);
  return key !== null && verify(key, bytes, fromBase64Url(signature));
}

/**
 * Whether an entry from another member may take part in a merge: an epoch
 * from 1 to `ROSTER_MAX_EPOCH`, added by a device other than itself,
 * described by itself or its adder, removed wholly or not at all, and every
 * signature good against the id that made it.
 */
export function verifyEntry(e: RosterEntry): boolean {
  if (e.epoch < 1 || e.epoch > ROSTER_MAX_EPOCH || isFounding(e)) return false;
  if (e.describedBy !== e.id && e.describedBy !== e.addedBy) return false;
  const removal = [e.removedBy, e.removedAt, e.removedSig].filter((x) => x !== undefined).length;
  if (removal !== 0 && removal !== 3) return false;
  if (!checks(e.addedBy, membershipBytes(e), e.addedSig)) return false;
  if (!checks(e.describedBy, descriptionBytes(e), e.describedSig)) return false;
  return removal === 0 || checks(e.removedBy!, removalBytes({ ...e, removedBy: e.removedBy!, removedAt: e.removedAt! }), e.removedSig!);
}

/** The keys in a fixed order, so the same entry always reads the same. */
function canonical(e: RosterEntry): string {
  return JSON.stringify([
    e.id, e.kind, e.name, e.os, e.links, e.epoch, e.addedBy, e.addedAt, e.addedSig, e.describedAt, e.describedBy,
    e.describedSig, e.removedBy ?? null, e.removedAt ?? null, e.removedSig ?? null,
  ]);
}

const membershipKey = (e: RosterEntry) => JSON.stringify([e.kind, e.addedBy, e.addedAt, e.addedSig]);
const descriptionKey = (e: RosterEntry) => JSON.stringify([e.name, e.os, e.links, e.describedAt, e.describedBy, e.describedSig]);
const removalKey = (e: RosterEntry) => JSON.stringify([e.removedBy ?? null, e.removedAt ?? null, e.removedSig ?? null]);

/**
 * Two signed entries of one id at one epoch, as one, the same whichever
 * comes first. One membership: the better description of the two (the
 * device's own over its adder's, then the later, then the larger). Two
 * memberships (two members added the device at one epoch): the one the
 * device described itself under, then the larger, with its own
 * description — a description fits only its membership. A removal over
 * none, then the larger.
 */
function combine(a: RosterEntry, b: RosterEntry): RosterEntry {
  const own = (e: RosterEntry) => (e.describedBy === e.id ? 1 : 0);
  let described: RosterEntry;
  if (membershipKey(a) === membershipKey(b)) {
    described = own(a) !== own(b) ? (own(a) > own(b) ? a : b)
      : a.describedAt !== b.describedAt ? (a.describedAt > b.describedAt ? a : b)
        : descriptionKey(a) >= descriptionKey(b) ? a : b;
  } else {
    described = own(a) !== own(b) ? (own(a) > own(b) ? a : b) : membershipKey(a) >= membershipKey(b) ? a : b;
  }
  const removals = [a, b].filter((e) => !isLive(e));
  const removed = removals.length === 0 ? null : removals.reduce((x, y) => (removalKey(x) >= removalKey(y) ? x : y));
  const { removedBy: _by, removedAt: _at, removedSig: _sig, ...out } = described;
  return removed
    ? { ...out, removedBy: removed.removedBy, removedAt: removed.removedAt, removedSig: removed.removedSig }
    : out;
}

/** What stands for an id once `incoming` arrived: see `mergeRoster`. */
function take(here: RosterEntry, incoming: RosterEntry): RosterEntry {
  if (isFounding(here)) return incoming;
  if (incoming.epoch < here.epoch) return here;
  if (incoming.epoch === here.epoch) return combine(here, incoming);
  return incoming.epoch - here.epoch <= ROSTER_MAX_EPOCH_STEP ? incoming : here;
}

const byId = (x: RosterEntry, y: RosterEntry) => (x.id < y.id ? -1 : x.id > y.id ? 1 : x.epoch - y.epoch);

export type MergeOptions = {
  /** The member the roster came from: a device paired here, so it may sign. */
  from?: string | null;
  /** This device: it may sign. */
  self?: string | null;
  /** `incoming` was written or checked here already: no signature is checked again. */
  trusted?: boolean;
};

/**
 * `local` with what it takes of `incoming`, sorted by id. An entry is
 * taken only if its signatures hold (`verifyEntry`) and every device that
 * signed it is known: in `local`, the sender, this device, or added by a
 * known device in the same roster. Then, per id: a founding entry gives way
 * to any membership; a lower epoch is ignored; one epoch is combined part
 * by part; a higher epoch replaces what is held, if no more than
 * `ROSTER_MAX_EPOCH_STEP` above it. A new id is taken only while the
 * roster holds fewer than `ROSTER_MAX_ENTRIES`, so a merge never outgrows
 * what a frame carries; ids known here still update, removals included.
 */
export function mergeRoster(local: RosterEntry[], incoming: RosterEntry[], opts: MergeOptions = {}): RosterEntry[] {
  const held = new Map(local.map((e) => [e.id, e]));
  const same = new Map(local.map((e) => [e.id, canonical(e)]));
  let pending = incoming.filter((e) => same.get(e.id) !== canonical(e) && (opts.trusted ? !isFounding(e) && e.epoch >= 1 && e.epoch <= ROSTER_MAX_EPOCH : verifyEntry(e)));
  const known = new Set<string>(held.keys());
  if (opts.from) known.add(opts.from);
  if (opts.self) known.add(opts.self);
  const accepted: RosterEntry[] = [];
  for (let progress = true; progress;) {
    progress = false;
    const rest: RosterEntry[] = [];
    for (const e of pending) {
      if (known.has(e.addedBy) && (e.removedBy === undefined || e.removedBy === e.id || known.has(e.removedBy))) {
        accepted.push(e);
        known.add(e.id);
        progress = true;
      } else {
        rest.push(e);
      }
    }
    pending = rest;
  }
  for (const e of accepted.sort(byId)) {
    const here = held.get(e.id);
    if (here) held.set(e.id, take(here, e));
    else if (held.size < ROSTER_MAX_ENTRIES) held.set(e.id, e);
  }
  return [...held.values()].sort(byId);
}

/** The whole roster as one string, founding entries included: what a store compares to tell a change. */
export function rosterKey(entries: RosterEntry[]): string {
  return [...entries].sort(byId).map(canonical).join('\n');
}

/** What two members compare: the hash of every entry they share. */
export function rosterDigest(entries: RosterEntry[]): string {
  return bytesToHex(sha256(encoder.encode(rosterKey(shareable(entries)))));
}

/** A device's description as `signer` signs it, at the entry's epoch. */
function describedAs(e: RosterEntry, about: RosterDescription, signer: Identity, now: number): RosterEntry {
  const next = { ...e, ...about, describedAt: now, describedBy: deviceId(signer.publicKey) };
  return { ...next, describedSig: signed(signer, descriptionBytes(next)) };
}

/**
 * This device's founding entry (`isFounding`), described by itself; what a
 * device holds of itself until a member adds it.
 */
export function foundingEntry(signer: Identity, kind: string, about: RosterDescription, now: number): RosterEntry {
  const id = deviceId(signer.publicKey);
  const membership = { id, kind, epoch: 0, addedBy: id, addedAt: now };
  return describedAs({
    ...membership, ...about, addedSig: signed(signer, membershipBytes(membership)), describedAt: now, describedBy: id,
    describedSig: '',
  }, about, signer, now);
}

/**
 * A newcomer, or a removed device paired again, added by `signer`: the next
 * epoch after any entry known for it, described as the adder learned it at
 * the pairing. Unchanged when `signer` is that device, or the next epoch
 * would pass `ROSTER_MAX_EPOCH`.
 */
export function addMember(
  roster: RosterEntry[], device: Pick<RosterEntry, 'id' | 'kind'> & RosterDescription, signer: Identity, now: number,
): RosterEntry[] {
  const by = deviceId(signer.publicKey);
  if (device.id === by) return roster;
  const known = roster.find((e) => e.id === device.id);
  const epoch = known && !isFounding(known) ? known.epoch + 1 : 1;
  if (epoch > ROSTER_MAX_EPOCH) return roster;
  const membership = { id: device.id, kind: device.kind, epoch, addedBy: by, addedAt: now };
  const entry = describedAs({
    ...membership, name: device.name, os: device.os, links: device.links,
    addedSig: signed(signer, membershipBytes(membership)), describedAt: now, describedBy: by, describedSig: '',
  }, device, signer, now);
  return [...roster.filter((e) => e.id !== device.id), entry].sort(byId);
}

/** Marks a live member removed by `signer`, at its current epoch; unchanged when unknown or already removed. */
export function removeMember(roster: RosterEntry[], id: string, signer: Identity, now: number): RosterEntry[] {
  const known = roster.find((e) => e.id === id);
  if (!known || !isLive(known)) return roster;
  const removal = { id, epoch: known.epoch, removedBy: deviceId(signer.publicKey), removedAt: now };
  const removed = { ...known, ...removal, removedSig: signed(signer, removalBytes(removal)) };
  return roster.map((e) => (e.id === id ? removed : e));
}

/**
 * A device's description as `signer` writes it: the device itself, or its
 * adder while the device has not described itself (a device that never
 * signs, a shipped phone, is described only so). A device describes itself
 * only under a membership of its own `kind` (`ownKind`): its description
 * vouches for the membership it names. The same array back when nothing
 * changes, or `signer` may not describe it, so callers can tell.
 */
export function describeMember(
  roster: RosterEntry[], id: string, about: RosterDescription, signer: Identity, now: number, ownKind?: string,
): RosterEntry[] {
  const known = roster.find((e) => e.id === id);
  if (!known) return roster;
  const by = deviceId(signer.publicKey);
  if (by === id ? ownKind !== undefined && known.kind !== ownKind : by !== known.addedBy || known.describedBy === id) return roster;
  const changed = known.describedBy !== by || about.name !== known.name || about.os !== known.os || about.links !== known.links;
  if (!changed) return roster;
  return roster.map((e) => (e.id === id ? describedAs(e, about, signer, now) : e));
}
