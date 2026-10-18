/**
 * The phone as a member of its group (spec 2026-10-16-device-group-design
 * § 5, § 12): one relay socket (`RelayLink`), a channel to every device this
 * phone is paired with (the phone always initiates), the roster kept here and
 * synced over those channels (`GroupMember`), a link with every live member
 * through `/pair/mutual`, and both pairing ceremonies (`PairingCeremony`) —
 * joining by any member's code, and adding a device by showing its own.
 * `RemoteClient` (one Mac) stays for what still uses it.
 *
 * This file exposes the channels; merging what they carry is the caller's.
 * No DOM and no Node: the WebSocket, fetch and storage are injected. Nothing
 * here throws into a caller's event loop: a frame from a device that is not
 * paired is dropped and counted (`dropped`), a listener that throws is its
 * own problem.
 */
import { z } from 'zod';
import { Channel, TUNNEL_SILENCE_TIMEOUT_MS, type ByeReason, type ChannelEvent, type OwnHello } from './channel.js';
import {
  PairingCeremony, type CeremonyState, type JoinResult, type PairConfirmResult, type PendingPair,
  type StartPairingResult,
} from './ceremony.js';
import { osName, type Capability } from './device.js';
import {
  GroupMember, type GroupStorage, type MemberRow, type PairedDevice, type RemoveResult, type SelfAbout,
} from './group.js';
import { publicKeyOf, type Identity } from './keys.js';
import type { HelloMessage } from './messages.js';
import { PAIR_NAME_MAX_CHARS } from './relayApi.js';
import { RelayLink, type LinkStatus, type RelayLinkEvent, type SocketConstructor } from './relayLink.js';
import { ROSTER_KIND_MAX_CHARS, RosterSchema, isLive, rosterDigest, type RosterEntry } from './roster.js';
import type { RelayTooOld } from './version.js';

/**
 * How long a phone in a group stays with no pair at the relay and no
 * channel up, after it asked every live member for a mutual pair, before it
 * says no member can reach it (`unreachable`). Long enough for members that
 * are up to answer, and for a relay that lost its pairs to form them again.
 */
export const ALONE_GRACE_MS = 2 * 60_000;

/**
 * What the group phone names in its hello. `group` makes the other members
 * link with it and send it roster messages; it serves nothing, so no
 * `sessions`. `capabilitiesOf('phone')` stays `[]`: `RemoteClient` uses it
 * and must keep sending nothing new.
 */
export const GROUP_PHONE_CAPABILITIES: Capability[] = ['group'];

/** A paired device as the merge layer and the app see it. `online`: the relay's presence; `hello`: the last one, kept after its channel closes. */
export type PeerInfo = {
  id: string;
  name: string;
  kind: string | null;
  os: string;
  online: boolean;
  ready: boolean;
  hello: HelloMessage | null;
};

export type GroupClientEvent =
  | { type: 'status'; status: LinkStatus }
  /** A paired device's online, ready or hello changed; `peers()` says how. */
  | { type: 'peer'; peer: string }
  /** A channel was made, before it starts: the merge layer subscribes its topics here. */
  | { type: 'channel'; peer: string; channel: Channel }
  /** A hub frame from `peer`, verbatim. */
  | { type: 'hub'; peer: string; frame: unknown }
  /** A frame from `peer` with an empty body: its header flags (parent § 7). */
  | { type: 'wake'; peer: string; flags: number }
  /** `peer` ended its channel; `needed` with `app_too_old` is its `MIN_PHONE_VERSION`. */
  | { type: 'bye'; peer: string; reason: ByeReason; needed?: string }
  /** The roster, the members or a ceremony's state changed. */
  | { type: 'group' }
  /** A device redeemed this phone's code: the user types the code it shows. */
  | ({ type: 'pair_request' } & PendingPair)
  /** The device whose code this phone redeemed confirmed it. */
  | { type: 'joined'; peer: string }
  | { type: 'join_failed'; peer: string; reason: 'rejected' }
  /**
   * Every pair this phone held is gone and the roster holds no group for it
   * any more: the group removed it, or the relay dropped the pairs of a phone
   * with no other member that links (one Mac from before groups). Never for
   * its own `remove` or `leave`.
   */
  | { type: 'unpaired_all' }
  /**
   * Whether no member can reach this phone now (`GroupClient.unreachable`):
   * set after `ALONE_GRACE_MS` with no pair and no channel, cleared by any
   * pair or channel forming. Nothing is forgotten: the members may only be
   * asleep behind a relay that lost its pairs, or this phone was removed
   * while away and nobody can say so — the user decides.
   */
  | { type: 'unreachable'; unreachable: boolean }
  /**
   * The relay dropped every pair while the roster still lists members that
   * link: they may pair again through `/pair/mutual`. If none does within
   * `ALONE_GRACE_MS`, `unreachable` follows.
   */
  | { type: 'pairs_lost' }
  | { type: 'relay_error'; code: string }
  /** The relay is below `MIN_RELAY_VERSION`: the link has stopped; `recheck` or `start` tries again. */
  | ({ type: 'relay_too_old' } & RelayTooOld);

export type GroupClientOptions = {
  relayUrl: string;
  /** The relay's shared secret; absent for an open relay. */
  relaySecret?: string;
  identity: Identity;
  WebSocketImpl: SocketConstructor;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  /** What `hello` names this app as. */
  app: string;
  /** The phone's OS as `hello` names it (`osName` of the Capacitor platform). */
  os: string;
  /** This phone's name: in its hello, its roster entry, and sealed into a redeem. */
  name: string;
  /** Synchronous; the caller persists it after every `onStored`. */
  storage: GroupStorage;
  /** Called after any write to `storage`. */
  onStored?: () => void;
  now?: () => number;
  log?: (message: string) => void;
  reconnectDelayMs?: number;
  connectTimeoutMs?: number;
  silenceTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
};

export class GroupClient {
  private readonly opts: GroupClientOptions;
  private readonly storage: GroupStorage;
  private readonly link: RelayLink;
  private readonly group: GroupMember;
  private readonly ceremony: PairingCeremony;
  /** One per paired device that is online and reached; none while the socket is down. */
  private readonly channels = new Map<string, Channel>();
  /** The last hello of every paired device, kept after its channel closes; gone with the device. */
  private readonly hellos = new Map<string, HelloMessage>();
  private readonly listeners = new Set<(event: GroupClientEvent) => void>();
  /** Frames dropped here: from a device with no channel (not paired, or not reached). */
  private ownDropped = 0;
  private refusal: RelayTooOld | null = null;
  /** True while the user's own `remove` or `leave` runs: losing every pair then is what they asked for. */
  private deliberate = false;
  /** The group removed this phone and took its pairs: `unpaired_all` at the next change. */
  private removedFromGroup = false;
  /**
   * When the last relay `ok` was handled (the client's start before one). A
   * row added since may be missing from the next `ok.pairs` only because the
   * relay recorded it after it read them (a confirm in flight), so that `ok`
   * leaves it be; the one after decides.
   */
  private lastOkAt: number;
  /** When a frame last came from each peer: one quiet channel among others that talk is that peer's silence, not the socket's. */
  private readonly heardAt = new Map<string, number>();
  /** Runs while the relay holds no pair for a phone in a group (`ALONE_GRACE_MS`). */
  private aloneTimer: ReturnType<typeof setTimeout> | null = null;
  /** See `unreachable`. */
  private alone = false;
  /** Says `group` when this phone's code runs out: the ceremony drops it, and the request made with it, without a word. */
  private codeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The device the link's socket URL names now (`RelayLinkOptions.anchor`); null: this phone's own id. */
  private anchor: string | null;

  constructor(opts: GroupClientOptions) {
    this.opts = opts;
    this.lastOkAt = this.now();
    this.storage = persisting(opts.storage, () => this.stored());
    const paired = this.storage.paired.list();
    // The first paired device anchors the socket: with an old relay (no `ok.pairs`),
    // its `unpaired` on connect is how a phone revoked while away learns it.
    // A new first device takes over at the next connect (`reanchor`).
    this.anchor = paired[0]?.id ?? null;
    this.link = new RelayLink({
      relayUrl: opts.relayUrl, identity: opts.identity, WebSocketImpl: opts.WebSocketImpl, relaySecret: opts.relaySecret,
      ...(paired.length > 0 ? { anchor: paired[0].id, expectPaired: true } : {}),
      now: opts.now, fetchImpl: opts.fetchImpl, reconnectDelayMs: opts.reconnectDelayMs,
      connectTimeoutMs: opts.connectTimeoutMs,
    });
    this.group = new GroupMember(this.storage, {
      selfId: () => this.id,
      about: () => this.about(),
      knownId: () => this.id,
      relay: () => this.link,
      channels: () => this.channels,
      channel: (id) => this.channels.get(id) ?? null,
      open: (id) => this.open(id),
      paired: () => {},
      forget: (id) => this.forget(id),
      forgetAll: () => this.forgetAll(),
      changed: () => this.changed(),
      now: () => this.now(),
      log: (message) => this.log(message),
    });
    this.ceremony = new PairingCeremony({
      enabled: () => true,
      identity: () => opts.identity,
      relay: () => this.link,
      relayTooOld: () => this.refusal !== null,
      relayUrl: () => opts.relayUrl,
      relaySecret: () => opts.relaySecret ?? '',
      self: () => ({ name: this.about().name, platform: opts.os, kind: 'phone' }),
      inGroup: () => this.group.inGroup(),
      isLiveMember: (id) => this.group.isLiveMember(id),
      paired: this.storage.paired,
      pendingRevokes: this.storage.pendingRevokes,
      addPaired: (device, joined) => this.group.addPaired(device, joined),
      revokeCancelled: (id) => this.group.tryRoster('revoke a cancelled join', () => this.group.revokeAtRelay(id)),
      watch: () => {},
      abandon: (id) => this.drop(id),
      open: (id) => this.open(id),
      announce: (pending) => this.emit({ type: 'pair_request', ...pending }),
      changed: () => this.changed(),
      now: () => this.now(),
      log: (message) => this.log(message),
    });
    this.link.on((event) => this.onLink(event));
  }

  get id(): string {
    return this.link.id;
  }

  get status(): LinkStatus {
    return this.link.status;
  }

  /**
   * No member can reach this phone now: the relay holds no pair for it and
   * no channel is up, `ALONE_GRACE_MS` after it asked every member to pair.
   */
  get unreachable(): boolean {
    return this.alone;
  }

  /** Both versions while the relay is refused as too old; null otherwise. */
  get relayTooOld(): RelayTooOld | null {
    return this.refusal;
  }

  /** Frames dropped as unreadable or unwanted before they reached a channel, which counts its own. */
  get dropped(): number {
    return this.link.dropped + this.ownDropped;
  }

  get pendingPair(): CeremonyState['pendingPair'] {
    return this.ceremony.state().pendingPair;
  }

  get pairing(): CeremonyState['pairing'] {
    return this.ceremony.state().pairing;
  }

  get joining(): CeremonyState['joining'] {
    return this.ceremony.state().joining;
  }

  /** A request this phone's code refused without asking: another phone's. */
  get refusedPair(): CeremonyState['refused'] {
    return this.ceremony.state().refused;
  }

  on(listener: (event: GroupClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    this.refusal = null;
    this.group.tryRoster('add this phone to its roster', () => this.group.addSelf());
    this.link.start();
  }

  stop(): void {
    this.clearAlone();
    this.clearCodeTimer();
    this.group.stop();
    this.ceremony.reset();
    // The link's `off` closes every channel.
    this.link.stop();
  }

  /** One bounded presence check (every return to the foreground, a Retry): settles on `ok`, `relay_too_old` or the window. */
  recheck(windowMs: number): Promise<void> {
    this.refusal = null;
    return this.link.recheck(windowMs);
  }

  /** Kept and sent on every `ok` and again after `paired` (parent § 7). */
  pushToken(token: string): void {
    this.link.pushToken(token);
  }

  /** The channel to a paired device, while one is open. */
  channel(id: string): Channel | null {
    return this.channels.get(id) ?? null;
  }

  /** Every paired device, named as the roster names it. */
  peers(): PeerInfo[] {
    return this.storage.paired.list().map((d) => {
      const entry = this.storage.roster.entry(d.id);
      const live = entry !== null && isLive(entry) ? entry : null;
      return {
        id: d.id, name: live?.name ?? d.name, kind: live?.kind ?? d.kind, os: live?.os ?? osName(d.platform),
        online: this.link.peersOnline.has(d.id), ready: this.channels.get(d.id)?.ready === true,
        hello: this.hellos.get(d.id) ?? null,
      };
    });
  }

  /** The roster as Settings → Devices lists it; none when the storage cannot be read. */
  members(): MemberRow[] {
    try {
      return this.group.members(this.link.peersOnline);
    } catch (err) {
      this.log(`could not list the roster: ${message(err)}`);
      return [];
    }
  }

  /** See `GroupMember.inGroup`: this phone cannot join another group then. */
  inGroup(): boolean {
    return this.group.inGroup();
  }

  /** Shows this phone's code (`PairingCeremony.start`). */
  startPairing(): Promise<StartPairingResult> {
    return this.ceremony.start();
  }

  /** Answers the device that redeemed this phone's code (`PairingCeremony.confirm`). */
  confirmPairing(accept: boolean, device: string, code?: string): Promise<PairConfirmResult> {
    return this.ceremony.confirm(accept, device, code);
  }

  /** Redeems another member's code (`PairingCeremony.join`); `joined` or `join_failed` follows. */
  join(code: string): Promise<JoinResult> {
    return this.ceremony.join(code);
  }

  cancelJoin(): boolean {
    return this.ceremony.cancelJoin();
  }

  /** Removes a member from the group, on every member; this phone's own id is `leave`. */
  remove(id: string): Promise<RemoveResult> {
    return this.deliberately(() => this.group.remove(id));
  }

  /** This phone leaves its group; only while the relay is online. */
  leave(): Promise<RemoveResult> {
    return this.deliberately(() => this.group.leave());
  }

  /** The group writes the roster before its first await, so the flag covers every drop it makes. */
  private deliberately(run: () => Promise<RemoveResult>): Promise<RemoveResult> {
    this.deliberate = true;
    try {
      return run();
    } finally {
      this.deliberate = false;
    }
  }

  private onLink(event: RelayLinkEvent): void {
    try {
      this.onLinkEvent(event);
    } catch (err) {
      this.log(`could not handle the relay's ${event.type}: ${message(err)}`);
    }
  }

  private onLinkEvent(event: RelayLinkEvent): void {
    switch (event.type) {
      case 'status':
        // The link leaves `online` only when its socket went: every channel goes with it.
        if (event.status !== 'online') this.dropAll();
        this.emit({ type: 'status', status: event.status });
        // `online` follows `ok` at once: the relay's view is fresh, and the group may post now.
        if (event.status === 'online') {
          for (const d of this.storage.paired.list()) this.open(d.id);
          // Every live member was asked for a mutual pair here: the grace for being alone starts after.
          this.group.relayOk();
          this.watchAlone();
        }
        return;
      case 'ok': {
        // A relay that names every pair: a paired row it no longer holds is
        // gone, unless it was added after the previous `ok` (`lastOkAt`).
        const since = this.lastOkAt;
        this.lastOkAt = this.now();
        if (event.pairs) {
          const held = new Set(event.pairs);
          this.unpaired(this.storage.paired.list().filter((d) => !held.has(d.id) && d.pairedAt < since).map((d) => d.id));
        }
        return;
      }
      case 'presence':
        if (!this.storage.paired.get(event.peer)) return;
        // Online: a channel with keys is stale, the peer's sessions died with its socket.
        if (event.online) this.open(event.peer, true);
        else this.drop(event.peer);
        this.emit({ type: 'peer', peer: event.peer });
        return;
      case 'paired':
        this.reached();
        // The device whose code this phone redeemed; a cancelled join is revoked and never added.
        if (this.ceremony.onPaired(event.mac) && this.storage.paired.get(event.mac)) {
          this.emit({ type: 'joined', peer: event.mac });
        }
        return;
      case 'rejected':
        if (this.ceremony.onRejected(event.mac)) this.emit({ type: 'join_failed', peer: event.mac, reason: 'rejected' });
        return;
      case 'pair_request':
        this.ceremony.onPairRequest(event);
        return;
      case 'linked':
        this.reached();
        this.group.relayLinked(event.peer);
        return;
      case 'unpaired':
        // The relay's word changes the pairs, not the roster: a removal comes from the group.
        this.unpaired([event.mac]);
        return;
      case 'relay_error':
        this.emit({ type: 'relay_error', code: event.code });
        return;
      case 'relay_too_old':
        this.refusal = { relayVersion: event.relayVersion, needed: event.needed };
        this.emit(event);
        return;
      case 'frame': {
        const channel = this.channels.get(event.peer);
        if (channel) {
          this.heardAt.set(event.peer, this.now());
          channel.receive(event.body);
        } else this.ownDropped++;
        return;
      }
      case 'wake':
        if (this.storage.paired.get(event.peer)) {
          this.heardAt.set(event.peer, this.now());
          this.emit({ type: 'wake', peer: event.peer, flags: event.flags });
        } else this.ownDropped++;
        return;
    }
  }

  /**
   * Opens the channel to a paired device that is online. One handshake at a
   * time: a channel still waiting for its reply is that handshake, retrying
   * on its own. `cameBack`: the relay says the peer reconnected, so a channel
   * with keys is stale and replaced.
   */
  private open(id: string, cameBack = false): void {
    if (this.link.status !== 'online' || !this.link.peersOnline.has(id)) return;
    const device = this.storage.paired.get(id);
    if (!device) return;
    // Another phone initiates too: no handshake between the two would ever be answered.
    if ((this.storage.roster.entry(id)?.kind ?? device.kind) === 'phone') return;
    const existing = this.channels.get(id);
    if (existing && (!existing.keyed || !cameBack)) return;
    const peerKey = publicKeyOf(id);
    if (!peerKey) return;
    this.drop(id);
    const channel = new Channel({
      identity: this.opts.identity,
      peerKey,
      role: 'initiator',
      hello: this.hello(),
      send: (body) => this.link.send(peerKey, body),
      handshakeTimeoutMs: this.opts.handshakeTimeoutMs,
      requestTimeoutMs: this.opts.requestTimeoutMs,
      silenceTimeoutMs: this.opts.silenceTimeoutMs,
    });
    channel.on((event) => this.onChannel(id, channel, event));
    this.channels.set(id, channel);
    this.emit({ type: 'channel', peer: id, channel });
    channel.start();
  }

  /** What a current channel says; a replaced or dropped one says nothing. */
  private onChannel(id: string, channel: Channel, event: ChannelEvent): void {
    if (this.channels.get(id) !== channel) return;
    switch (event.type) {
      case 'hello':
        this.hellos.set(id, event.hello);
        this.group.onPeerHello(id, channel, event.hello);
        this.emit({ type: 'peer', peer: id });
        return;
      case 'ready':
        if (event.ready) {
          this.group.channelReady(channel);
          this.reached();
        }
        this.emit({ type: 'peer', peer: id });
        return;
      case 'hub':
        this.emit({ type: 'hub', peer: id, frame: event.frame });
        return;
      case 'group':
        this.group.onGroup(id, channel, event.msg);
        return;
      case 'bye':
        // The peer ended these keys. A member that removed this phone said so
        // in the roster first; the pair itself goes by the relay's `unpaired`.
        this.drop(id);
        this.emit({ type: 'bye', peer: id, reason: event.reason, ...(event.needed !== undefined ? { needed: event.needed } : {}) });
        return;
      case 'silent':
        this.drop(id);
        // Another peer spoke within the window: the socket carries frames, so only that peer
        // went quiet and its channel starts over. Otherwise the socket is likely half-open
        // (a network handover, a NAT timeout) and only a new one helps: every channel re-handshakes.
        if (this.heardFromOthers(id)) this.open(id);
        else this.link.reconnect();
        return;
      case 'closed':
        this.channels.delete(id);
        this.emit({ type: 'peer', peer: id });
        return;
    }
  }

  private heardFromOthers(id: string): boolean {
    const since = this.now() - (this.opts.silenceTimeoutMs ?? TUNNEL_SILENCE_TIMEOUT_MS);
    return [...this.heardAt].some(([peer, at]) => peer !== id && at > since);
  }

  /**
   * Starts the wait for being alone when the relay named no pair at all for
   * this phone, the roster still puts it in a group and no channel is up;
   * ends it otherwise. A relay that names no pairs (an old one) never starts it.
   */
  private watchAlone(): void {
    const pairs = this.link.pairs;
    const alone = pairs !== null && pairs.size === 0 && this.grouped() && ![...this.channels.values()].some((c) => c.ready);
    if (!alone) {
      // The relay names a pair: a member reaches this phone again, and the card goes.
      if (pairs !== null && pairs.size > 0) this.reached();
      else this.clearAlone();
      return;
    }
    if (this.aloneTimer || this.alone) return;
    this.aloneTimer = setTimeout(() => {
      this.aloneTimer = null;
      // A socket down now says nothing new: the next `ok` looks again.
      if (this.link.status !== 'online') return;
      const pairs = this.link.pairs;
      if (pairs === null || pairs.size > 0 || !this.grouped() || [...this.channels.values()].some((c) => c.ready)) return;
      this.alone = true;
      this.log('no pair formed with any member: unreachable');
      this.emit({ type: 'unreachable', unreachable: true });
    }, ALONE_GRACE_MS);
  }

  /** A pair formed (a relay that lost its pairs forms them again), or a channel: a member reaches this phone. */
  private reached(): void {
    this.clearAlone();
    if (!this.alone) return;
    this.alone = false;
    this.emit({ type: 'unreachable', unreachable: false });
  }

  private clearAlone(): void {
    if (this.aloneTimer) clearTimeout(this.aloneTimer);
    this.aloneTimer = null;
  }

  /** One timer for this phone's open code, at its expiry; it reads the state again, which drops the code. */
  private watchCode(): void {
    this.clearCodeTimer();
    const pairing = this.ceremony.state().pairing;
    if (!pairing) return;
    this.codeTimer = setTimeout(() => {
      this.codeTimer = null;
      this.changed();
    }, Math.max(0, pairing.expiresAt - this.now()));
  }

  private clearCodeTimer(): void {
    if (this.codeTimer) clearTimeout(this.codeTimer);
    this.codeTimer = null;
  }

  /** The first paired device anchors the next socket; none left, this phone's own id. */
  private reanchor(): void {
    const first = this.storage.paired.list()[0]?.id ?? null;
    if (first === this.anchor) return;
    this.anchor = first;
    this.link.setAnchor(first, true);
  }

  /** Ends one channel (not the relay link): everything waiting on it fails with `lost`. */
  private drop(id: string): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    // Forgotten first, so what the closing channel says is not taken for the next one's.
    this.channels.delete(id);
    channel.close();
    this.emit({ type: 'peer', peer: id });
  }

  private dropAll(): void {
    for (const id of [...this.channels.keys()]) this.drop(id);
  }

  /**
   * Pairs the relay no longer holds: their channels and rows go. Every one
   * gone: `unpaired_all` when the roster holds no group for this phone,
   * `pairs_lost` when it does.
   */
  private unpaired(ids: string[]): void {
    const had = this.storage.paired.list().length > 0;
    let changed = false;
    for (const id of ids) {
      if (!this.storage.paired.get(id)) continue;
      this.drop(id);
      this.hellos.delete(id);
      this.heardAt.delete(id);
      this.storage.paired.remove(id);
      changed = true;
    }
    if (!changed) return;
    this.changed();
    if (had && this.storage.paired.list().length === 0) this.emit({ type: this.grouped() ? 'pairs_lost' : 'unpaired_all' });
  }

  /** A member dropped by the group, after it was told so. */
  private forget(id: string): void {
    const channel = this.channels.get(id);
    this.channels.delete(id);
    channel?.close('revoked');
    this.hellos.delete(id);
    this.emit({ type: 'peer', peer: id });
  }

  /** This phone left its group: every channel closed with `revoked`; the group removes every row next. */
  private forgetAll(): void {
    if (!this.deliberate && this.storage.paired.list().length > 0) this.removedFromGroup = true;
    const channels = [...this.channels];
    this.channels.clear();
    for (const [id, channel] of channels) {
      channel.close('revoked');
      this.emit({ type: 'peer', peer: id });
    }
    this.hellos.clear();
    this.heardAt.clear();
  }

  private changed(): void {
    this.watchCode();
    this.emit({ type: 'group' });
    if (this.removedFromGroup && this.storage.paired.list().length === 0 && !this.grouped()) {
      this.removedFromGroup = false;
      this.emit({ type: 'unpaired_all' });
    }
  }

  /**
   * Whether the roster still makes this phone part of a group: its own entry
   * live and another live member that links. Unlike `inGroup`, a paired
   * device that does not link counts for nothing here.
   */
  private grouped(): boolean {
    try {
      const entries = this.storage.roster.list();
      const own = entries.find((e) => e.id === this.id);
      return (own === undefined || isLive(own)) && entries.some((e) => e.id !== this.id && isLive(e) && e.links);
    } catch {
      return false;
    }
  }

  private hello(): OwnHello {
    const about = this.about();
    return { app: this.opts.app, kind: 'phone', os: about.os, name: about.name, capabilities: GROUP_PHONE_CAPABILITIES };
  }

  /** Cut to the bounds a roster entry and a hello are read within. */
  private about(): SelfAbout {
    return {
      kind: 'phone', name: this.opts.name.slice(0, PAIR_NAME_MAX_CHARS),
      os: this.opts.os.slice(0, ROSTER_KIND_MAX_CHARS), links: true,
    };
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private log(text: string): void {
    (this.opts.log ?? ((m: string) => console.warn(`[group] ${m}`)))(text);
  }

  private stored(): void {
    this.reanchor();
    try {
      this.opts.onStored?.();
    } catch (err) {
      this.log(`could not persist the group: ${message(err)}`);
    }
  }

  private emit(event: GroupClientEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a listener's bug is its own; the protocol carries on */
      }
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `storage` with `stored` called after every write that changed something. */
function persisting(storage: GroupStorage, stored: () => void): GroupStorage {
  return {
    roster: {
      list: () => storage.roster.list(),
      entry: (id) => storage.roster.entry(id),
      digest: () => storage.roster.digest(),
      replace: (entries) => {
        const changed = storage.roster.replace(entries);
        if (changed) stored();
        return changed;
      },
    },
    paired: {
      list: () => storage.paired.list(),
      get: (id) => storage.paired.get(id),
      add: (device) => {
        storage.paired.add(device);
        stored();
      },
      remove: (id) => {
        if (!storage.paired.get(id)) return;
        storage.paired.remove(id);
        stored();
      },
    },
    pendingRevokes: {
      list: () => storage.pendingRevokes.list(),
      add: (id) => {
        if (storage.pendingRevokes.list().includes(id)) return;
        storage.pendingRevokes.add(id);
        stored();
      },
      remove: (id) => {
        if (!storage.pendingRevokes.list().includes(id)) return;
        storage.pendingRevokes.remove(id);
        stored();
      },
    },
  };
}

/** The phone's group as the app persists it: `MemoryGroupStorage.toJSON`. */
export type StoredGroup = { roster: RosterEntry[]; paired: PairedDevice[]; pendingRevokes: string[] };

const PairedRow = z.object({
  id: z.string(), name: z.string(), platform: z.string(), kind: z.string().nullable(), pairedAt: z.number(),
  lastSeenAt: z.number().nullable().default(null),
});

/**
 * The phone's `GroupStorage`: in memory, written whole by the app after
 * every `onStored` (`toJSON`) and read back at start (`fromJSON`).
 */
export class MemoryGroupStorage implements GroupStorage {
  private entries: RosterEntry[] = [];
  private readonly devices = new Map<string, PairedDevice>();
  private readonly revokes = new Set<string>();

  readonly roster: GroupStorage['roster'] = {
    list: () => this.entries.map((e) => ({ ...e })),
    entry: (id) => {
      const e = this.entries.find((x) => x.id === id);
      return e ? { ...e } : null;
    },
    replace: (entries) => {
      if (rosterDigest(entries) === rosterDigest(this.entries)) return false;
      this.entries = [...entries].map((e) => ({ ...e })).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      return true;
    },
    digest: () => rosterDigest(this.entries),
  };

  readonly paired: GroupStorage['paired'] = {
    list: () => [...this.devices.values()].map((d) => ({ ...d })),
    get: (id) => {
      const d = this.devices.get(id);
      return d ? { ...d } : null;
    },
    // A row that exists keeps when it was last seen.
    add: (device) => {
      this.devices.set(device.id, { ...device, lastSeenAt: this.devices.get(device.id)?.lastSeenAt ?? null });
    },
    remove: (id) => {
      this.devices.delete(id);
    },
  };

  readonly pendingRevokes: GroupStorage['pendingRevokes'] = {
    list: () => [...this.revokes],
    add: (id) => {
      this.revokes.add(id);
    },
    remove: (id) => {
      this.revokes.delete(id);
    },
  };

  toJSON(): StoredGroup {
    return { roster: this.roster.list(), paired: this.paired.list(), pendingRevokes: this.pendingRevokes.list() };
  }

  /**
   * Nothing here throws: what does not read is left out. A paired row and a
   * revoke are read one by one, since losing one loses a pair; a roster that
   * does not read as a whole is empty, and the members send it again.
   */
  static fromJSON(value: unknown): MemoryGroupStorage {
    const storage = new MemoryGroupStorage();
    const parts = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    const roster = RosterSchema.safeParse(parts.roster);
    if (roster.success) storage.roster.replace(roster.data);
    for (const row of Array.isArray(parts.paired) ? parts.paired : []) {
      const d = PairedRow.safeParse(row);
      if (d.success && publicKeyOf(d.data.id)) storage.devices.set(d.data.id, d.data);
    }
    for (const id of Array.isArray(parts.pendingRevokes) ? parts.pendingRevokes : []) {
      if (typeof id === 'string' && publicKeyOf(id)) storage.revokes.add(id);
    }
    return storage;
  }
}
