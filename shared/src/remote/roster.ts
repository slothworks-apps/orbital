/**
 * The group's roster (spec 2026-10-16-device-group-design § 2): every member
 * keeps all of it and they converge on it by merging. Every entry is signed
 * (ADR roster-entries-are-signed): its membership by the member that added
 * it, its description by the device itself (or, until the device describes
 * itself, by its adder), its removal by the member that removed it. Each
 * write names its signer's epoch, and a removal freezes what the removed
 * device signed at it: only what its remover endorsed stays. Which entries
 * stand is computed from the merged roster alone (`decide`), so members that
 * hold the same entries reach the same answer. No I/O: the server stores it,
 * the channel carries it.
 */
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deviceId, publicKeyOf, sign, signatureOf, toBase64Url, verify, type Identity } from './keys.js';
import { PAIR_NAME_MAX_CHARS, PAIR_PLATFORM_MAX_CHARS } from './relayApi.js';

/**
 * The most entries a roster holds, removed ones included: a merge keeps no
 * more, so every roster a member sends fits the frame schema
 * (`RosterSchema`) and one channel frame, even with every field at its
 * longest, both endorsements present and every character escaped.
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
 * The most memberships one device signs at one of its epochs, and the most
 * removals: what a removal of that device must endorse stays bounded, and
 * one key cannot fill the roster alone. Past it a merge keeps the first by
 * id and `addMember` and `removeMember` write nothing.
 */
export const ROSTER_MAX_ADDED_BY = 16;

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
/** Read within the schema's bound so one entry past `ROSTER_MAX_EPOCH` drops alone, not the whole roster. */
const EpochSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const RosterEntrySchema = z.object({
  id: IdSchema,
  /** What the adder learned at the pairing; covered by `addedSig`, so never a later claim of the device. */
  kind: z.string().max(ROSTER_KIND_MAX_CHARS),
  name: z.string().max(PAIR_NAME_MAX_CHARS),
  os: z.string().max(ROSTER_KIND_MAX_CHARS),
  /** The device links with other members: its hello named the `group` capability. */
  links: z.boolean(),
  epoch: EpochSchema,
  addedBy: IdSchema,
  /** `addedBy`'s own epoch when it signed. */
  addedEpoch: EpochSchema,
  addedAt: TimeSchema,
  /** `addedBy`'s signature over `membershipBytes`. */
  addedSig: SignatureSchema,
  /** A member that stands behind the membership once `addedBy` is removed (`endorsementBytes` over `addedSig`). */
  endorsedBy: IdSchema.optional(),
  endorsedEpoch: EpochSchema.optional(),
  endorsedSig: SignatureSchema.optional(),
  describedAt: TimeSchema,
  /** Who signed the description: the device itself, or its adder until the device describes itself. */
  describedBy: IdSchema,
  /** `describedBy`'s signature over `descriptionBytes`. */
  describedSig: SignatureSchema,
  removedBy: IdSchema.optional(),
  /** `removedBy`'s own epoch when it signed. */
  removerEpoch: EpochSchema.optional(),
  removedAt: TimeSchema.optional(),
  /** `removedBy`'s signature over `removalBytes`. */
  removedSig: SignatureSchema.optional(),
  /** A member that stands behind the removal once `removedBy` is removed (`endorsementBytes` over `removedSig`). */
  removalEndorsedBy: IdSchema.optional(),
  removalEndorsedEpoch: EpochSchema.optional(),
  removalEndorsedSig: SignatureSchema.optional(),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;
export const RosterSchema = z.array(RosterEntrySchema).max(ROSTER_MAX_ENTRIES);

type Signatures =
  | 'addedEpoch' | 'addedSig' | 'endorsedBy' | 'endorsedEpoch' | 'endorsedSig' | 'describedBy' | 'describedSig'
  | 'removerEpoch' | 'removedSig' | 'removalEndorsedBy' | 'removalEndorsedEpoch' | 'removalEndorsedSig';

/** An entry without its signatures, signer epochs and endorsements: what Settings and the status show. */
export type RosterFields = Omit<RosterEntry, Signatures>;

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
  const {
    addedEpoch: _a, addedSig: _b, endorsedBy: _c, endorsedEpoch: _d, endorsedSig: _e, describedBy: _f, describedSig: _g,
    removerEpoch: _h, removedSig: _i, removalEndorsedBy: _j, removalEndorsedEpoch: _k, removalEndorsedSig: _l, ...fields
  } = e;
  return fields;
}

const encoder = new TextEncoder();

/** The bytes `addedBy` signs: a fixed-order array, domain-separated by its tag. */
export function membershipBytes(
  e: Pick<RosterEntry, 'id' | 'kind' | 'epoch' | 'addedBy' | 'addedEpoch' | 'addedAt'>,
): Uint8Array {
  return encoder.encode(JSON.stringify([
    'orbital-roster-membership-v2', e.id, e.kind, e.epoch, e.addedBy, e.addedEpoch, e.addedAt,
  ]));
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
export function removalBytes(
  e: { id: string; epoch: number; removedBy: string; removerEpoch: number; removedAt: number },
): Uint8Array {
  return encoder.encode(JSON.stringify([
    'orbital-roster-removal-v2', e.id, e.epoch, e.removedBy, e.removerEpoch, e.removedAt,
  ]));
}

/** The bytes an endorser signs: the write's own signature, and the endorser at its epoch. */
export function endorsementBytes(writeSig: string, by: string, epoch: number): Uint8Array {
  return encoder.encode(JSON.stringify(['orbital-roster-endorsement-v1', writeSig, by, epoch]));
}

function signed(signer: Identity, bytes: Uint8Array): string {
  return toBase64Url(sign(signer.secretKey, bytes));
}

function checks(id: string, bytes: Uint8Array, signature: string): boolean {
  const key = publicKeyOf(id);
  const sig = signatureOf(signature);
  return key !== null && sig !== null && verify(key, bytes, sig);
}

/** How many of `parts` are set: a part of an entry is whole or absent. */
const present = (...parts: unknown[]) => parts.filter((x) => x !== undefined).length;

const inEpochs = (n: number | undefined) => n === undefined || n <= ROSTER_MAX_EPOCH;

/**
 * Whether an entry from another member may take part in a merge: an epoch
 * from 1 to `ROSTER_MAX_EPOCH` (and every signer epoch within it), added by
 * a device other than itself, described by itself or its adder, each part
 * whole or absent, an endorsement only by someone other than the write's
 * signer, and every signature good against the id that made it. Whether
 * the entry stands is the merge's question (`decide`), not this one's.
 */
export function verifyEntry(e: RosterEntry): boolean {
  if (e.epoch < 1 || e.epoch > ROSTER_MAX_EPOCH || isFounding(e)) return false;
  if (![e.addedEpoch, e.endorsedEpoch, e.removerEpoch, e.removalEndorsedEpoch].every(inEpochs)) return false;
  if (e.describedBy !== e.id && e.describedBy !== e.addedBy) return false;
  const endorsed = present(e.endorsedBy, e.endorsedEpoch, e.endorsedSig);
  const removal = present(e.removedBy, e.removerEpoch, e.removedAt, e.removedSig);
  const removalEndorsed = present(e.removalEndorsedBy, e.removalEndorsedEpoch, e.removalEndorsedSig);
  if ((endorsed !== 0 && endorsed !== 3) || (removal !== 0 && removal !== 4)) return false;
  if ((removalEndorsed !== 0 && removalEndorsed !== 3) || (removalEndorsed === 3 && removal === 0)) return false;
  if (e.endorsedBy !== undefined && e.endorsedBy === e.addedBy) return false;
  if (e.removalEndorsedBy !== undefined && e.removalEndorsedBy === e.removedBy) return false;
  if (!checks(e.addedBy, membershipBytes(e), e.addedSig)) return false;
  if (!checks(e.describedBy, descriptionBytes(e), e.describedSig)) return false;
  if (endorsed && !checks(e.endorsedBy!, endorsementBytes(e.addedSig, e.endorsedBy!, e.endorsedEpoch!), e.endorsedSig!)) {
    return false;
  }
  if (removal === 0) return true;
  const removed = { id: e.id, epoch: e.epoch, removedBy: e.removedBy!, removerEpoch: e.removerEpoch!, removedAt: e.removedAt! };
  if (!checks(e.removedBy!, removalBytes(removed), e.removedSig!)) return false;
  return removalEndorsed === 0 || checks(
    e.removalEndorsedBy!, endorsementBytes(e.removedSig!, e.removalEndorsedBy!, e.removalEndorsedEpoch!), e.removalEndorsedSig!,
  );
}

/** The keys in a fixed order, so the same entry always reads the same. */
function canonical(e: RosterEntry): string {
  return JSON.stringify([
    e.id, e.kind, e.name, e.os, e.links, e.epoch, e.addedBy, e.addedEpoch, e.addedAt, e.addedSig,
    e.endorsedBy ?? null, e.endorsedEpoch ?? null, e.endorsedSig ?? null, e.describedAt, e.describedBy, e.describedSig,
    e.removedBy ?? null, e.removerEpoch ?? null, e.removedAt ?? null, e.removedSig ?? null,
    e.removalEndorsedBy ?? null, e.removalEndorsedEpoch ?? null, e.removalEndorsedSig ?? null,
  ]);
}

const membershipKey = (e: RosterEntry) => JSON.stringify([e.kind, e.addedBy, e.addedEpoch, e.addedAt, e.addedSig]);
const descriptionKey = (e: RosterEntry) => JSON.stringify([e.name, e.os, e.links, e.describedAt, e.describedBy, e.describedSig]);
const endorsementKey = (e: RosterEntry) => JSON.stringify([e.endorsedBy, e.endorsedEpoch, e.endorsedSig]);
const removalKey = (e: RosterEntry) => JSON.stringify([e.removedBy, e.removerEpoch, e.removedAt, e.removedSig]);

/**
 * Entries whose signatures were checked here, by their canonical form: a
 * roster sent again costs no check. Bounded; the oldest goes first.
 */
const VERIFIED_CACHE_MAX = 1024;
const verified = new Map<string, true>();

function verifiedOnce(e: RosterEntry): boolean {
  const key = canonical(e);
  if (verified.has(key)) {
    verified.delete(key);
    verified.set(key, true);
    return true;
  }
  if (!verifyEntry(e)) return false;
  verified.set(key, true);
  if (verified.size > VERIFIED_CACHE_MAX) verified.delete(verified.keys().next().value!);
  return true;
}

const byId = (x: RosterEntry, y: RosterEntry) => (x.id < y.id ? -1 : x.id > y.id ? 1 : x.epoch - y.epoch);

/**
 * Every entry known for each id (from this device's roster first, then
 * from the one that arrived), and the devices this device takes as valid
 * outright: itself, and the device that signed its membership, upward along
 * that chain.
 */
class Pool {
  readonly byId = new Map<string, number[]>();
  readonly anchors = new Set<string>();
  readonly cands: RosterEntry[];
  readonly self: string;

  constructor(cands: RosterEntry[], self: string) {
    this.cands = cands;
    this.self = self;
    cands.forEach((c, i) => {
      const list = this.byId.get(c.id);
      if (list) list.push(i);
      else this.byId.set(c.id, [i]);
    });
    this.anchors.add(self);
    let next = this.ownMembership()?.addedBy;
    while (next !== undefined && !this.anchors.has(next)) {
      this.anchors.add(next);
      const first = this.byId.get(next)?.[0];
      const c = first === undefined ? undefined : cands[first];
      next = c && !isFounding(c) ? c.addedBy : undefined;
    }
  }

  /**
   * The membership this device stands behind, read from the entries alone:
   * any over its founding entry, a higher epoch over a live one only when
   * either is removed or this device described itself under it, and at one
   * epoch the one it described itself under.
   */
  private ownMembership(): RosterEntry | undefined {
    const own = (this.byId.get(this.self) ?? []).map((i) => this.cands[i]).filter((c) => !isFounding(c));
    if (own.length === 0) return undefined;
    return own.reduce((a, b) => {
      if (a.epoch !== b.epoch) {
        const [lo, hi] = a.epoch < b.epoch ? [a, b] : [b, a];
        return !isLive(lo) || !isLive(hi) || hi.describedBy === hi.id ? hi : lo;
      }
      return b.describedBy === b.id && a.describedBy !== a.id ? b : a;
    });
  }
}

/** One evaluation of the pool under an assumed set of facts (`decide`). */
type Pass = {
  valid: Set<string>;
  /** Per candidate: its membership stands. */
  membership: boolean[];
  /** Its membership's endorsement stands. */
  endorsed: boolean[];
  /** Its removal stands. */
  removal: boolean[];
  /** Its removal's endorsement stands. */
  removalEndorsed: boolean[];
  /** The facts that come out true: `r<i>` a removal by another device stands, `s<i>` candidate i replaces lower epochs of its id. */
  facts: Set<string>;
};

/**
 * The epoch an id stands at, and the candidates there, given which
 * candidates count and which higher epochs replace lower ones (`s<i>`): a
 * founding entry gives way to any other, the lowest epoch stands unless one
 * above it replaces it.
 */
function topOf(pool: Pool, id: string, counts: (i: number) => boolean, facts: Set<string>): number | null {
  const all = (pool.byId.get(id) ?? []).filter(counts);
  const real = all.filter((i) => !isFounding(pool.cands[i]));
  const from = real.length > 0 ? real : all;
  if (from.length === 0) return null;
  const lowest = Math.min(...from.map((i) => pool.cands[i].epoch));
  let top = lowest;
  for (const i of from) {
    const epoch = pool.cands[i].epoch;
    if (epoch > top && facts.has(`s${i}`)) top = epoch;
  }
  return top;
}

/**
 * Evaluates the pool with the removals and replacements in `facts` taken
 * as standing. With them fixed, validity is a least fixpoint: from the
 * anchors, a membership stands when its signer is valid and was live at the
 * epoch it signed at, or its endorser was; its device is then valid.
 *
 * Live at an epoch: the signer stands at that epoch and no removal in
 * `facts` names it there, setting aside the signer's own removal (a device
 * that left still stands behind what it signed) and one signed by the
 * write's subject (a device removing its own adder keeps its membership;
 * a device removing the one that removed it is not undone by that removal).
 * A signer at a higher epoch now was live at an older one only for writes
 * about the device that added it again. Epoch 0 is a device alone: what it
 * signed there stands while it is live at all.
 */
function pass(pool: Pool, facts: Set<string>): Pass {
  const { cands, anchors } = pool;
  const membership = cands.map(() => false);
  const counts = (i: number) => membership[i] || anchors.has(cands[i].id);
  const removedAt = (signer: string, epoch: number, subject: string) => (pool.byId.get(signer) ?? []).some((k) => (
    cands[k].epoch === epoch && facts.has(`r${k}`) && cands[k].removedBy !== subject
  ));
  const live = (signer: string, epoch: number, subject: string): boolean => {
    const top = topOf(pool, signer, counts, facts);
    if (top === null) return false;
    if (epoch === 0 || epoch === top) return !removedAt(signer, top, subject);
    if (epoch > top) return false;
    return (pool.byId.get(signer) ?? []).some((k) => counts(k) && cands[k].epoch === top && cands[k].addedBy === subject);
  };
  const valid = new Set(anchors);
  const vouched = (by: string | undefined, epoch: number | undefined, subject: string) => (
    by !== undefined && valid.has(by) && live(by, epoch!, subject)
  );
  for (let changed = true; changed;) {
    changed = false;
    cands.forEach((c, i) => {
      if (membership[i] || !(vouched(c.addedBy, c.addedEpoch, c.id) || vouched(c.endorsedBy, c.endorsedEpoch, c.id))) return;
      membership[i] = true;
      valid.add(c.id);
      changed = true;
    });
  }
  const endorsed = cands.map((c) => vouched(c.endorsedBy, c.endorsedEpoch, c.id));
  const removalEndorsed = cands.map((c) => vouched(c.removalEndorsedBy, c.removalEndorsedEpoch, c.id));
  const removal = cands.map((c, i) => c.removedBy !== undefined
    && (vouched(c.removedBy, c.removerEpoch, c.id) || removalEndorsed[i]));
  const out = new Set<string>();
  cands.forEach((c, i) => {
    if (removal[i] && c.removedBy !== c.id) out.add(`r${i}`);
    if (isFounding(c) || !counts(i)) return;
    const lower = (pool.byId.get(c.id) ?? []).filter((j) => counts(j) && cands[j].epoch < c.epoch);
    if (lower.length === 0) return;
    // A higher epoch replaces a live one only when either is removed or the device described itself under it;
    // one held here already (it comes first) stays — a lower epoch never replaces a higher one.
    if (c.describedBy === c.id || removal[i] || lower.some((j) => removal[j] || isFounding(cands[j]) || j > i)) {
      out.add(`s${i}`);
    }
  });
  return { valid, membership, endorsed, removal, removalEndorsed, facts: out };
}

/** A pass with its facts settled: what `select` and the endorsing writers read. */
type Decision = Pass & { settled: Set<string> };

const union = (a: Set<string>, b: Set<string>) => new Set([...a, ...b]);
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Which removals and replacements stand. Taking one as standing can make
 * another fall, so they are settled as the well-founded answer: alternately
 * what stands when every fact assumed so far stands (an over-estimate) and
 * what stands under that (an under-estimate), until the two stop moving.
 * Facts in neither are undecided: two removals each of which, standing,
 * would make the other fall — a removed device that also removed a device
 * its own remover depends on. Of those, a removal stands when the device it
 * removes signed an undecided removal itself (it took part in the dispute),
 * and the rest is settled again from there; what is still undecided does
 * not stand.
 */
function decide(pool: Pool): Decision {
  const forced = new Set<string>();
  const step = (assumed: Set<string>) => union(pass(pool, union(assumed, forced)).facts, forced);
  const limit = 2 * pool.cands.length + 4;
  for (;;) {
    let under = new Set(forced);
    let over = step(under);
    for (let round = 0; round < limit; round++) {
      const next = step(over);
      if (same(next, under)) break;
      under = next;
      over = step(under);
    }
    const undecided = [...over].filter((f) => !under.has(f) && f.startsWith('r')).map((f) => Number(f.slice(1)));
    const disputed = (k: number) => {
      const c = pool.cands[k];
      return undecided.some((j) => {
        const w = pool.cands[j];
        return w.removedBy === c.id && (w.removerEpoch === c.epoch || w.removerEpoch === 0);
      });
    };
    const more = undecided.filter((k) => !forced.has(`r${k}`) && disputed(k));
    if (more.length === 0) {
      const settled = union(under, forced);
      const final = pass(pool, settled);
      const removal = pool.cands.map((c, i) => (c.removedBy === c.id ? final.removal[i] : settled.has(`r${i}`)));
      return { ...final, removal, settled };
    }
    for (const k of more) forced.add(`r${k}`);
  }
}

const larger = <T>(xs: T[], key: (x: T) => string): T => xs.reduce((a, b) => (key(b) > key(a) ? b : a));

/**
 * One entry per valid id, from what stands: the epoch `topOf` gives; at it,
 * a standing membership — the one the device described itself under, then
 * the larger — with its best description (the device's own over its
 * adder's, then the later, then the larger) and a standing endorsement; a
 * standing removal, another device's over the device's own, then the
 * larger, with its endorsement if that stands. An id with no standing
 * membership is gone, unless this device takes it as valid outright.
 */
function select(pool: Pool, d: Decision): RosterEntry[] {
  const { cands, anchors } = pool;
  const counts = (i: number) => d.membership[i] || anchors.has(cands[i].id);
  const out: RosterEntry[] = [];
  for (const [id, all] of pool.byId) {
    const top = topOf(pool, id, counts, d.settled);
    if (top === null) continue;
    const there = all.filter((i) => counts(i) && cands[i].epoch === top && (top === 0 || !isFounding(cands[i])));
    const standing = there.filter((i) => d.membership[i]);
    const from = standing.length > 0 ? standing : there;
    const own = from.filter((i) => cands[i].describedBy === id);
    const chosen = larger(own.length > 0 ? own : from, (i) => membershipKey(cands[i]));
    const sameMembership = there.filter((i) => membershipKey(cands[i]) === membershipKey(cands[chosen]));
    const described = sameMembership.reduce((a, b) => {
      const [x, y] = [cands[a], cands[b]];
      const ownX = x.describedBy === id ? 1 : 0;
      const ownY = y.describedBy === id ? 1 : 0;
      if (ownX !== ownY) return ownY > ownX ? b : a;
      if (x.describedAt !== y.describedAt) return y.describedAt > x.describedAt ? b : a;
      return descriptionKey(y) > descriptionKey(x) ? b : a;
    });
    const endorsements = sameMembership.filter((i) => d.endorsed[i]);
    const endorsement = endorsements.length > 0 ? cands[larger(endorsements, (i) => endorsementKey(cands[i]))] : null;
    const removals = all.filter((i) => cands[i].epoch === top && d.removal[i]);
    const byOther = removals.filter((i) => cands[i].removedBy !== id);
    const removal = removals.length > 0
      ? cands[larger(byOther.length > 0 ? byOther : removals, (i) => removalKey(cands[i]))] : null;
    const removalIndex = removal ? cands.indexOf(removal) : -1;
    const {
      endorsedBy: _a, endorsedEpoch: _b, endorsedSig: _c, removedBy: _d, removerEpoch: _e, removedAt: _f, removedSig: _g,
      removalEndorsedBy: _h, removalEndorsedEpoch: _i, removalEndorsedSig: _j, ...base
    } = cands[described];
    let entry: RosterEntry = base;
    if (endorsement) {
      entry = { ...entry, endorsedBy: endorsement.endorsedBy, endorsedEpoch: endorsement.endorsedEpoch, endorsedSig: endorsement.endorsedSig };
    }
    if (removal) {
      entry = {
        ...entry, removedBy: removal.removedBy, removerEpoch: removal.removerEpoch, removedAt: removal.removedAt, removedSig: removal.removedSig,
      };
      if (removal.removalEndorsedBy !== undefined && d.removalEndorsed[removalIndex]) {
        entry = {
          ...entry, removalEndorsedBy: removal.removalEndorsedBy, removalEndorsedEpoch: removal.removalEndorsedEpoch,
          removalEndorsedSig: removal.removalEndorsedSig,
        };
      }
    }
    out.push(entry);
  }
  return out;
}

/**
 * The bounds on what stands: at most `ROSTER_MAX_ADDED_BY` memberships and
 * as many removals per signer and epoch, and at most `ROSTER_MAX_ENTRIES`
 * entries. Past a bound what stays is this device, then the ids in `prefer`
 * (the roster held before the merge), then the entries fewest adds away from
 * this device's own chain — so an adder stays ahead of what it added — then
 * the first by id.
 */
function bounded(entries: RosterEntry[], self: string, prefer: Set<string>): RosterEntry[] {
  const index = new Map(entries.map((e) => [e.id, e]));
  const depths = new Map<string, number>();
  const depth = (e: RosterEntry): number => {
    const known = depths.get(e.id);
    if (known !== undefined) return known;
    depths.set(e.id, 0);
    const adder = index.get(e.addedBy);
    const d = e.id === self || isFounding(e) || !adder ? 0 : depth(adder) + 1;
    depths.set(e.id, d);
    return d;
  };
  const order = (x: RosterEntry, y: RosterEntry) => {
    const rank = (e: RosterEntry) => (e.id === self ? 0 : prefer.has(e.id) ? 1 : 2);
    return rank(x) - rank(y) || depth(x) - depth(y) || byId(x, y);
  };
  const sorted = [...entries].sort(order);
  const adds = new Map<string, number>();
  const removes = new Map<string, number>();
  const out: RosterEntry[] = [];
  for (const e of sorted) {
    let entry = e;
    if (!isFounding(e)) {
      const key = JSON.stringify([e.addedBy, e.addedEpoch]);
      const n = adds.get(key) ?? 0;
      if (n >= ROSTER_MAX_ADDED_BY) continue;
      adds.set(key, n + 1);
    }
    if (e.removedBy !== undefined && e.removedBy !== e.id) {
      const key = JSON.stringify([e.removedBy, e.removerEpoch]);
      const n = removes.get(key) ?? 0;
      if (n >= ROSTER_MAX_ADDED_BY) {
        const {
          removedBy: _a, removerEpoch: _b, removedAt: _c, removedSig: _d, removalEndorsedBy: _e, removalEndorsedEpoch: _f,
          removalEndorsedSig: _g, ...live
        } = e;
        entry = live;
      } else {
        removes.set(key, n + 1);
      }
    }
    if (out.length >= ROSTER_MAX_ENTRIES) break;
    out.push(entry);
  }
  return out.sort(byId);
}

/**
 * What stands of `cands` (several may share an id), seen from `self`: one
 * entry per valid id, within the bounds, settled again until nothing more
 * falls — an entry dropped at a bound can take with it what only it vouched for.
 */
function settle(cands: RosterEntry[], self: string, prefer: Set<string>): RosterEntry[] {
  let current = cands;
  for (let round = 0; round < 8; round++) {
    const pool = new Pool(current, self);
    const next = bounded(select(pool, decide(pool)), self, prefer);
    if (round > 0 && rosterKey(next) === rosterKey(current)) return next;
    current = next;
  }
  return current;
}

export type MergeOptions = {
  /** The device whose view this is: its own entry and the chain that added it anchor what is valid. */
  self: string;
  /** `incoming` was written or checked here already: no signature is checked again. */
  trusted?: boolean;
};

/** Whether a roster names one id twice: such a roster is not merged at all. */
export function hasDuplicateIds(entries: RosterEntry[]): boolean {
  return new Set(entries.map((e) => e.id)).size !== entries.length;
}

/**
 * `local` with what it takes of `incoming`, sorted by id. An incoming entry
 * takes part only if its signatures hold (`verifyEntry`); then the two are
 * weighed together (`decide`), and only valid entries and standing writes
 * are kept (`select`, `bounded`): an entry a removal made invalid is pruned
 * here, so what a removed key filled frees itself once the removal is known.
 */
export function mergeRoster(local: RosterEntry[], incoming: RosterEntry[], opts: MergeOptions): RosterEntry[] {
  const held = new Map(local.map((e) => [e.id, canonical(e)]));
  const taken = incoming.filter((e) => held.get(e.id) !== canonical(e)
    && (opts.trusted ? !isFounding(e) && e.epoch >= 1 && e.epoch <= ROSTER_MAX_EPOCH : verifiedOnce(e)));
  return settle([...local, ...taken], opts.self, new Set(local.map((e) => e.id)));
}

/** The whole roster as one string, founding entries included: what a store compares to tell a change. */
export function rosterKey(entries: RosterEntry[]): string {
  return [...entries].sort(byId).map(canonical).join('\n');
}

/** What two members compare: the hash of every entry they share. */
export function rosterDigest(entries: RosterEntry[]): string {
  return bytesToHex(sha256(encoder.encode(rosterKey(shareable(entries)))));
}

/** `by`'s own epoch in `roster`: its entry's, 0 while it is alone or not in it. */
function epochOf(roster: RosterEntry[], by: string): number {
  return roster.find((e) => e.id === by)?.epoch ?? 0;
}

/**
 * Whether `by` may add `id` to `roster`: not itself, room for it
 * (`ROSTER_MAX_ENTRIES`, unless the roster holds it already), and fewer than
 * `ROSTER_MAX_ADDED_BY` memberships signed by `by` at its current epoch.
 */
export function mayAdd(roster: RosterEntry[], id: string, by: string): boolean {
  if (id === by) return false;
  const room = roster.some((e) => e.id === id) || roster.length < ROSTER_MAX_ENTRIES;
  const epoch = epochOf(roster, by);
  const mine = roster.filter((e) => e.addedBy === by && e.addedEpoch === epoch && e.id !== id && !isFounding(e)).length;
  return room && mine < ROSTER_MAX_ADDED_BY;
}

/**
 * `roster` with `signer` (at `signerEpoch`) endorsing every write whose
 * standing hangs on `device` at `epoch` (and at epoch 0 with `alone`): what
 * it signed there without an endorsement of its own, and what it endorsed
 * there. Only writes that stand now, and of memberships only those of a
 * device that described itself under them: a membership the device never
 * stood behind falls with its adder. A write about `signer` itself needs no
 * endorsement (`pass`).
 */
function endorsing(
  roster: RosterEntry[], device: string, epoch: number, alone: boolean, signer: Identity, signerEpoch: number,
): RosterEntry[] {
  const by = deviceId(signer.publicKey);
  const d = decide(new Pool(roster, by));
  const on = (who: string | undefined, at: number | undefined) => who === device && (at === epoch || (alone && at === 0));
  return roster.map((e, i) => {
    if (e.id === by || e.id === device) return e;
    let out = e;
    const endorsement = (sig: string) => ({ by, epoch: signerEpoch, sig: signed(signer, endorsementBytes(sig, by, signerEpoch)) });
    const ownEndorsement = e.endorsedBy !== undefined && !on(e.endorsedBy, e.endorsedEpoch) && d.endorsed[i];
    if (d.membership[i] && e.describedBy === e.id && e.addedBy !== by
      && ((on(e.addedBy, e.addedEpoch) && !ownEndorsement) || on(e.endorsedBy, e.endorsedEpoch))) {
      const x = endorsement(e.addedSig);
      out = { ...out, endorsedBy: x.by, endorsedEpoch: x.epoch, endorsedSig: x.sig };
    }
    const ownRemovalEndorsement = e.removalEndorsedBy !== undefined && !on(e.removalEndorsedBy, e.removalEndorsedEpoch)
      && d.removalEndorsed[i];
    if (e.removedSig !== undefined && d.removal[i] && e.removedBy !== by
      && ((on(e.removedBy, e.removerEpoch) && !ownRemovalEndorsement) || on(e.removalEndorsedBy, e.removalEndorsedEpoch))) {
      const x = endorsement(e.removedSig);
      out = { ...out, removalEndorsedBy: x.by, removalEndorsedEpoch: x.epoch, removalEndorsedSig: x.sig };
    }
    return out;
  });
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
  const membership = { id, kind, epoch: 0, addedBy: id, addedEpoch: 0, addedAt: now };
  return describedAs({
    ...membership, ...about, addedSig: signed(signer, membershipBytes(membership)), describedAt: now, describedBy: id,
    describedSig: '',
  }, about, signer, now);
}

/**
 * A newcomer, or a removed device paired again, added by `signer` at its
 * own epoch: the next epoch after any entry known for it, described as the
 * adder learned it at the pairing. Adding a removed device again, the adder
 * endorses what still stands of what the device signed at its old epoch
 * (`endorsing`): that epoch is over once the new one is taken. Unchanged
 * when `mayAdd` refuses, or the next epoch would pass `ROSTER_MAX_EPOCH`.
 */
export function addMember(
  roster: RosterEntry[], device: Pick<RosterEntry, 'id' | 'kind'> & RosterDescription, signer: Identity, now: number,
): RosterEntry[] {
  const by = deviceId(signer.publicKey);
  if (!mayAdd(roster, device.id, by)) return roster;
  const known = roster.find((e) => e.id === device.id);
  const epoch = known && !isFounding(known) ? known.epoch + 1 : 1;
  if (epoch > ROSTER_MAX_EPOCH) return roster;
  const addedEpoch = epochOf(roster, by);
  const base = known && !isFounding(known) && !isLive(known)
    ? endorsing(roster, known.id, known.epoch, false, signer, addedEpoch) : roster;
  const membership = { id: device.id, kind: device.kind, epoch, addedBy: by, addedEpoch, addedAt: now };
  const entry = describedAs({
    ...membership, name: device.name, os: device.os, links: device.links,
    addedSig: signed(signer, membershipBytes(membership)), describedAt: now, describedBy: by, describedSig: '',
  }, device, signer, now);
  return [...base.filter((e) => e.id !== device.id), entry].sort(byId);
}

/**
 * Marks a live member removed by `signer`, at the member's current epoch
 * and the signer's own. Removing another device, the signer endorses what
 * it keeps of what that device signed at that epoch or alone (`endorsing`);
 * its own removal (leaving) freezes nothing. Unchanged when the member is
 * unknown or already removed, or `signer` has signed `ROSTER_MAX_ADDED_BY`
 * removals at its epoch.
 */
export function removeMember(roster: RosterEntry[], id: string, signer: Identity, now: number): RosterEntry[] {
  const known = roster.find((e) => e.id === id);
  if (!known || !isLive(known)) return roster;
  const by = deviceId(signer.publicKey);
  const removerEpoch = epochOf(roster, by);
  const mine = roster.filter((e) => e.removedBy === by && e.removerEpoch === removerEpoch && e.id !== by).length;
  if (id !== by && mine >= ROSTER_MAX_ADDED_BY) return roster;
  const base = id === by ? roster : endorsing(roster, id, known.epoch, true, signer, removerEpoch);
  const removal = { id, epoch: known.epoch, removedBy: by, removerEpoch, removedAt: now };
  const removed = { ...known, ...removal, removedSig: signed(signer, removalBytes(removal)) };
  return base.map((e) => (e.id === id ? removed : e));
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
