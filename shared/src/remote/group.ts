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
import type { GroupMessage, HelloMessage } from './messages.js';
import type { RelayAction } from './relayApi.js';
import {
  addMember, describeMember, isLive, mergeRosters, removeMember, rosterDigest, type RosterEntry,
} from './roster.js';

/**
 * How long a mutual pair the relay refused for its rate limit waits before it
 * is asked again, rather than only at the next relay `ok`.
 */
export const MUTUAL_RETRY_MS = 60_000;

/**
 * How Settings shows a member. `self`: this device. `online`/`offline`: a
 * member paired here, or a member that does not link (a phone paired with
 * another member), by the relay's presence. `linking`: a member that links
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

/** A member row as Settings lists it; see `RemoteStatus['group']` on the server. */
export type MemberRow = RosterEntry & {
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
  readonly status: string;
  post<T>(path: string, action: RelayAction, payload: unknown): Promise<{ status: number; body: T }>;
}

/** What the group needs of a channel. */
export type GroupChannel = Pick<Channel, 'sendGroup' | 'groups'>;

export interface GroupHost {
  /** This device's id while its identity is loaded; null while the remote is off. */
  selfId(): string | null;
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
 * Whether `entries` holds a live member other than `self` that makes a
 * group: one that links, or one this device is not paired with (`paired`
 * holds the ids with a `remote_devices` row). A phone paired here makes no
 * group — a Mac with only its phones keeps today's relay change and joins.
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

  constructor(private readonly storage: GroupStorage, private readonly host: GroupHost) {}

  private get runningId(): string | null {
    return this.host.selfId();
  }

  /** The relay went away for good (the remote stopped): no retry fires after it. */
  stop(): void {
    this.clearMutualRetry();
  }

  /**
   * The relay said `ok`: a new connection. Asks again for every mutual pair
   * and posts every revoke the relay was not told yet.
   */
  relayOk(): void {
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
   * when nothing was written (the remote is off, or the roster did not
   * change), so the caller publishes the status itself.
   */
  nameChanged(): boolean {
    const self = this.runningId;
    return self !== null
      && this.setRoster(describeMember(this.storage.roster.list(), self, { name: this.host.about().name }, this.host.now()));
  }

  /**
   * The member rows Settings lists: the roster's live members, `online` by
   * the relay's presence. Throws when the storage cannot be read.
   */
  members(online: ReadonlySet<string>): MemberRow[] {
    const self = this.host.knownId();
    const rows = new Map(this.storage.paired.list().map((d) => [d.id, d]));
    return this.storage.roster.list().filter(isLive).map((e) => {
      const row = rows.get(e.id);
      const pairByHand = this.pairByHand.has(e.id);
      const state: MemberState = e.id === self ? 'self'
        : row || !e.links ? (online.has(e.id) ? 'online' : 'offline')
          : pairByHand ? 'notLinked' : 'linking';
      return {
        ...e, self: e.id === self, linked: row !== undefined, online: online.has(e.id), pairByHand,
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
    if (self !== null) {
      this.tryRoster('remove a member', () => {
        const now = this.host.now();
        let roster = this.storage.roster.list();
        if (!known && device) {
          roster = addMember(roster, {
            id, kind: device.kind ?? 'phone', name: device.name, os: osName(device.platform), links: false,
            addedBy: self, addedAt: device.pairedAt, describedAt: now,
          });
        }
        this.setRoster(removeMember(roster, id, self, now));
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
    const self = this.runningId;
    const relay = this.host.relay();
    if (self === null || !relay || relay.status !== 'online') return { error: 'offline' };
    try {
      this.setRoster(removeMember(this.storage.roster.list(), self, self, this.host.now()));
    } catch (err) {
      this.host.log(`could not leave the group: ${err instanceof Error ? err.message : String(err)}`);
      return { error: 'failed' };
    }
    await Promise.all([...this.revoking]);
    return { ok: true };
  }

  /**
   * The only way the roster changes. Unchanged, it does nothing: that is
   * what ends an exchange between two members once they agree. Changed, it
   * applies what the change removed, publishes the status and offers the
   * new digest on every group channel but `from`, the one the change came in on.
   */
  setRoster(next: RosterEntry[], from?: string): boolean {
    const before = new Map(this.storage.roster.list().map((e) => [e.id, e]));
    if (!this.storage.roster.replace(next)) return false;
    this.applyRemovals(before);
    this.host.changed();
    const digest = this.storage.roster.digest();
    for (const [id, channel] of this.host.channels()) {
      if (id !== from) channel.sendGroup({ t: 'roster_digest', digest });
    }
    this.link();
    return true;
  }

  /**
   * Every entry this write removed: this device's own makes it leave the
   * group; another's drops that member here. An entry first heard of as
   * removed is dropped only when this device is paired with it.
   */
  private applyRemovals(before: Map<string, RosterEntry>): void {
    const self = this.host.knownId();
    const removed = this.storage.roster.list().filter((e) => {
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
  }

  /**
   * A member removed from the group, on this device: told so while its
   * channel is open, then its channel and the host's state for it go, its
   * row, and its pair at the relay — posted even with no row, so the relay
   * also drops a mutual half waiting between the two.
   */
  private dropMember(id: string): void {
    this.host.channel(id)?.sendGroup({ t: 'removed' });
    this.host.forget(id);
    this.storage.paired.remove(id);
    this.revokeAtRelay(id);
  }

  /**
   * This device was removed from its group: the members it still talks to
   * get the roster that says so (a `removed` would tell them they were
   * removed) and `bye revoked`, while the channels exist; then every pair
   * goes at the relay, with any mutual half waiting for a member, then every paired device here; then this device
   * starts a group of one at its next epoch, which the others' removal
   * does not reach.
   */
  private leaveGroup(self: string): void {
    const paired = this.storage.paired.list();
    // A phone paired here loses that pair below, and no other member can reach it: the roster
    // the others get says it is gone too. Not written here — the group of one replaces it.
    const now = this.host.now();
    let entries = this.storage.roster.list();
    for (const e of entries) {
      if (e.kind === 'phone' && isLive(e) && !e.links && paired.some((d) => d.id === e.id)) {
        entries = removeMember(entries, e.id, self, now);
      }
    }
    for (const [, channel] of this.host.channels()) channel.sendGroup({ t: 'roster', entries });
    this.host.forgetAll();
    for (const d of paired) this.revokeAtRelay(d.id);
    // A member that links but is not paired here may have a mutual half waiting at the relay.
    for (const e of entries) {
      if (e.id !== self && isLive(e) && e.links && !paired.some((d) => d.id === e.id)) this.revokeAtRelay(e.id);
    }
    for (const d of paired) this.storage.paired.remove(d.id);
    this.setRoster(addMember(entries.filter((e) => e.id === self), {
      id: self, ...this.host.about(), addedBy: self, addedAt: now, describedAt: now,
    }));
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
    const done = relay.post('/pair/revoke', 'pair.revoke', { phone: id }).then((res) => {
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
   * Asks the relay for a mutual pair with every live member that links and
   * is not paired with this device yet, each once per relay connection (ADR
   * the-relay-pairs-two-devices-that-both-sign). The pair forms when the
   * member asks too; the relay then says `linked`, and so may this answer.
   * `paired` asks for the members paired here as well: the relay answers
   * `linked` while it holds the pair, and otherwise waits for the other half.
   */
  link(paired = false): void {
    const self = this.runningId;
    const relay = this.host.relay();
    if (self === null || !relay || relay.status !== 'online') return;
    const asked = this.mutualAsked;
    for (const e of this.storage.roster.list()) {
      if (!isLive(e) || !e.links || e.id === self || asked.has(e.id) || (!paired && this.storage.paired.get(e.id))) continue;
      const id = e.id;
      asked.add(id);
      void relay.post<{ linked?: boolean }>('/pair/mutual', 'pair.mutual', { peer: id }).then((res) => {
        // A relay `ok` in between started a new connection's asking; this answer is the old one's.
        if (this.host.relay() !== relay || this.mutualAsked !== asked) return;
        if (res.status === 200) {
          if (res.body.linked === true) this.relayLinked(id);
          return;
        }
        if (res.status === 404) {
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
    const self = this.runningId;
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
    if (!this.storage.paired.get(peer)) {
      this.storage.paired.add({ id: peer, name: entry.name, platform: entry.os, kind: entry.kind, pairedAt: this.host.now() });
      this.storage.pendingRevokes.remove(peer);
      this.host.paired(peer);
      this.host.changed();
    }
    this.host.open(peer);
  }

  /**
   * This device, once, as the first member of its own group; a removed entry
   * for it stays removed. A live one is described afresh: a rename made while
   * the remote was off reached no roster.
   */
  addSelf(): void {
    const self = this.runningId;
    if (self === null) return;
    const known = this.storage.roster.entry(self);
    const now = this.host.now();
    const about = this.host.about();
    if (!known) {
      this.setRoster(addMember(this.storage.roster.list(), { id: self, ...about, addedBy: self, addedAt: now, describedAt: now }));
    } else if (isLive(known)) {
      this.setRoster(describeMember(this.storage.roster.list(), self, about, now));
    }
  }

  /**
   * A device this one just paired with, at the next epoch. A live entry is
   * kept: the device is a member already, perhaps written by its first
   * hello, which can arrive before the pairing finishes here.
   */
  addPaired(device: Pick<RosterEntry, 'id' | 'kind' | 'name' | 'os'>): void {
    this.tryRoster('add a paired device', () => {
      const self = this.runningId;
      if (self === null) return;
      const known = this.storage.roster.entry(device.id);
      if (known && isLive(known)) return;
      const now = this.host.now();
      this.setRoster(addMember(this.storage.roster.list(), {
        ...device, links: false, addedBy: self, addedAt: now, describedAt: now,
      }));
    });
  }

  /** Each side sends its digest as the channel opens; a difference is answered with the roster. */
  channelReady(channel: GroupChannel): void {
    if (channel.groups) channel.sendGroup({ t: 'roster_digest', digest: this.storage.roster.digest() });
  }

  /**
   * What a peer's hello says about it, written onto its live entry; only the
   * fields the hello names. A device paired before the roster existed has
   * no entry yet and gets one here.
   */
  onPeerHello(from: string, channel: GroupChannel, hello: HelloMessage): void {
    this.tryRoster('describe a peer', () => {
      const self = this.runningId;
      if (self === null) return;
      const name = hello.name ?? hello.macName;
      const patch = {
        ...(name !== undefined ? { name } : {}),
        ...(hello.os !== undefined ? { os: hello.os } : {}),
        links: channel.groups,
      };
      const known = this.storage.roster.entry(from);
      const now = this.host.now();
      // `from` is skipped: the channel's own `ready` follows with the digest.
      if (known) {
        if (isLive(known)) this.setRoster(describeMember(this.storage.roster.list(), from, patch, now), from);
        return;
      }
      const device = this.storage.paired.get(from);
      if (!device) return;
      this.setRoster(addMember(this.storage.roster.list(), {
        id: from, kind: device.kind ?? hello.kind ?? 'desktop', name: patch.name ?? device.name, os: patch.os ?? '',
        links: patch.links, addedBy: self, addedAt: now, describedAt: now,
      }), from);
    });
  }

  onGroup(from: string, channel: GroupChannel, msg: GroupMessage): void {
    if (msg.t === 'roster_digest') {
      this.tryRoster('answer a roster digest', () => {
        if (msg.digest !== this.storage.roster.digest()) channel.sendGroup({ t: 'roster', entries: this.storage.roster.list() });
      });
      return;
    }
    if (msg.t === 'roster') {
      this.tryRoster('merge a roster', () => this.setRoster(mergeRosters(this.storage.roster.list(), msg.entries), from));
      // The sender may still lack what only this side knew.
      this.tryRoster('answer a roster', () => {
        if (this.storage.roster.digest() !== rosterDigest(msg.entries)) {
          channel.sendGroup({ t: 'roster', entries: this.storage.roster.list() });
        }
      });
      return;
    }
    // A member says this device was removed; its roster says so too, and the removal comes with it.
    const self = this.runningId;
    if (self !== null) {
      this.tryRoster('leave the group', () => this.setRoster(removeMember(this.storage.roster.list(), self, from, this.host.now()), from));
    }
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
