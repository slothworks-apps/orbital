/**
 * The group's roster (ADR the-group-has-one-primary-device): one document
 * the group's primary signs — the group's id, which is the primary's own, a
 * version that only grows, and every member with the kind its pairing
 * proved. Beside it travel each member's description (name, os, links),
 * signed by the device itself or, for a device that never describes itself,
 * by the primary; and the notices of members that left, each signed by the
 * device that left. Nothing is merged: a member takes a document only when
 * its own group's primary signed it and its version is higher than the one
 * it holds. No I/O: the server stores it, the channel carries it.
 */
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deviceId, publicKeyOf, sign, signatureOf, toBase64Url, verify, type Identity } from './keys.js';
import { PAIR_NAME_MAX_CHARS, PAIR_PLATFORM_MAX_CHARS } from './relayApi.js';

/**
 * The most members a roster names, the primary included, and so the most
 * descriptions and left notices beside it: a whole roster, every field at
 * its longest and every character escaped, fits one channel frame.
 */
export const ROSTER_MAX_ENTRIES = 128;

/** The highest version a roster or a left notice carries: the primary signs none past it. */
export const ROSTER_MAX_VERSION = 2 ** 31;

/**
 * The longest `kind` and `os` the roster carries: what a pairing cuts a
 * platform to, and a hello its `kind` and `os` (`HELLO_KIND_MAX_CHARS`). A
 * name is bound by `PAIR_NAME_MAX_CHARS`, as a pairing and a hello cut it.
 * One field past a bound refuses the whole roster, so every writer cuts first.
 */
export const ROSTER_KIND_MAX_CHARS = PAIR_PLATFORM_MAX_CHARS;

/** An Ed25519 signature in base64url is 86 characters; anything else fails the check. */
const SignatureSchema = z.string().max(86);
/** A device id is 43 characters (`publicKeyOf`); anything else fails the check. */
const IdSchema = z.string().max(43);
/** A time in epoch ms. */
const TimeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const VersionSchema = z.number().int().min(1).max(ROSTER_MAX_VERSION);

/**
 * A member as the primary names it: `kind` is what its pairing proved,
 * never what it later says; `addedVersion` the version at which the primary
 * added it, which a left notice is weighed against.
 */
export const RosterMemberSchema = z.object({
  id: IdSchema,
  kind: z.string().max(ROSTER_KIND_MAX_CHARS),
  addedAt: TimeSchema,
  addedVersion: VersionSchema,
});
export type RosterMember = z.infer<typeof RosterMemberSchema>;

/** The document the primary signs (`rosterBytes`); `group` is the primary's id. */
export const RosterDocSchema = z.object({
  group: IdSchema,
  version: VersionSchema,
  /** Sorted by id, each once, the primary among them. */
  members: z.array(RosterMemberSchema).max(ROSTER_MAX_ENTRIES),
  /** The primary left: this version names it alone, and every member becomes alone. */
  dissolved: z.literal(true).optional(),
  sig: SignatureSchema,
});
export type RosterDoc = z.infer<typeof RosterDocSchema>;

/** What a device says about itself, signed by `by`: the device itself, or its group's primary. */
export const DescriptionSchema = z.object({
  id: IdSchema,
  name: z.string().max(PAIR_NAME_MAX_CHARS),
  os: z.string().max(ROSTER_KIND_MAX_CHARS),
  /** The device links with other members: its hello named the `group` capability. */
  links: z.boolean(),
  describedAt: TimeSchema,
  by: IdSchema,
  sig: SignatureSchema,
});
export type Description = z.infer<typeof DescriptionSchema>;

/** A member's word that it left `group` while it held `version`, signed by the member itself. */
export const LeftNoticeSchema = z.object({
  id: IdSchema,
  group: IdSchema,
  version: VersionSchema,
  at: TimeSchema,
  sig: SignatureSchema,
});
export type LeftNotice = z.infer<typeof LeftNoticeSchema>;

/** Everything a device keeps of its group, and what a `roster` message carries. */
export const RosterStateSchema = z.object({
  /** Null while this device is alone. */
  roster: RosterDocSchema.nullable(),
  descriptions: z.array(DescriptionSchema).max(ROSTER_MAX_ENTRIES),
  left: z.array(LeftNoticeSchema).max(ROSTER_MAX_ENTRIES),
});
export type RosterState = z.infer<typeof RosterStateSchema>;

/** What a device alone holds. */
export const EMPTY_ROSTER: RosterState = Object.freeze({ roster: null, descriptions: [], left: [] });

/** What a description says. */
export type RosterAbout = Pick<Description, 'name' | 'os' | 'links'>;

/** A member as the status and the host read it: the document's word and its best description, together. */
export type MemberView = RosterMember & RosterAbout & {
  /** This member is the group's primary. */
  primary: boolean;
};

const encoder = new TextEncoder();

/** The bytes the primary signs: a fixed-order array, domain-separated by its tag. */
export function rosterBytes(doc: Omit<RosterDoc, 'sig'>): Uint8Array {
  return encoder.encode(JSON.stringify([
    'orbital-roster-v4', doc.group, doc.version, doc.members.map((m) => [m.id, m.kind, m.addedAt, m.addedVersion]),
    doc.dissolved === true,
  ]));
}

/** The bytes a description's signer signs. */
export function descriptionBytes(d: Omit<Description, 'sig'>): Uint8Array {
  return encoder.encode(JSON.stringify(['orbital-description-v2', d.id, d.name, d.os, d.links, d.describedAt, d.by]));
}

/** The bytes a leaving member signs. */
export function leftBytes(n: Omit<LeftNotice, 'sig'>): Uint8Array {
  return encoder.encode(JSON.stringify(['orbital-left-v1', n.id, n.group, n.version, n.at]));
}

function signed(signer: Identity, bytes: Uint8Array): string {
  return toBase64Url(sign(signer.secretKey, bytes));
}

/** Good against the key `id` names, in its one canonical spelling (`signatureOf`). */
function checks(id: string, bytes: Uint8Array, signature: string): boolean {
  const key = publicKeyOf(id);
  const sig = signatureOf(signature);
  return key !== null && sig !== null && verify(key, bytes, sig);
}

const byId = <T extends { id: string }>(x: T, y: T) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * Whether a document is one the primary could have signed: members sorted
 * by id, each once and each a device id added at a version no later than
 * this one, the primary among them and not a phone, a dissolved one naming
 * the primary alone, and the primary's signature good.
 */
export function verifyRoster(doc: RosterDoc): boolean {
  const { members } = doc;
  for (let i = 1; i < members.length; i++) if (!(members[i - 1].id < members[i].id)) return false;
  if (members.some((m) => m.addedVersion > doc.version)) return false;
  const primary = members.find((m) => m.id === doc.group);
  if (!primary || primary.kind === 'phone') return false;
  if (doc.dissolved && members.length !== 1) return false;
  if (!members.every((m) => publicKeyOf(m.id) !== null)) return false;
  return checks(doc.group, rosterBytes(doc), doc.sig);
}

/** Signed by the device itself or by `group`'s primary, and good. */
export function verifyDescription(d: Description, group: string | null): boolean {
  if (d.by !== d.id && d.by !== group) return false;
  return checks(d.by, descriptionBytes(d), d.sig);
}

/** Signed by the device that left, which is not the primary (the primary leaving dissolves the group). */
export function verifyLeft(n: LeftNotice): boolean {
  return n.id !== n.group && checks(n.id, leftBytes(n), n.sig);
}

/**
 * Signatures checked here, by what was signed: a roster sent again costs no
 * check. Bounded; the oldest goes first.
 */
const VERIFIED_CACHE_MAX = 1024;
const verified = new Map<string, true>();

function verifiedOnce(key: string, check: () => boolean): boolean {
  if (verified.has(key)) {
    verified.delete(key);
    verified.set(key, true);
    return true;
  }
  if (!check()) return false;
  verified.set(key, true);
  if (verified.size > VERIFIED_CACHE_MAX) verified.delete(verified.keys().next().value!);
  return true;
}

const named = (doc: RosterDoc, id: string) => doc.members.some((m) => m.id === id);

/** Each part in a fixed order, so the same part reads the same whatever its keys' order. */
const docKey = (d: RosterDoc) => [
  d.group, d.version, d.members.map((m) => [m.id, m.kind, m.addedAt, m.addedVersion]), d.dissolved === true, d.sig,
];
const descriptionKey = (d: Description) => JSON.stringify([d.id, d.name, d.os, d.links, d.describedAt, d.by, d.sig]);
const leftKey = (n: LeftNotice) => [n.id, n.group, n.version, n.at, n.sig];

/**
 * A left notice holds while no version names its device as added above the
 * notice's version: a later version that merely still names it (signed
 * before the primary heard of the notice) does not void it; adding the
 * device again does. Only for this group, and only while the document names
 * the device: once the primary leaves it out, the notice has nothing left to say.
 */
function holds(doc: RosterDoc, n: LeftNotice): boolean {
  if (doc.dissolved || n.group !== doc.group || n.id === doc.group) return false;
  const member = doc.members.find((m) => m.id === n.id);
  return member !== undefined && member.addedVersion <= n.version;
}

/** Of two descriptions of one device: the device's own over the primary's, then the later, then the larger. */
function better(a: Description, b: Description): Description {
  const ownA = a.by === a.id;
  const ownB = b.by === b.id;
  if (ownA !== ownB) return ownB ? b : a;
  if (a.describedAt !== b.describedAt) return b.describedAt > a.describedAt ? b : a;
  return descriptionKey(b) > descriptionKey(a) ? b : a;
}

/**
 * What a state keeps once its document is known: one description per
 * member, signed by the member or this group's primary; one left notice per
 * member while it holds (the highest version); nothing at all without a
 * document. Sorted by id, so one state reads one way. No signature is
 * checked here.
 */
export function normalize(state: RosterState): RosterState {
  const doc = state.roster;
  if (!doc) return EMPTY_ROSTER;
  const descriptions = new Map<string, Description>();
  for (const d of state.descriptions) {
    if (!named(doc, d.id) || (d.by !== d.id && d.by !== doc.group)) continue;
    const held = descriptions.get(d.id);
    descriptions.set(d.id, held ? better(held, d) : d);
  }
  const left = new Map<string, LeftNotice>();
  for (const n of state.left) {
    if (!holds(doc, n)) continue;
    const held = left.get(n.id);
    if (!held || n.version > held.version || (n.version === held.version && n.sig > held.sig)) left.set(n.id, n);
  }
  return { roster: doc, descriptions: [...descriptions.values()].sort(byId), left: [...left.values()].sort(byId) };
}

/** The ids the group holds now: the document's members, less those whose notice holds. */
export function memberIds(state: RosterState): string[] {
  const doc = state.roster;
  if (!doc || doc.dissolved) return [];
  const gone = new Set(state.left.filter((n) => holds(doc, n)).map((n) => n.id));
  return doc.members.filter((m) => !gone.has(m.id)).map((m) => m.id);
}

/**
 * Every member the group holds now, with its best description. A member
 * with none (never the case once the primary added it) reads by its id.
 */
export function rosterMembers(state: RosterState): MemberView[] {
  const doc = state.roster;
  if (!doc) return [];
  const ids = new Set(memberIds(state));
  const about = new Map<string, Description>();
  for (const d of state.descriptions) {
    if (d.by !== d.id && d.by !== doc.group) continue;
    const held = about.get(d.id);
    about.set(d.id, held ? better(held, d) : d);
  }
  return doc.members.filter((m) => ids.has(m.id)).map((m) => {
    const d = about.get(m.id);
    return {
      ...m, name: d?.name ?? m.id.slice(0, 8), os: d?.os ?? '', links: d?.links ?? false, primary: m.id === doc.group,
    };
  });
}

/** The best description of `id` held, or null. */
export function descriptionOf(state: RosterState, id: string): Description | null {
  const group = state.roster?.group ?? null;
  const all = state.descriptions.filter((d) => d.id === id && (d.by === id || d.by === group));
  return all.length === 0 ? null : all.reduce(better);
}

export type TakeOptions = {
  /** This device. */
  self: string;
  /**
   * The group this device belongs to, or is joining by a ceremony, kept
   * apart from the document (`GroupStorage.groupId`): it takes a document of
   * that group's primary even while it holds none (one it stored was
   * dropped). Null: it holds no group, and may take another group's
   * document that names it, from a primary paired here.
   */
  groupId: string | null;
  /** Whether this device holds a pair with `id`. */
  paired: (id: string) => boolean;
  /** `incoming` was written or checked here already: no signature is checked again. */
  trusted?: boolean;
};

/**
 * `held` with what it takes of `incoming`, normalized. The document only
 * when signed by the primary of the group held and of a higher version; or
 * by the primary of this device's group (`groupId`) while it holds no
 * document of that group; or, while this device has no group at all, one of
 * another group that names it, not dissolved, whose primary is another
 * device paired here. Then each
 * description and left notice that verifies and that the document leaves
 * room for (`normalize`). Whichever device passed it on, the rule is the same.
 */
export function takeRoster(held: RosterState, incoming: RosterState, opts: TakeOptions): RosterState {
  const ok = (key: string, check: () => boolean) => opts.trusted === true || verifiedOnce(key, check);
  let doc = held.roster;
  const theirs = incoming.roster;
  if (theirs && ok(`r${JSON.stringify(theirs)}`, () => verifyRoster(theirs))) {
    if (doc && theirs.group === doc.group) {
      if (theirs.version > doc.version) doc = theirs;
    } else if (opts.groupId !== null) {
      if (theirs.group === opts.groupId) doc = theirs;
    } else if (!theirs.dissolved && theirs.group !== opts.self && named(theirs, opts.self) && opts.paired(theirs.group)) {
      doc = theirs;
    }
  }
  if (!doc) return EMPTY_ROSTER;
  const base = normalize({ ...held, roster: doc });
  const descriptions = [...base.descriptions];
  for (const d of incoming.descriptions) {
    if (!named(doc, d.id) || (d.by !== d.id && d.by !== doc.group)) continue;
    const i = descriptions.findIndex((x) => x.id === d.id);
    if (i >= 0 && better(descriptions[i], d) === descriptions[i]) continue;
    if (!ok(`d${JSON.stringify(d)}`, () => verifyDescription(d, doc.group))) continue;
    if (i >= 0) descriptions[i] = d;
    else descriptions.push(d);
  }
  const left = [...base.left];
  for (const n of incoming.left) {
    if (!holds(doc, n) || left.some((x) => x.id === n.id && x.version >= n.version)) continue;
    if (ok(`l${JSON.stringify(n)}`, () => verifyLeft(n))) left.push(n);
  }
  return normalize({ roster: doc, descriptions, left });
}

/** The whole state as one string: what a store compares to tell a change. */
export function rosterKey(state: RosterState): string {
  const s = normalize(state);
  return JSON.stringify([s.roster && docKey(s.roster), s.descriptions.map(descriptionKey), s.left.map(leftKey)]);
}

/** What two members compare: a hash of everything they hold of the group. */
export function rosterDigest(state: RosterState): string {
  return bytesToHex(sha256(encoder.encode(rosterKey(state))));
}

/** A member as an add names it: the kind the pairing proved. */
export type NewMember = Pick<RosterMember, 'id' | 'kind'>;

function signRoster(signer: Identity, doc: Omit<RosterDoc, 'sig'>): RosterDoc {
  const members = [...doc.members].sort(byId);
  const unsigned = doc.dissolved ? { ...doc, members, dissolved: true as const } : { group: doc.group, version: doc.version, members };
  return { ...unsigned, sig: signed(signer, rosterBytes(unsigned)) };
}

/**
 * Version 1 of a new group, signed by its founder, which is its primary:
 * the founder and `others`. When the founder held a document of its own
 * (a group it dissolved, or one it emptied), the version goes on from it,
 * so a member asleep since then takes the new one. Null for a phone, which
 * is never primary, or past `ROSTER_MAX_ENTRIES`.
 */
export function foundRoster(
  signer: Identity, kind: string, others: NewMember[], now: number, previous: RosterDoc | null = null,
): RosterDoc | null {
  const group = deviceId(signer.publicKey);
  if (kind === 'phone') return null;
  const ids = new Set([group]);
  const version = previous && previous.group === group ? previous.version + 1 : 1;
  if (version > ROSTER_MAX_VERSION) return null;
  const members: RosterMember[] = [{ id: group, kind, addedAt: now, addedVersion: version }];
  for (const o of others) {
    if (ids.has(o.id)) continue;
    ids.add(o.id);
    members.push({ id: o.id, kind: o.kind, addedAt: now, addedVersion: version });
  }
  if (members.length > ROSTER_MAX_ENTRIES) return null;
  return signRoster(signer, { group, version, members });
}

/**
 * The next version, signed by the primary, with `add` named (a member
 * already named keeps its entry) and `remove` left out. Null when `signer`
 * is not this group's primary, the group was dissolved, the primary would
 * leave itself out, or a bound would be passed.
 */
export function nextRoster(
  doc: RosterDoc, signer: Identity, change: { add?: NewMember[]; remove?: string[] }, now: number,
): RosterDoc | null {
  if (deviceId(signer.publicKey) !== doc.group || doc.dissolved) return null;
  const remove = new Set(change.remove ?? []);
  if (remove.has(doc.group)) return null;
  const members = doc.members.filter((m) => !remove.has(m.id));
  for (const a of change.add ?? []) {
    if (members.some((m) => m.id === a.id)) continue;
    members.push({ id: a.id, kind: a.kind, addedAt: now, addedVersion: doc.version + 1 });
  }
  if (members.length > ROSTER_MAX_ENTRIES || doc.version + 1 > ROSTER_MAX_VERSION) return null;
  return signRoster(signer, { group: doc.group, version: doc.version + 1, members });
}

/** The last version of a group whose primary left: it names the primary alone. Null as `nextRoster`. */
export function dissolveRoster(doc: RosterDoc, signer: Identity): RosterDoc | null {
  if (deviceId(signer.publicKey) !== doc.group || doc.dissolved || doc.version + 1 > ROSTER_MAX_VERSION) return null;
  const primary = doc.members.filter((m) => m.id === doc.group);
  return signRoster(signer, { group: doc.group, version: doc.version + 1, members: primary, dissolved: true });
}

/**
 * `id` described by `signer` (the device itself, or its primary). Later
 * than `previous` by the same signer even on a clock that went back, so the
 * newer word wins everywhere.
 */
export function describeDevice(
  id: string, about: RosterAbout, signer: Identity, now: number, previous: Description | null = null,
): Description {
  const by = deviceId(signer.publicKey);
  const describedAt = previous && previous.by === by ? Math.max(now, previous.describedAt + 1) : now;
  const unsigned = { id, name: about.name, os: about.os, links: about.links, describedAt, by };
  return { ...unsigned, sig: signed(signer, descriptionBytes(unsigned)) };
}

/** `signer`'s notice that it left the group of `doc`, at the version it holds. */
export function leftNotice(signer: Identity, doc: RosterDoc, now: number): LeftNotice {
  const unsigned = { id: deviceId(signer.publicKey), group: doc.group, version: doc.version, at: now };
  return { ...unsigned, sig: signed(signer, leftBytes(unsigned)) };
}
