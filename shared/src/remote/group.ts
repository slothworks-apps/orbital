/**
 * This device as a member of its group (spec 2026-10-16-device-group-design
 * § 2–§ 4): it keeps the roster, syncs it over its channels, links with
 * every live member through the relay's `/pair/mutual`, revokes pairs and
 * retries what failed, removes members and leaves. The server and the phone
 * run the same logic; everything host-specific — storage, the relay, the
 * channels, watchers, timers' owner — comes in through `GroupStorage` and
 * `GroupHost`. No DOM and no Node.
 */
import type { Channel } from './channel.js';
import { osName } from './device.js';
import { deviceId, type Identity } from './keys.js';
import type { GroupMessage, HelloMessage } from './messages.js';
import type { RelayAction } from './relayApi.js';
import type { LinkStatus } from './relayLink.js';
import {
  ROSTER_MAX_ENTRIES, addMember, describeMember, foundingEntry, hasDuplicateIds, isFounding, isLive, mayAdd, mergeRoster,
  removeMember, rosterDigest, rosterFields, shareable, type RosterEntry, type RosterFields,
} from './roster.js';

/**
 * How long a mutual pair the relay refused for its rate limit waits before it
 * is asked again, rather than only at the next relay `ok`.
 */
export const MUTUAL_RETRY_MS = 60_000;

/**
 * How long the group waits for the relay's answer to one post (a mutual
 * pair, a revoke) before it counts it as unanswered (status 0): a relay
 * that never answers must not hold a post, or the next one for that peer,
 * for ever.
 */
export const RELAY_POST_TIMEOUT_MS = 30_000;

/**
 * How Settings shows a member. `self`: this device. `online`/`offline`: a
 * member paired here, or a member this device does not link with
 * (`linksWith`: a phone paired with another member), by the relay's presence. `linking`: a member that links
 * and is not paired here yet; `notLinked`: one the relay cannot pair
 * (`pairByHand`), so only a pairing code links the two.
 */
export type MemberState = 'self' | 'online' | 'offline' | 'linking' | 'notLinked';

/** The answer to removing a device: `offline` when it is this device itself and the relay is not online (`leave`). */
export type RemoveResult = { ok: true } | { error: 'not_found' | 'offline' | 'failed' };

/**
 * A relay pair this device holds: the server's `remote_devices` row, as
 * much of it as the group reads. `kind` null: paired through the code of a
 * Mac from before kinds. `lastSeenAt`: when it was last on the relay.
 */
export type PairedDevice = {
  id: string; name: string; platform: string; kind: string | null; pairedAt: number; lastSeenAt: number | null;
};

/** A member row as Settings lists it, without the signatures; see `RemoteStatus['group']` on the server. */
export type MemberRow = RosterFields & {
  self: boolean; linked: boolean; online: boolean; pairByHand: boolean; state: MemberState; seenAt: number | null;
};

/** What this device says about itself in the roster. */
export type SelfAbout = Pick<RosterEntry, 'kind' | 'name' | 'os' | 'links'>;

/**
 * Where the group lives. Synchronous: the server's SQLite is, and the phone
 * keeps an in-memory copy it persists behind. Any call may throw (a database
 * already gone); the group catches where a write is on the way to something else.
 */
export interface GroupStorage {
  roster: {
    list(): RosterEntry[];
    entry(id: string): RosterEntry | null;
    /** Writes the whole roster; false when it is unchanged. */
    replace(entries: RosterEntry[]): boolean;
    digest(): string;
  };
  /** The relay pairs this device holds. `add` keeps a row's other fields when it exists. */
  paired: {
    list(): PairedDevice[];
    get(id: string): PairedDevice | null;
    add(device: Omit<PairedDevice, 'lastSeenAt'>): void;
    remove(id: string): void;
  };
  /** Pairs revoked here and not yet answered by the relay; kept across restarts. */
  pendingRevokes: { list(): string[]; add(id: string): void; remove(id: string): void };
}

/**
 * The relay connection as the group uses it. The host hands out the same
 * object for one connection's life, so an answer can tell it is stale.
 * `post` never rejects: a relay that cannot be reached answers status 0.
 */
export interface GroupRelay {
  readonly status: LinkStatus;
  /** `unsupported`: a relay too old to answer this device on that route at all (`RelayPostResult`). */
  post<T>(path: string, action: RelayAction, payload: unknown): Promise<{ status: number; body: T; unsupported?: boolean }>;
}

/** What the group needs of a channel. */
export type GroupChannel = Pick<Channel, 'sendGroup' | 'groups'>;

export interface GroupHost {
  /**
   * This device's identity, which signs what it writes in the roster,
   * whether or not the remote runs (a removal while it is off is written at
   * once); null when it never had one.
   */
  identity(): Identity | null;
  /**
   * What this device says about itself in the roster, cut to the bounds a
   * roster entry is read within: an entry past them would refuse the whole
   * roster on every other member.
   */
  about(): SelfAbout;
  /** This device's id whether or not the remote runs; null when it never had one. */
  knownId(): string | null;
  /** The relay connection; null while there is none. */
  relay(): GroupRelay | null;
  channels(): Iterable<[string, GroupChannel]>;
  channel(id: string): GroupChannel | null;
  /** A member just paired with this device: open its channel if this side opens it and it is online. */
  open(id: string): void;
  /** The relay paired a member here: the host's own setup for a new pair (a phone's watcher). */
  paired(id: string): void;
  /** A member dropped here: its channel closed with `revoked`, and the host's own state for it. */
  forget(id: string): void;
  /** This device left its group: every channel closed with `revoked`, and the host's state for every device. */
  forgetAll(): void;
  /** Something a status shows changed. */
  changed(): void;
  now(): number;
  log(message: string): void;
}

/**
 * Whether a device of `selfKind` links with `entry`: a member that links,
 * unless both are phones. Two phones each open every channel (`initiates`),
 * so a pair between them would never carry one: a phone never asks another
 * for a mutual pair, and it reads another phone as paired elsewhere.
 */
export function linksWith(selfKind: string, entry: Pick<RosterEntry, 'kind' | 'links'>): boolean {
  return entry.links && !(selfKind === 'phone' && entry.kind === 'phone');
}

/**
 * Whether `entries` holds a live member other than `self` that makes a
 * group: one that links, or one this device is not paired with (`paired`
 * holds the ids of every pair this device holds). A device paired here that
 * does not link (a shipped phone) makes no group: a device with only such
 * pairs keeps today's relay change and joins.
 */
function hasOtherGroupMember(entries: RosterEntry[], self: string | null, paired: Set<string>): boolean {
  return entries.some((e) => isLive(e) && e.id !== self && (e.links || !paired.has(e.id)));
}

export class GroupMember {
  /**
   * Members a mutual pair was asked for on this relay connection, and those
   * the relay could not pair (a relay from before `/pair/mutual`). Both are
   * replaced at every relay `ok`, so a reconnect, or an updated relay, asks again.
   */
  private mutualAsked = new Set<string>();
  private pairByHand = new Set<string>();
  /** Members the relay refused a mutual pair for its rate limit, asked again when `mutualRetry` fires. */
  private rateLimited = new Set<string>();
  /** The ask again `MUTUAL_RETRY_MS` after a rate limit; cleared by the next relay `ok` and by any stop. */
  private mutualRetry: ReturnType<typeof setTimeout> | null = null;
  /** Revokes posted to the relay and not answered yet; a removal waits for them before it answers. */
  private readonly revoking = new Set<Promise<void>>();
  /** Posts to the relay not answered yet, by `path` and peer: never two at once for one peer. */
  private readonly inFlight = new Set<string>();
  /** Set by the relay's first `ok` on a connection, cleared when it goes (`relayLost`): later ones ask nothing again. */
  private okHandled = false;

  private readonly storage: GroupStorage;
  private readonly host: GroupHost;

  // Plain fields, not parameter properties: the web app compiles this with `erasableSyntaxOnly`.
  constructor(storage: GroupStorage, host: GroupHost) {
    this.storage = storage;
    this.host = host;
  }

  /** This device's id, from the identity it signs with; null when it never had one. */
  private get ownId(): string | null {
    const identity = this.host.identity();
    return identity ? deviceId(identity.publicKey) : null;
  }

  /** The relay went away for good (the remote stopped): no retry fires after it. */
  stop(): void {
    this.clearMutualRetry();
    this.okHandled = false;
  }

  /** The relay connection went: the next `ok` is a new connection's. */
  relayLost(): void {
    this.okHandled = false;
  }

  /**
   * The relay said `ok`: a new connection. Asks again for every mutual pair
   * and posts every revoke the relay was not told yet — once per
   * connection: a relay that repeats `ok` on one socket gets nothing more.
   */
  relayOk(): void {
    if (this.okHandled) return;
    this.okHandled = true;
    const hadByHand = this.pairByHand.size > 0;
    this.mutualAsked = new Set();
    this.pairByHand = new Set();
    this.clearMutualRetry();
    if (hadByHand) this.host.changed();
    this.tryRoster('revoke what the relay was not told', () => {
      for (const id of this.storage.pendingRevokes.list()) this.revokeAtRelay(id);
    });
    // Paired members too: a pair the relay lost while this side kept its row forms again.
    this.tryRoster('link the group', () => this.link(true));
  }

  /** The relay said `linked`: the pair with `peer` exists. */
  relayLinked(peer: string): void {
    this.tryRoster('add a linked member', () => this.onLinked(peer));
  }

  /**
   * This device's name changed: its live entry is described afresh. False
   * when nothing was written (no identity yet, or the roster did not
   * change), so the caller publishes the status itself.
   */
  nameChanged(): boolean {
    return this.ownId !== null && this.setRoster(this.storage.roster.list());
  }

  /**
   * The member rows Settings lists: the roster's live members, `online` by
   * the relay's presence. Throws when the storage cannot be read.
   */
  members(online: ReadonlySet<string>): MemberRow[] {
    const self = this.host.knownId();
    const rows = new Map(this.storage.paired.list().map((d) => [d.id, d]));
    const selfKind = this.host.about().kind;
    return this.storage.roster.list().filter(isLive).map((e) => {
      const row = rows.get(e.id);
      const pairByHand = this.pairByHand.has(e.id);
      const state: MemberState = e.id === self ? 'self'
        : row || !linksWith(selfKind, e) ? (online.has(e.id) ? 'online' : 'offline')
          : pairByHand ? 'notLinked' : 'linking';
      return {
        ...rosterFields(e), self: e.id === self, linked: row !== undefined, online: online.has(e.id), pairByHand,
        state, seenAt: row?.lastSeenAt ?? null,
      };
    });
  }

  /**
   * Whether this device is in a group of two or more (`hasOtherGroupMember`):
   * it cannot join another group then, nor move to another relay. As the
   * status, a roster that cannot be read reads as a group of one.
   */
  inGroup(): boolean {
    try {
      return hasOtherGroupMember(
        this.storage.roster.list(), this.host.knownId(), new Set(this.storage.paired.list().map((d) => d.id)),
      );
    } catch (err) {
      this.host.log(`could not read the roster: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** A roster that cannot be read holds no one, as `inGroup` reads it. */
  isLiveMember(id: string): boolean {
    try {
      const entry = this.storage.roster.entry(id);
      return entry !== null && isLive(entry);
    } catch {
      return false;
    }
  }

  /**
   * Removes a member from the group, on every member (ADR
   * joining-one-member-joins-the-group): the roster marks it removed and
   * the removal is applied here at once, remote on or off. A device paired
   * before the roster existed gets its entry first. Telling the relay is
   * best effort on top — a device it still thinks is paired can reach
   * nothing here. `not_found` when `id` is neither a live member nor
   * paired. This device's own id is `leave`, with its refusal while offline.
   */
  async remove(id: string): Promise<RemoveResult> {
    const self = this.host.knownId();
    if (self !== null && id === self) return this.leave();
    const known = this.storage.roster.entry(id);
    const device = this.storage.paired.get(id);
    if (!(known && isLive(known)) && !device) return { error: 'not_found' };
    const identity = this.host.identity();
    if (identity) {
      this.tryRoster('remove a member', () => {
        const now = this.host.now();
        let roster = this.storage.roster.list();
        if (!known && device) {
          roster = addMember(roster, {
            id, kind: device.kind ?? 'phone', name: device.name, os: osName(device.platform), links: false,
          }, identity, now);
        }
        this.setRoster(removeMember(roster, id, identity, now));
      });
    }
    // Still paired: no identity to write the roster with, or an entry that was removed already.
    if (this.storage.paired.get(id)) {
      this.dropMember(id);
      this.host.changed();
    }
    await Promise.all([...this.revoking]);
    return { ok: true };
  }

  /**
   * This device leaves its group: removing it, from itself. Only while the
   * relay is online: the others hear of it over the channels and the pairs
   * go at the relay, and offline neither happens — the group of one written
   * next would overwrite the removal before it ever spread. `failed` when
   * the roster could not be written.
   */
  async leave(): Promise<RemoveResult> {
    const identity = this.host.identity();
    const relay = this.host.relay();
    if (identity === null || !relay || relay.status !== 'online') return { error: 'offline' };
    try {
      this.setRoster(removeMember(this.storage.roster.list(), deviceId(identity.publicKey), identity, this.host.now()));
    } catch (err) {
      this.host.log(`could not leave the group: ${err instanceof Error ? err.message : String(err)}`);
      return { error: 'failed' };
    }
    await Promise.all([...this.revoking]);
    return { ok: true };
  }

  /**
   * The only way the roster changes. This device's own live entry is
   * described afresh first, signed by itself, whenever it does not say
   * what this device says of itself (a new membership, a rename).
   * Unchanged, it does nothing: that is what ends an exchange between two
   * members once they agree. Changed, it applies what the change removed,
   * publishes the status and offers the new digest on every group channel
   * but `from`, the one the change came in on.
   */
  setRoster(next: RosterEntry[], from?: string): boolean {
    const before = new Map(this.storage.roster.list().map((e) => [e.id, e]));
    const described = this.describedSelf(next);
    // Never held: every roster this device sent would be refused whole, and removals would stop.
    if (described.length > ROSTER_MAX_ENTRIES) {
      this.host.log(`refused a roster of ${described.length} entries: past ${ROSTER_MAX_ENTRIES}`);
      return false;
    }
    if (!this.storage.roster.replace(described)) return false;
    this.applyRemovals(before);
    this.host.changed();
    const digest = this.storage.roster.digest();
    for (const [id, channel] of this.host.channels()) {
      if (id !== from) channel.sendGroup({ t: 'roster_digest', digest });
    }
    this.link();
    return true;
  }

  /** `entries` with this device's own live entry in its own words; the same array when it is already. */
  private describedSelf(entries: RosterEntry[]): RosterEntry[] {
    const identity = this.host.identity();
    if (!identity) return entries;
    const self = deviceId(identity.publicKey);
    const own = entries.find((e) => e.id === self);
    if (!own || !isLive(own)) return entries;
    const { kind, name, os, links } = this.host.about();
    const described = describeMember(entries, self, { name, os, links }, identity, this.host.now(), kind);
    if (described === entries && own.describedBy !== self) {
      this.host.log(`not describing this device under a membership as ${own.kind}: it is ${kind}`);
    }
    return described;
  }

  /**
   * Every entry this write removed: this device's own makes it leave the
   * group; another's drops that member here. An entry first heard of as
   * removed is dropped only when this device is paired with it. A live
   * member the write pruned (a removal froze the membership it stood on)
   * is dropped too when it is paired here: what is not in the roster is not
   * linked with.
   */
  private applyRemovals(before: Map<string, RosterEntry>): void {
    const self = this.host.knownId();
    const now = this.storage.roster.list();
    const removed = now.filter((e) => {
      const was = before.get(e.id);
      return !isLive(e) && (was === undefined || isLive(was));
    });
    if (self !== null && removed.some((e) => e.id === self)) {
      this.leaveGroup(self);
      return;
    }
    for (const e of removed) {
      if (before.has(e.id) || this.storage.paired.get(e.id)) this.dropMember(e.id);
    }
    const kept = new Set(now.map((e) => e.id));
    for (const [id, was] of before) {
      if (id !== self && isLive(was) && !kept.has(id) && this.storage.paired.get(id)) this.dropMember(id);
    }
  }

  /**
   * A member removed from the group, on this device: sent the roster that
   * says so, signed, while its channel is open, then its channel and the
   * host's state for it go, its row, and its pair at the relay — posted
   * even with no row, so the relay also drops a mutual half waiting
   * between the two.
   */
  private dropMember(id: string): void {
    this.host.channel(id)?.sendGroup({ t: 'roster', entries: shareable(this.storage.roster.list()) });
    this.host.forget(id);
    this.storage.paired.remove(id);
    this.revokeAtRelay(id);
  }

  /**
   * This device was removed from its group: the members it still talks to
   * get the roster that says so and `bye revoked`, while the channels
   * exist; then every pair goes at the relay, with any mutual half waiting
   * for a member, then every paired device here; then this device starts a
   * group of one with its founding entry, which any member's next
   * membership for it replaces.
   */
  private leaveGroup(self: string): void {
    const identity = this.host.identity();
    if (!identity) return;
    const paired = this.storage.paired.list();
    // A phone paired here loses that pair below, and no other member can reach it: the roster
    // the others get says it is gone too. Not written here — the group of one replaces it.
    const now = this.host.now();
    let entries = this.storage.roster.list();
    for (const e of entries) {
      if (e.kind === 'phone' && isLive(e) && !e.links && paired.some((d) => d.id === e.id)) {
        entries = removeMember(entries, e.id, identity, now);
      }
    }
    for (const [, channel] of this.host.channels()) channel.sendGroup({ t: 'roster', entries: shareable(entries) });
    this.host.forgetAll();
    for (const d of paired) this.revokeAtRelay(d.id);
    // A member that links but is not paired here may have a mutual half waiting at the relay.
    for (const e of entries) {
      if (e.id !== self && isLive(e) && e.links && !paired.some((d) => d.id === e.id)) this.revokeAtRelay(e.id);
    }
    for (const d of paired) this.storage.paired.remove(d.id);
    this.setRoster([this.founding(identity)]);
  }

  private founding(identity: Identity): RosterEntry {
    const { kind, name, os, links } = this.host.about();
    return foundingEntry(identity, kind, { name, os, links }, this.host.now());
  }

  /**
   * One relay post for `peer` at a time, answered within
   * `RELAY_POST_TIMEOUT_MS` (status 0 past it); null while one is in flight.
   */
  private postOnce<T>(
    relay: GroupRelay, path: string, action: RelayAction, peer: string, payload: unknown,
  ): Promise<{ status: number; body: T; unsupported?: boolean }> | null {
    const key = `${path} ${peer}`;
    if (this.inFlight.has(key)) return null;
    this.inFlight.add(key);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<{ status: number; body: T }>((resolve) => {
      timer = setTimeout(() => resolve({ status: 0, body: {} as T }), RELAY_POST_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    return Promise.race([relay.post<T>(path, action, payload), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
      this.inFlight.delete(key);
    });
  }

  /**
   * The device is gone here whatever the relay answers. The revoke is kept
   * in `pendingRevokes` until the relay answers it — 404 is a pair the
   * relay no longer had — and posted again at every relay `ok` until then.
   */
  revokeAtRelay(id: string): void {
    this.storage.pendingRevokes.add(id);
    const relay = this.host.relay();
    if (!relay || relay.status !== 'online') return;
    // One in flight already: its answer clears the pending revoke, or the next relay `ok` posts it again.
    const posted = this.postOnce(relay, '/pair/revoke', 'pair.revoke', id, { phone: id });
    if (!posted) return;
    const done = posted.then((res) => {
      if (res.status === 200 || res.status === 404) {
        this.tryRoster('forget a revoke the relay answered', () => this.storage.pendingRevokes.remove(id));
      } else {
        this.host.log(`relay revoke of ${id.slice(0, 8)} failed: ${res.status}`);
      }
    });
    this.revoking.add(done);
    void done.finally(() => this.revoking.delete(done));
  }

  /**
   * Asks the relay for a mutual pair with every live member this device
   * links with (`linksWith`: never a phone from a phone) and is not paired
   * with this device yet, each once per relay connection (ADR
   * the-relay-pairs-two-devices-that-both-sign). The pair forms when the
   * member asks too; the relay then says `linked`, and so may this answer.
   * `paired` asks for the members paired here as well: the relay answers
   * `linked` while it holds the pair, and otherwise waits for the other half.
   */
  link(paired = false): void {
    const self = this.ownId;
    const relay = this.host.relay();
    if (self === null || !relay || relay.status !== 'online') return;
    const asked = this.mutualAsked;
    const selfKind = this.host.about().kind;
    for (const e of this.storage.roster.list()) {
      if (!isLive(e) || !linksWith(selfKind, e) || e.id === self || asked.has(e.id) || (!paired && this.storage.paired.get(e.id))) continue;
      const id = e.id;
      // One in flight from an earlier connection: its answer asks again (below).
      const posted = this.postOnce<{ linked?: boolean }>(relay, '/pair/mutual', 'pair.mutual', id, { peer: id });
      if (!posted) continue;
      asked.add(id);
      void posted.then((res) => {
        // A relay `ok` in between started a new connection's asking; this answer is the old one's,
        // and the new connection asks for this member now that nothing is in flight for it.
        if (this.host.relay() !== relay || this.mutualAsked !== asked) {
          this.tryRoster('link the group', () => this.link(true));
          return;
        }
        if (res.status === 200) {
          if (res.body.linked === true) this.relayLinked(id);
          return;
        }
        // A relay from before `/pair/mutual`, or one that never answers this device there.
        if (res.status === 404 || res.unsupported === true) {
          this.pairByHand.add(id);
          this.host.changed();
          return;
        }
        // A refusal (a bad id) waits for the next relay `ok`, a rate limit
        // `MUTUAL_RETRY_MS` at most; a network failure or a relay error is
        // asked again at the next roster change.
        if (res.status === 0 || res.status >= 500) asked.delete(id);
        if (res.status === 429) this.retryMutual(id);
        this.host.log(`relay mutual pair with ${id.slice(0, 8)} failed: ${res.status}`);
      });
    }
  }

  /** One timer for every rate-limited member: they are asked again together. */
  private retryMutual(id: string): void {
    this.rateLimited.add(id);
    if (this.mutualRetry) return;
    const timer = setTimeout(() => {
      this.mutualRetry = null;
      for (const limited of this.rateLimited) this.mutualAsked.delete(limited);
      this.rateLimited = new Set();
      this.tryRoster('link the group', () => this.link());
    }, MUTUAL_RETRY_MS);
    // Node keeps a process alive for a pending timer; a retry is no reason to.
    (timer as { unref?: () => void }).unref?.();
    this.mutualRetry = timer;
  }

  private clearMutualRetry(): void {
    if (this.mutualRetry) clearTimeout(this.mutualRetry);
    this.mutualRetry = null;
    this.rateLimited = new Set();
  }

  /**
   * The relay paired this device with `peer`. Only a member the roster holds
   * live, and that links, becomes a paired device — never one on the relay's word alone. Both
   * the control and the post's answer can say so; the second changes nothing.
   */
  private onLinked(peer: string): void {
    const entry = this.storage.roster.entry(peer);
    const self = this.ownId;
    if (self === null || peer === self) return;
    // A removed member asked before its removal reached the relay: the pair goes again.
    if (entry && !isLive(entry)) {
      this.host.log(`revoked a link with ${peer.slice(0, 8)}: removed from the group`);
      this.revokeAtRelay(peer);
      return;
    }
    // A member that does not link (a phone) is never asked for, so a `linked` for one is not ours.
    if (!entry || !entry.links) {
      this.host.log(`ignored a link with ${peer.slice(0, 8)}: no live member of the group that links`);
      return;
    }
    // Two phones: neither answers a handshake, so the pair would only retry for ever. It goes,
    // with a row a phone from before this rule may have kept for it.
    if (!linksWith(this.host.about().kind, entry)) {
      this.host.log(`revoked a link with ${peer.slice(0, 8)}: a phone does not link with a phone`);
      if (this.storage.paired.get(peer)) {
        this.host.forget(peer);
        this.storage.paired.remove(peer);
        this.host.changed();
      }
      this.revokeAtRelay(peer);
      return;
    }
    if (!this.storage.paired.get(peer)) {
      this.storage.paired.add({ id: peer, name: entry.name, platform: entry.os, kind: entry.kind, pairedAt: this.host.now() });
      this.storage.pendingRevokes.remove(peer);
      this.host.paired(peer);
      this.host.changed();
    }
    this.host.open(peer);
  }

  /**
   * This device, once, as the first member of its own group (its founding
   * entry); a removed entry for it stays removed. A live one is described
   * afresh (`setRoster`): a rename made while the remote was off reached no roster.
   */
  addSelf(): void {
    const identity = this.host.identity();
    if (!identity) return;
    const known = this.storage.roster.entry(deviceId(identity.publicKey));
    if (!known) this.setRoster([...this.storage.roster.list(), this.founding(identity)]);
    else if (isLive(known)) this.setRoster(this.storage.roster.list());
  }

  /**
   * Whether this device can add `id` (`mayAdd`: room for it, and this device
   * has not signed `ROSTER_MAX_ADDED_BY` memberships at its epoch). A roster
   * that cannot be read takes none.
   */
  canAdd(id: string): boolean {
    const self = this.ownId;
    try {
      return self !== null && mayAdd(this.storage.roster.list(), id, self);
    } catch {
      return false;
    }
  }

  /**
   * A device whose request this one confirmed, added by this device at the
   * next epoch, as the pairing named it. A live entry is kept: the device
   * is a member already. A device whose code this one redeemed is not
   * written here: its own roster names it, and a device that keeps none is
   * added at its hello or its first roster (`onPeerHello`, `onGroup`).
   */
  addPaired(device: Pick<RosterEntry, 'id' | 'kind' | 'name' | 'os' | 'links'>): boolean {
    let added = false;
    this.tryRoster('add a paired device', () => {
      const identity = this.host.identity();
      if (!identity) return;
      const known = this.storage.roster.entry(device.id);
      if (!(known && isLive(known))) this.setRoster(addMember(this.storage.roster.list(), device, identity, this.host.now()));
      const entry = this.storage.roster.entry(device.id);
      added = entry !== null && isLive(entry) && !isFounding(entry);
    });
    return added;
  }

  /**
   * A device paired here that the roster cannot take (it is full, or this
   * device signed `ROSTER_MAX_ADDED_BY` memberships at its epoch): its pair
   * goes, here and at the relay, rather than stay half added.
   */
  private unpairUnadded(id: string): void {
    this.host.log(`dropped the pair with ${id.slice(0, 8)}: the group can't take it`);
    this.host.forget(id);
    this.storage.paired.remove(id);
    this.revokeAtRelay(id);
    this.host.changed();
  }

  /** Each side sends its digest as the channel opens; a difference is answered with the roster. */
  channelReady(channel: GroupChannel): void {
    if (channel.groups) channel.sendGroup({ t: 'roster_digest', digest: this.storage.roster.digest() });
  }

  /**
   * A peer's hello. Its entry is its own to describe: only the member that
   * added it writes what the hello says, and only while the device has not
   * described itself (a device that never signs, a shipped phone). A
   * device paired here with no entry gets one, added by this device, when
   * it keeps no roster of its own (a phone from before groups, a Mac from
   * before groups); one that does is added at its first roster (`onGroup`).
   */
  onPeerHello(from: string, channel: GroupChannel, hello: HelloMessage): void {
    this.tryRoster('describe a peer', () => {
      const identity = this.host.identity();
      if (!identity) return;
      const self = deviceId(identity.publicKey);
      const name = hello.name ?? hello.macName;
      const known = this.storage.roster.entry(from);
      const now = this.host.now();
      // `from` is skipped: the channel's own `ready` follows with the digest.
      if (known) {
        if (!isLive(known) || known.addedBy !== self || known.describedBy === from) return;
        this.setRoster(describeMember(this.storage.roster.list(), from, {
          name: name ?? known.name, os: hello.os ?? known.os, links: channel.groups,
        }, identity, now), from);
        return;
      }
      const device = this.storage.paired.get(from);
      if (!device || channel.groups) return;
      const roster = this.storage.roster.list();
      const next = addMember(roster, {
        id: from, kind: device.kind ?? 'desktop', name: name ?? device.name, os: hello.os ?? osName(device.platform),
        links: false,
      }, identity, now);
      if (next === roster) this.unpairUnadded(from);
      else this.setRoster(next, from);
    });
  }

  /**
   * A group message from `from`, taken only while `from` is paired here:
   * after this device leaves, every pair is gone, and a roster a former
   * peer had in flight must not bring back the group it left.
   */
  onGroup(from: string, channel: GroupChannel, msg: GroupMessage): void {
    let paired = false;
    try {
      paired = this.storage.paired.get(from) !== null;
    } catch (err) {
      this.host.log(`could not read the pairs: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!paired) {
      this.host.log(`ignored a group message from ${from.slice(0, 8)}: not paired here`);
      return;
    }
    if (msg.t === 'roster_digest') {
      this.tryRoster('answer a roster digest', () => {
        if (msg.digest !== this.storage.roster.digest()) {
          channel.sendGroup({ t: 'roster', entries: shareable(this.storage.roster.list()) });
        }
      });
      return;
    }
    // One id twice: each copy could be weighed alone; such a roster is no one's honest view.
    if (hasDuplicateIds(msg.entries)) {
      this.host.log(`ignored a roster from ${from.slice(0, 8)}: it names one device twice`);
      return;
    }
    this.tryRoster('merge a roster', () => {
      const self = this.ownId;
      if (self !== null) this.setRoster(mergeRoster(this.storage.roster.list(), msg.entries, { self }), from);
    });
    // A device paired here whose roster does not name it: the device whose code this one
    // redeemed, while it was alone. This device adds it, as the pairing named it.
    this.tryRoster('add the member a roster came from', () => {
      const identity = this.host.identity();
      const device = this.storage.paired.get(from);
      if (!identity || !device || this.storage.roster.entry(from)) return;
      const roster = this.storage.roster.list();
      const next = addMember(roster, {
        id: from, kind: device.kind ?? 'desktop', name: device.name, os: osName(device.platform), links: true,
      }, identity, this.host.now());
      if (next === roster) this.unpairUnadded(from);
      else this.setRoster(next, from);
    });
    // The sender may still lack what only this side knew: answered only when
    // its merge would take something, so two members that keep a different
    // entry (one the other does not take) do not trade rosters forever.
    this.tryRoster('answer a roster', () => {
      const local = shareable(this.storage.roster.list());
      const theirs = mergeRoster(msg.entries, local, { self: from, trusted: true });
      if (rosterDigest(theirs) !== rosterDigest(msg.entries)) channel.sendGroup({ t: 'roster', entries: local });
    });
  }

  /**
   * A roster write on the way to something else — a confirm already
   * accepted, a hello inside the channel — that must not fail it: the
   * roster catches up at the next exchange.
   */
  tryRoster(what: string, write: () => void): void {
    try {
      write();
    } catch (err) {
      this.host.log(`could not ${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
