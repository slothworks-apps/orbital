/**
 * The pairing ceremonies of a member (spec 2026-10-16-device-group-design
 * § 3, spec 2026-10-06-pairing-code-and-app-lock-design § 1): showing a code
 * and confirming the device that redeemed it by the six characters it
 * shows; redeeming another device's code and waiting for it to confirm.
 *
 * Who adds whom (ADR the-group-has-one-primary-device): the side in a group
 * of two or more stays its primary and adds the other; both in one, the
 * pairing is refused (`in_group`), unless the two are members of one group
 * (pairing by hand, which changes no roster). Both alone, the device showing
 * the code founds the group — or, when it is a phone or keeps no roster
 * (a Mac from before groups), the device that typed its code. A member that
 * is not its group's primary adds no device (`not_primary`). Each side learns
 * whether the other is in a group from the code (`QrPayload.group`) and the
 * sealed device (`PairingDevice.group`). The server and the phone run the same logic;
 * everything host-specific — identity, the relay, the paired store, the
 * group, channels and watchers — comes in through `CeremonyHost`. No DOM
 * and no Node.
 */
import { randomBytes } from '@noble/ciphers/utils.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { osName } from './device.js';
import type { GroupStorage, PrimaryRef } from './group.js';
import {
  concat, deviceId, fingerprint, formatFingerprint, fromBase64Url, normalizePairingCode, publicKeyOf, toBase64Url,
  type Identity,
} from './keys.js';
import {
  PAIRING_SECRET_BYTES, PAIRING_TOKEN_TTL_MS, PAIR_NAME_MAX_CHARS, openPairingDevice, pairingProof, parsePairingCode,
  sealPairingDevice, verifyPairingProof, type QrPayload, type RelayAction, type RelayToDevice,
} from './relayApi.js';
import type { LinkStatus } from './relayLink.js';
import type { RelayTooOld } from './version.js';

/**
 * Wrong pairing codes a request may be sent before it is rejected as if the
 * user had pressed Reject: enough for a typo, too few to guess 30 bits
 * (spec 2026-10-06-pairing-code-and-app-lock-design § 1).
 */
export const PAIR_CODE_ATTEMPTS = 3;

/**
 * What a phone is called whose name did not come sealed with its request:
 * a phone from before sealed devices, or a blob that does not open. It never
 * blocks the pairing — the code typed here is what authenticates (spec
 * 2026-10-08-relay-knows-no-names-design § 3).
 */
export const UNKNOWN_PHONE_NAME = 'Unknown phone';

const DEVICE_PROOF_TAG = new TextEncoder().encode('orbital-pair-device-v1');

/**
 * The proof of a redeem that carries a sealed device with its kind: the
 * pairing proof (`pairingProof`) made over the requester's key and a tag,
 * so the relay, which cannot make either, also cannot strip the device and
 * pass the request on as a shipped phone's. A requester sends it only to a
 * code that names a kind (a device from this release, which checks it); a
 * shipped phone sends the plain proof and no kind.
 */
export function devicePairingProof(secret: Uint8Array, requesterKey: Uint8Array): string {
  return toBase64Url(hmac(sha256, secret, concat(requesterKey, DEVICE_PROOF_TAG)));
}

/** Constant time over the whole string: a proof is a MAC, compare it as one. */
function sameProof(expected: string, proof: string): boolean {
  if (proof.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ proof.charCodeAt(i);
  return diff === 0;
}

/**
 * The answer to a pairing request. `no_pending`: nothing to answer, or a
 * different phone than the one asked about. `code_mismatch`: a wrong code,
 * the request still waits. `code_rejected`: the last wrong code, the request
 * was rejected. `relay_error`: the relay did not take the answer.
 * `group_full`: the roster holds `ROSTER_MAX_ENTRIES` already; the request
 * was rejected.
 */
export type PairConfirmResult =
  | { ok: true }
  | { error: 'no_pending' | 'code_rejected' | 'relay_error' | 'group_full' }
  | { error: 'code_mismatch'; attemptsLeft: number };

/**
 * The answer to joining another device by its code: that device and the
 * code the user types on it, or why not. `in_group`: this device is in a
 * group already and leaves it first. `peer_offline`: the device that showed
 * the code is not on the relay; `expiresAt` is the code's, when it says.
 * `other_relay`: the code names a relay this device is not on, `relay`.
 * `phone_to_phone`: this device is a phone and so is the one whose code it
 * is — a phone joins a group through a computer, never another phone.
 * `in_group`: both devices are in groups (of two or more) and not the same
 * one. `not_primary`: this device is a member of a group whose primary is
 * `primary`, and only the primary adds a device. `group_full`: this device
 * would add the other to a roster that holds `ROSTER_MAX_ENTRIES` already.
 */
export type JoinResult =
  | { device: string; name: string; code: string }
  | { error: 'bad_code' | 'disabled' | 'offline' | 'already_paired' | 'in_group' | 'relay_error' | 'relay_too_old' | 'group_full' }
  | { error: 'phone_to_phone' }
  | { error: 'not_primary'; primary: PrimaryRef }
  | { error: 'other_relay'; relay: string }
  | { error: 'peer_offline'; expiresAt?: number };

/**
 * The answer to showing a code: the QR's JSON and when it stops working, or
 * why not. `not_primary`: this device is a member that is not its group's
 * primary, which alone shows a code that adds a device; it shows one only
 * while a member waits to be paired by hand.
 */
export type StartPairingResult =
  | { qr: string; expiresAt: number }
  | { error: 'disabled' | 'offline' | 'relay_error' | 'relay_too_old' }
  | { error: 'not_primary'; primary: PrimaryRef };

/**
 * A device asking to pair, and how many wrong codes it may still be sent
 * before it is rejected. The code itself is not here: the user types it
 * from the device and this side compares.
 */
export type PendingPair = { phone: string; name: string; platform: string; kind: string; attemptsLeft: number };

/**
 * A device whose code this device redeemed and which has not confirmed
 * yet: `code` is what the user types on it, `expiresAt` when its code stops working,
 * `kind` its kind as its code named it (null from a code without one).
 */
export type Joining = { device: string; name: string; kind: string | null; code: string; expiresAt: number };

/**
 * A request the code on screen refused without asking the user, and why:
 * `phone_to_phone`, a phone asking to join a phone; `in_group`, a device in
 * another group; `not_primary`, a device that is no member, asking a member
 * that is not the primary. Kept until the next code.
 */
export type RefusedPair = { phone: string; name: string; error: 'phone_to_phone' | 'in_group' | 'not_primary' };

/** What a status shows of the ceremonies. */
export type CeremonyState = {
  pendingPair: PendingPair | null;
  pairing: { expiresAt: number } | null;
  joining: Joining | null;
  refused: RefusedPair | null;
};

/**
 * The relay connection as the ceremonies use it. `post` never rejects: a
 * relay that cannot be reached answers status 0; `relayTooOld` is set when
 * the answer came from a relay below `MIN_RELAY_VERSION`.
 */
export interface CeremonyRelay {
  readonly status: LinkStatus;
  /** `unsupported`: see `RelayPostResult`. */
  post<T>(path: string, action: RelayAction, payload: unknown): Promise<{
    status: number; body: T; relayTooOld?: RelayTooOld; unsupported?: boolean;
  }>;
}

/** This device as its code names it and as it seals itself into a redeem. */
export type CeremonySelf = { name: string; platform: string; kind: string };

export interface CeremonyHost {
  /** Whether the user has the remote on. */
  enabled(): boolean;
  /** This device's identity while it is loaded; null while the remote is off. */
  identity(): Identity | null;
  /** The relay connection; null while there is none. */
  relay(): CeremonyRelay | null;
  /** Whether the relay was refused as too old: no code is shown or redeemed through it. */
  relayTooOld(): boolean;
  /** The relay's URL as this device connects to it; it goes into the QR. */
  relayUrl(): string;
  /** The relay secret, empty when the relay needs none; it goes into the QR. */
  relaySecret(): string;
  /** Read fresh for every code and every redeem. */
  self(): CeremonySelf;
  /** See `GroupMember.inGroup`. */
  inGroup(): boolean;
  /** The primary of this device's group when this device is a member and not it (`GroupMember.notPrimary`); null otherwise. */
  notPrimary(): PrimaryRef | null;
  /** A member waits to be paired by hand (`GroupMember.byHandPending`): a member that is not primary may show a code for it. */
  byHand(): boolean;
  /** See `GroupMember.isLiveMember`. */
  isLiveMember(id: string): boolean;
  /** See `GroupMember.canAdd`. */
  canAdd(id: string): boolean;
  /** The relay pairs this device holds (`GroupStorage['paired']`). */
  paired: Pick<GroupStorage['paired'], 'get' | 'add' | 'remove'>;
  /** Pairs revoked here and not yet answered by the relay (`GroupStorage['pendingRevokes']`). */
  pendingRevokes: { remove(id: string): void };
  /**
   * A device paired here that this side adds: into the roster, by this
   * device as its primary, or founding a group (`GroupMember.addPaired`).
   * `links`: it proved its kind, so it is a device of this release, which
   * links; a shipped phone does not.
   */
  addPaired(device: { id: string; kind: string; name: string; os: string; links: boolean }): boolean;
  /** A pair that must not stand (a join the user cancelled, a device the roster cannot take): revoke it at the relay. */
  revokeCancelled(id: string): void;
  /** The adder paired a device: the host's own setup for a new pair (a phone's watcher). */
  watch(id: string): void;
  /** A pair added for a confirm the relay refused: its channel and the host's setup for it go. */
  abandon(id: string): void;
  /** Open the channel to `id` if this side opens it and it is online. */
  open(id: string): void;
  /** A device asks to pair: tell whoever shows the request. */
  announce(pending: PendingPair): void;
  /** Something a status shows changed. */
  changed(): void;
  now(): number;
  log(message: string): void;
}

export class PairingCeremony {
  /**
   * `code` is the fingerprint the phone shows; `attemptsLeft` counts down in
   * place, so the object stays the one a confirm in flight compares against.
   * `links`: the request proved a sealed kind (`devicePairingProof`).
   * `adds`: this side adds the device once it is confirmed; otherwise the
   * device adds this one (it is in a group, or this side cannot found one).
   */
  private pendingPair: (PendingPair & { code: string; links: boolean; adds: boolean }) | null = null;
  /** `secret` went into the QR and only there; a `pair_request` must prove it (`verifyPairingProof`). */
  private pairing: { expiresAt: number; secret: Uint8Array } | null = null;
  /**
   * A device whose code this device redeemed, until it confirms or refuses
   * (`paired`, `rejected`). `adds`: this side adds it once it confirms.
   */
  private joining: (Joining & { adds: boolean }) | null = null;
  /**
   * A join the user cancelled, until its code expires: the other device may
   * still confirm it, and the pair the relay then makes is revoked here.
   */
  private cancelledJoin: { device: string; expiresAt: number } | null = null;
  private refused: RefusedPair | null = null;

  private readonly host: CeremonyHost;

  // Plain fields, not parameter properties: the web app compiles this with `erasableSyntaxOnly`.
  constructor(host: CeremonyHost) {
    this.host = host;
  }

  /** Forgets every ceremony in progress: the remote stopped. */
  reset(): void {
    this.pendingPair = null;
    this.pairing = null;
    this.joining = null;
    this.cancelledJoin = null;
    this.refused = null;
  }

  /** What a status shows; an expired code and its request are cleared first. */
  state(): CeremonyState {
    this.pairingOpen();
    return {
      pendingPair: this.publicPendingPair(),
      pairing: this.pairing ? { expiresAt: this.pairing.expiresAt } : null,
      joining: this.joining && this.joining.expiresAt > this.host.now()
        ? {
          device: this.joining.device, name: this.joining.name, kind: this.joining.kind, code: this.joining.code,
          expiresAt: this.joining.expiresAt,
        } : null,
      refused: this.refused,
    };
  }

  /** The request as the status shows it: everything but the code. */
  private publicPendingPair(): PendingPair | null {
    if (!this.pendingPair) return null;
    const { code: _code, links: _links, adds: _adds, ...shown } = this.pendingPair;
    return shown;
  }

  /**
   * Also clears an expired code and the request made with it: neither may
   * outlive the code — the relay prunes the pending row past its expiry, so
   * a confirm would only fail there.
   */
  private pairingOpen(): boolean {
    if (this.pairing && this.pairing.expiresAt <= this.host.now()) {
      this.pairing = null;
      this.pendingPair = null;
    }
    return this.pairing !== null;
  }

  /** No code while the relay is too old: a phone could not pair through it anyway. */
  async start(): Promise<StartPairingResult> {
    if (this.host.relayTooOld()) return { error: 'relay_too_old' };
    const client = this.host.relay();
    const identity = this.host.identity();
    if (!this.host.enabled() || !client || !identity) return { error: 'disabled' };
    const primary = this.host.notPrimary();
    if (primary && !this.host.byHand()) return { error: 'not_primary', primary };
    if (client.status !== 'online') return { error: 'offline' };
    // No name: the relay knows none. The phone reads it from the QR.
    const res = await client.post<{ token: string; expiresAt: number }>('/pair/token', 'pair.token', {});
    // A relay that gives this device no answer on `/pair/token` cannot show its code either.
    if (res.relayTooOld || res.unsupported) return { error: 'relay_too_old' };
    if (res.status !== 200) return { error: 'relay_error' };
    const secret = randomBytes(PAIRING_SECRET_BYTES);
    this.pairing = { expiresAt: res.body.expiresAt, secret };
    this.pendingPair = null;
    this.refused = null;
    const self = this.host.self();
    const qr: QrPayload = {
      v: 1, relay: this.host.relayUrl(), mac: deviceId(identity.publicKey), name: self.name, token: res.body.token,
      secret: toBase64Url(secret), kind: self.kind, expiresAt: res.body.expiresAt,
    };
    const relaySecret = this.host.relaySecret();
    if (relaySecret) qr.relaySecret = relaySecret;
    if (this.host.inGroup()) qr.group = true;
    this.host.changed();
    return { qr: JSON.stringify(qr), expiresAt: res.body.expiresAt };
  }

  /**
   * A device redeemed the code on screen. Only while the user has a code on
   * screen, and only the first phone to redeem it: a second request must not
   * swap the code the user is typing from their phone.
   */
  onPairRequest(msg: Extract<RelayToDevice, { type: 'pair_request' }>): void {
    const identity = this.host.identity();
    if (!identity) return;
    if (!this.pairingOpen() || !this.pairing || this.pendingPair) return;
    const phoneKey = publicKeyOf(msg.phone);
    if (!phoneKey) return;
    // The relay could otherwise substitute a key of its own whose 30-bit
    // fingerprint it ground to match; only the phone that scanned the QR
    // holds the secret the proof is made with.
    const sealedKind = sameProof(devicePairingProof(this.pairing.secret, phoneKey), msg.proof);
    if (!sealedKind && !verifyPairingProof(this.pairing.secret, phoneKey, msg.proof)) {
      this.host.log(`ignored a pairing request from ${msg.phone.slice(0, 8)}: its proof does not match this code`);
      return;
    }
    // Only what the phone sealed with this code's secret: a plain name came from the relay.
    const device = msg.device === undefined ? null : openPairingDevice(this.pairing.secret, phoneKey, msg.device);
    // A proof that says a kind was sealed and no kind that opens: the relay took it out. A plain
    // proof is a shipped phone's, whatever a sealed blob beside it says.
    if (sealedKind && device?.kind === undefined) {
      this.host.log(`ignored a pairing request from ${msg.phone.slice(0, 8)}: its sealed device is missing`);
      return;
    }
    const kind = sealedKind ? device!.kind! : 'phone';
    const name = device?.name || UNKNOWN_PHONE_NAME;
    if (kind === 'phone' && this.host.self().kind === 'phone') {
      this.refuse(msg.phone, name, 'phone_to_phone');
      return;
    }
    // A member of this group pairs by hand, and the roster stays as it is.
    const member = this.host.isLiveMember(msg.phone);
    const theirGroup = sealedKind && device?.group === true;
    if (!member && this.host.notPrimary()) {
      this.refuse(msg.phone, name, 'not_primary');
      return;
    }
    if (!member && theirGroup && this.host.inGroup()) {
      this.refuse(msg.phone, name, 'in_group');
      return;
    }
    // In a group, this device (its primary) adds the newcomer; both alone, the device showing the code founds one.
    const adds = !member && (this.host.inGroup() || (!theirGroup && this.host.self().kind !== 'phone'));
    this.pendingPair = {
      phone: msg.phone, name, platform: device?.platform ?? '',
      kind, links: sealedKind, adds,
      code: fingerprint(identity.publicKey, phoneKey), attemptsLeft: PAIR_CODE_ATTEMPTS,
    };
    this.host.announce(this.publicPendingPair()!);
    this.host.changed();
  }

  /**
   * A request this code may not take (`RefusedPair`): it is rejected at the
   * relay without asking, so the other device hears `rejected`, and the
   * code is spent.
   */
  private refuse(phone: string, name: string, error: RefusedPair['error']): void {
    this.pairing = null;
    this.refused = { phone, name, error };
    this.host.log(`refused a pairing request from ${phone.slice(0, 8)}: ${error}`);
    this.host.changed();
    const client = this.host.relay();
    if (!client) return;
    void client.post('/pair/confirm', 'pair.confirm', { phone, accept: false }).then((res) => {
      if (res.status !== 200) this.host.log(`relay reject of ${phone.slice(0, 8)} failed: ${res.status}`);
    });
  }

  /**
   * `phone` is the request the user actually looked at, so a confirm never
   * applies to any other phone. An accept carries the `code` the user typed
   * from the phone; only that phone can show the code this request expects.
   * A wrong one tells the relay nothing until it is the last
   * (`PAIR_CODE_ATTEMPTS`): then the request is rejected, as Reject would.
   */
  async confirm(accept: boolean, phone: string, code?: string): Promise<PairConfirmResult> {
    const pending = this.pairingOpen() ? this.pendingPair : null;
    const client = this.host.relay();
    if (!pending || pending.phone !== phone || !client) return { error: 'no_pending' };
    if (accept && normalizePairingCode(code ?? '') !== pending.code) {
      pending.attemptsLeft -= 1;
      if (pending.attemptsLeft > 0) {
        this.host.changed();
        return { error: 'code_mismatch', attemptsLeft: pending.attemptsLeft };
      }
      // The request is over here whatever the relay answers: the device was
      // never added, and a phone the relay still holds as pending is dropped
      // there when the code expires.
      this.pendingPair = null;
      this.pairing = null;
      this.host.changed();
      const res = await client.post('/pair/confirm', 'pair.confirm', { phone: pending.phone, accept: false });
      if (res.status !== 200) this.host.log(`relay reject of ${pending.phone.slice(0, 8)} after wrong codes failed: ${res.status}`);
      return { error: 'code_rejected' };
    }
    // A roster at its bound takes no new device: the request is rejected, as Reject would.
    if (accept && pending.adds && !this.host.canAdd(pending.phone)) {
      this.pendingPair = null;
      this.pairing = null;
      this.host.changed();
      const res = await client.post('/pair/confirm', 'pair.confirm', { phone: pending.phone, accept: false });
      if (res.status !== 200) this.host.log(`relay reject of ${pending.phone.slice(0, 8)} in a full group failed: ${res.status}`);
      return { error: 'group_full' };
    }
    // The relay tells the phone `paired` before it answers this post, and a
    // phone handshakes the moment it hears that — so the device must exist
    // here first, or its handshake frame is dropped as from a stranger.
    const existed = this.host.paired.get(pending.phone) !== null;
    if (accept) {
      this.host.paired.add({
        id: pending.phone, name: pending.name, platform: pending.platform, kind: pending.kind, pairedAt: this.host.now(),
      });
      this.host.watch(pending.phone);
    }
    const res = await client.post('/pair/confirm', 'pair.confirm', { phone: pending.phone, accept });
    if (res.status !== 200) {
      // The relay never paired it: undo what was added above. A device that
      // was already paired before this confirm is not ours to remove.
      if (accept && !existed) {
        this.host.abandon(pending.phone);
        this.host.paired.remove(pending.phone);
      }
      return { error: 'relay_error' };
    }
    // Paired afresh: a revoke still waiting from an earlier removal must not undo it.
    if (accept) this.host.pendingRevokes.remove(pending.phone);
    // A stop/start during the post replaced the state; leave the new one be.
    if (this.pendingPair === pending) {
      this.pendingPair = null;
      this.pairing = null;
    }
    // The device adds this one when it is in a group, or when this side cannot found one: nothing to write here.
    if (accept && pending.adds && !this.host.addPaired({
      id: pending.phone, kind: pending.kind, name: pending.name, os: osName(pending.platform), links: pending.links,
    })) {
      // The roster could not take it after all (filled while the post was out): not half added,
      // the pair goes again here and at the relay.
      this.host.abandon(pending.phone);
      this.host.paired.remove(pending.phone);
      this.host.revokeCancelled(pending.phone);
      this.host.changed();
      return { error: 'group_full' };
    }
    this.host.changed();
    // A guard: the relay's `presence` for the new device, sent before it
    // answered the post, has normally opened the channel already (if this
    // side is the one that opens it); `open` does nothing then.
    if (accept) this.host.open(pending.phone);
    return { ok: true };
  }

  /**
   * Redeems another device's pairing code, as a phone does (spec
   * 2026-10-16-device-group-design § 3): the answer is the code the user
   * types on that device. The pair exists once it confirms (`paired`).
   */
  async join(code: string): Promise<JoinResult> {
    const qr = parsePairingCode(code);
    if (!qr) return { error: 'bad_code' };
    if (this.host.relayTooOld()) return { error: 'relay_too_old' };
    if (qr.kind === 'phone' && this.host.self().kind === 'phone') return { error: 'phone_to_phone' };
    // A code from a member of this device's own group is pairing by hand: no roster changes.
    const member = this.host.isLiveMember(qr.mac);
    if (!member) {
      // Only the primary adds a device.
      const primary = this.host.notPrimary();
      if (primary) return { error: 'not_primary', primary };
      // Groups do not merge: the side in a group stays its primary, and two groups never pair.
      if (this.host.inGroup() && qr.group === true) return { error: 'in_group' };
    }
    // This side adds the other when it is in a group, or when both are alone and the other is a phone
    // or keeps no roster (a Mac from before groups names no kind) — never as a phone, which is never primary.
    const adds = !member && this.host.self().kind !== 'phone'
      && (this.host.inGroup() || (qr.group !== true && (qr.kind === undefined || qr.kind === 'phone')));
    if (adds && !this.host.canAdd(qr.mac)) return { error: 'group_full' };
    const client = this.host.relay();
    const identity = this.host.identity();
    if (!this.host.enabled() || !client || !identity) return { error: 'disabled' };
    if (client.status !== 'online') return { error: 'offline' };
    const self = deviceId(identity.publicKey);
    if (qr.mac === self) return { error: 'bad_code' };
    if (this.host.paired.get(qr.mac)) return { error: 'already_paired' };
    // One relay per group (§ 4), and this device's socket is on its own.
    if (qr.relay.replace(/\/+$/, '') !== this.host.relayUrl().replace(/\/+$/, '')) return { error: 'other_relay', relay: qr.relay };
    const secret = fromBase64Url(qr.secret);
    // A code that names a kind is from a device of this release, which checks the proof that
    // binds the sealed kind; a Mac from before kinds checks only the plain one.
    const payload = {
      token: qr.token,
      proof: qr.kind !== undefined ? devicePairingProof(secret, identity.publicKey) : pairingProof(secret, identity.publicKey),
      device: sealPairingDevice(secret, identity.publicKey, { ...this.host.self(), ...(this.host.inGroup() ? { group: true } : {}) }),
    };
    // Cut as a pairing cuts a phone's name: the QR's is whatever that device was called.
    const name = qr.name.slice(0, PAIR_NAME_MAX_CHARS);
    const typed = formatFingerprint(fingerprint(publicKeyOf(qr.mac)!, identity.publicKey));
    // No code lives longer than `PAIRING_TOKEN_TTL_MS`, whatever it says;
    // one from before it carried its expiry is good for that long.
    const longest = this.host.now() + PAIRING_TOKEN_TTL_MS;
    const joining = {
      device: qr.mac, name, kind: qr.kind ?? null, code: typed, expiresAt: Math.min(qr.expiresAt ?? longest, longest), adds,
    };
    this.joining = joining;
    // Joining that device again: its confirm is wanted now.
    if (this.cancelledJoin?.device === qr.mac) this.cancelledJoin = null;
    this.host.changed();
    const res = await client.post('/pair/redeem', 'pair.redeem', payload);
    if (res.status !== 200) {
      // A cancel, or a stop/start, during the post replaced the state; leave the new one be.
      if (this.joining === joining) this.joining = null;
      this.host.changed();
      if (res.relayTooOld) return { error: 'relay_too_old' };
      if (res.status === 409) return qr.expiresAt === undefined ? { error: 'peer_offline' } : { error: 'peer_offline', expiresAt: qr.expiresAt };
      return { error: res.status === 404 ? 'bad_code' : 'relay_error' };
    }
    return { device: qr.mac, name, code: typed };
  }

  /**
   * Stops waiting for the device being joined; false when none was. The
   * relay is not told: the request it holds expires with the code. If the
   * other device confirms it before then, the pair is revoked (`cancelledJoin`).
   */
  cancelJoin(): boolean {
    if (!this.joining) return false;
    this.cancelledJoin = { device: this.joining.device, expiresAt: this.joining.expiresAt };
    this.joining = null;
    this.host.changed();
    return true;
  }

  /**
   * The relay's `paired` for `mac`; false when it is not the device being
   * joined nor a cancelled one, and the host handles it as before.
   *
   * The relay sends `paired` before it answers the other side's confirm,
   * and a `presence` for that side right after. If this side opens the
   * channel, it does so at that `presence` (here, only if the relay already
   * counted the peer online); if the confirming side does, it opens from
   * the `presence` the relay sends it for this side.
   */
  onPaired(mac: string): boolean {
    if (this.joining && mac === this.joining.device) {
      const joined = this.joining;
      this.joining = null;
      this.host.paired.add({ id: joined.device, name: joined.name, platform: '', kind: joined.kind, pairedAt: this.host.now() });
      // Paired afresh: a revoke still waiting from an earlier removal must not undo it.
      this.host.pendingRevokes.remove(joined.device);
      // This side adds the device, with the kind its code named; otherwise that device adds this
      // one, and its roster arrives over the channel. A roster that cannot take it undoes the pair.
      if (joined.adds && !this.host.addPaired({
        id: joined.device, kind: joined.kind ?? 'desktop', name: joined.name, os: '', links: joined.kind !== null,
      })) {
        this.host.abandon(joined.device);
        this.host.paired.remove(joined.device);
        this.host.revokeCancelled(joined.device);
        this.host.changed();
        return true;
      }
      this.host.changed();
      this.host.open(joined.device);
      return true;
    }
    // Confirmed on the other device after the user cancelled here: the pair goes again, the device is never added.
    if (this.cancelledJoin && mac === this.cancelledJoin.device) {
      const cancelled = this.cancelledJoin;
      this.cancelledJoin = null;
      if (cancelled.expiresAt > this.host.now()) this.host.revokeCancelled(cancelled.device);
      return true;
    }
    return false;
  }

  /** The relay's `rejected` for `mac`; false when it is not the device being joined. */
  onRejected(mac: string): boolean {
    if (!this.joining || mac !== this.joining.device) return false;
    this.joining = null;
    this.host.changed();
    return true;
  }
}
