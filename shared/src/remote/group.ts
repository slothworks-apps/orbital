/**
 * This device as a member of its group (spec 2026-10-16-device-group-design
 * § 2–§ 4, ADR the-group-has-one-primary-device): it keeps the roster the
 * primary signs, syncs it over its channels, links with every member through
 * the relay's `/pair/mutual`, revokes pairs and retries what failed. Only the
 * primary adds and removes members; any member leaves. The server and the
 * phone run the same logic; everything host-specific — storage, the relay,
 * the channels, watchers, timers' owner — comes in through `GroupStorage`
 * and `GroupHost`. No DOM and no Node.
 */
import type { Channel } from './channel.js';
import { osName } from './device.js';
import { deviceId, type Identity } from './keys.js';
import type { GroupMessage, HelloMessage } from './messages.js';
import type { RelayAction } from './relayApi.js';
import type { LinkStatus } from './relayLink.js';
import {
  EMPTY_ROSTER, ROSTER_MAX_ENTRIES, describeDevice, descriptionOf, dissolveRoster, exitDigest, foundRoster, leftNotice,
  memberIds, nextRoster, normalize, ofGroup, rosterKey, rosterMembers, takeRoster, type GroupEnded, type Membership,
  type MemberView, type NewMember, type RosterAbout, type RosterState,
} from './roster.js';

export type { GroupEnded } from './roster.js';

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
 * How long `leave` waits for a member to acknowledge the left notice before
 * it answers `offline` and leaves nothing.
 */
export const LEAVE_ACK_TIMEOUT_MS = 15_000;

/** How often `leave` sends its notice again while it waits: a frame lost to a channel starting over is sent anew. */
export const LEAVE_RESEND_MS = 2_000;

/**
 * How Settings shows a member. `self`: this device. `online`/`offline`: a
 * member paired here, or a member this device does not link with
 * (`linksWith`: a phone paired with another member), by the relay's presence. `linking`: a member that links
 * and is not paired here yet; `notLinked`: one the relay cannot pair
 * (`pairByHand`), so only a pairing code links the two.
 */
export type MemberState = 'self' | 'online' | 'offline' | 'linking' | 'notLinked';

/** The group's primary as a refusal names it: the device that adds and removes members. */
export type PrimaryRef = { id: string; name: string };

/** A refusal of a member that is not the primary: only `primary` adds or removes a device. */
export type NotPrimary = { error: 'not_primary'; primary: PrimaryRef };

/**
 * The answer to removing a device: `offline` when it is this device itself
 * and the relay is not online (`leave`); `not_primary` from a member that is
 * not its group's primary.
 */
export type RemoveResult = { ok: true } | { error: 'not_found' | 'offline' | 'failed' } | NotPrimary;

/**
 * A relay pair this device holds: the server's `remote_devices` row, as
 * much of it as the group reads. `kind` null: paired through the code of a
 * Mac from before kinds. `lastSeenAt`: when it was last on the relay.
 */
export type PairedDevice = {
  id: string; name: string; platform: string; kind: string | null; pairedAt: number; lastSeenAt: number | null;
};

/**
 * A member row as Settings lists it; see `RemoteStatus['group']` on the
 * server. `primary`: this member is the group's primary.
 */
export type MemberRow = MemberView & {
  self: boolean; linked: boolean; online: boolean; pairByHand: boolean; state: MemberState; seenAt: number | null;
};

/**
 * The group as the Mac's status lists it (`RemoteStatus.group`; spec
 * 2026-10-16-device-group-design § 2, ADR the-group-has-one-primary-device).
 * `members`: every member the latest version names (this device alone while
 * it holds no group), each with its description and `tooOld`: a member too
 * old to take part in the group (not a phone, and its last hello named no
 * `group` capability). `version`: the Orbital version its last hello named (this
 * device's own for itself), null before one; absent from a server before
 * updates from the group, and on the phone, which keeps versions per device. `relayLocked`: this device is in a group, so the
 * relay URL and secret cannot change. `primary`: the group's primary, which
 * alone adds and removes members, null while this device holds no group;
 * `isPrimary`: this device is it. `ended`: the primary dissolved the group
 * or removed this device, until the user acknowledges the notice; null
 * otherwise. `pendingJoin`: a pairing made this device join `primary`'s
 * group and its first roster has not come; `expiresAt`, when the code it
 * was made with stops working and the join is dropped. Null otherwise.
 * `joinExpired`: the primary of a join dropped that way, until the user
 * reads it (`GroupMember.expiredJoin`); null otherwise.
 */
export type GroupStatus = {
  members: (MemberRow & { tooOld: boolean; version?: string | null })[];
  relayLocked: boolean;
  primary: PrimaryRef | null;
  isPrimary: boolean;
  ended: GroupEnded | null;
  pendingJoin: { primary: string; expiresAt: number | null } | null;
  joinExpired: PrimaryRef | null;
};

/** What this device says about itself: its kind (for a founding) and its description. */
export type SelfAbout = { kind: string } & RosterAbout;

/**
 * Where the group lives. Synchronous: the server's SQLite is, and the phone
 * keeps an in-memory copy it persists behind. Any call may throw (a database
 * already gone); the group catches where a write is on the way to something else.
 */
export interface GroupStorage {
  roster: {
    read(): RosterState;
    /** Writes the whole state; false when it is unchanged. */
    replace(state: RosterState): boolean;
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
  /**
   * The group this device belongs to, or is joining by a ceremony, and the
   * highest version taken of it (`Membership`); null while it has none. Kept
   * apart from the roster, so a device whose stored document was dropped
   * still takes only its own primary's, and nothing at or below that version.
   */
  membership: { get(): Membership | null; set(m: Membership | null): void };
  /**
   * Pairs that end once the document that ends them reached the other side
   * (`GroupExit`), kept across restarts. Nothing is served to such a device meanwhile.
   * `has` is asked on every frame to and from a peer, so it reads no stored state: an id
   * whose state does not read still counts.
   */
  exits: { list(): GroupExit[]; has(id: string): boolean; set(exit: GroupExit): void; remove(id: string): void };
}

/**
 * A pair that ends once `state` reached `id` and `id` acknowledged it: the
 * version that no longer names it, the dissolved version, or this device's
 * own left notice.
 */
export type GroupExit = {
  id: string;
  /** Null when what was stored no longer reads: nothing to send, but the device is still served nothing. */
  state: RosterState | null;
  /** When the exit began (epoch ms): past `EXIT_MAX_MS` the pair ends whether or not it was heard. */
  since: number;
};

/**
 * How long a pair waits for the device to acknowledge what ends it before
 * it ends anyway (`finishExit`, revoked at the relay): as long as the relay
 * keeps a mutual half (`MUTUAL_PAIR_TTL_MS`). A device asleep longer than
 * this never learns of its end by message.
 */
export const EXIT_MAX_MS = 7 * 24 * 60 * 60_000;

/**
 * How often exits past `EXIT_MAX_MS` are ended while the relay connection
 * stays up: a connection that never drops would otherwise keep an overdue
 * one (and its pair, which can still wake a phone) for ever.
 */
export const EXIT_SWEEP_MS = 60 * 60_000;

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
   * What this device says about itself in the roster, cut to the bounds the
   * roster is read within: a description past them would refuse the whole
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
  /**
   * This device is no member of its group any more (it left, was removed,
   * or the group was dissolved). The channels to the members stay until
   * each one's exit is acknowledged (`forget`).
   */
  leftGroup(): void;
  /** Something a status shows changed. */
  changed(): void;
  now(): number;
  log(message: string): void;
}

/**
 * Whether a device of `selfKind` links with `member`: a member that links,
 * unless both are phones. Two phones each open every channel (`initiates`),
 * so a pair between them would never carry one: a phone never asks another
 * for a mutual pair, and it reads another phone as paired elsewhere.
 */
export function linksWith(selfKind: string, member: { kind: string; links: boolean }): boolean {
  return member.links && !(selfKind === 'phone' && member.kind === 'phone');
}

/** A device to add, as its pairing named it. */
export type AddedDevice = NewMember & RosterAbout;

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
  /** Ends overdue exits every `EXIT_SWEEP_MS` from the first relay `ok`; cleared by `stop`. */
  private exitSweep: ReturnType<typeof setInterval> | null = null;
  /** Revokes posted to the relay and not answered yet; a removal waits for them before it answers. */
  private readonly revoking = new Set<Promise<void>>();
  /** Posts to the relay not answered yet, by `path` and peer: never two at once for one peer. */
  private readonly inFlight = new Set<string>();
  /** Set by the relay's first `ok` on a connection, cleared when it goes (`relayLost`): later ones ask nothing again. */
  private okHandled = false;
  /** `leave` waiting for the first member to acknowledge its notice. */
  private leaving: { state: RosterState; digest: string; acked(from: string): void } | null = null;
  private leaveRun: Promise<RemoveResult> | null = null;
  /**
   * The primary of the join `pendingJoin` dropped when its code stopped
   * working, its first roster never come (canvas 50p B): kept until the user
   * reads it or a pairing joins a group again. In memory only: a restart
   * forgets it, and the device was standalone all along.
   */
  private droppedJoin: PrimaryRef | null = null;

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
    if (this.exitSweep) clearInterval(this.exitSweep);
    this.exitSweep = null;
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
    this.sweepExits();
    if (!this.exitSweep) {
      const timer = setInterval(() => this.sweepExits(), EXIT_SWEEP_MS);
      // Node keeps a process alive for a pending timer; a sweep is no reason to.
      (timer as { unref?: () => void }).unref?.();
      this.exitSweep = timer;
    }
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
   * This device's name changed: its description is signed afresh. False
   * when nothing was written (no identity yet, alone, or nothing changed),
   * so the caller publishes the status itself.
   */
  nameChanged(): boolean {
    return this.ownId !== null && this.setRoster(this.storage.roster.read());
  }

  /**
   * The group's members as this device knows them, itself always among
   * them: alone, it is the only one. Throws when the storage cannot be read.
   */
  memberList(): MemberView[] {
    const self = this.host.knownId();
    const list = rosterMembers(this.storage.roster.read());
    if (self === null || list.some((m) => m.id === self)) return list;
    const { kind, name, os, links } = this.host.about();
    return [{ id: self, kind, addedAt: 0, addedVersion: 0, name, os, links, primary: false }];
  }

  /**
   * The member rows Settings lists: every member, `online` by the relay's
   * presence. Throws when the storage cannot be read.
   */
  members(online: ReadonlySet<string>): MemberRow[] {
    const self = this.host.knownId();
    const rows = new Map(this.storage.paired.list().map((d) => [d.id, d]));
    const selfKind = this.host.about().kind;
    return this.memberList().map((m) => {
      const row = rows.get(m.id);
      const pairByHand = this.pairByHand.has(m.id);
      const state: MemberState = m.id === self ? 'self'
        : row || !linksWith(selfKind, m) ? (online.has(m.id) ? 'online' : 'offline')
          : pairByHand ? 'notLinked' : 'linking';
      return {
        ...m, self: m.id === self, linked: row !== undefined, online: online.has(m.id), pairByHand, state,
        seenAt: row?.lastSeenAt ?? null,
      };
    });
  }

  /**
   * The group's primary, named by its description; null while this device
   * holds no group. A roster that cannot be read holds none.
   */
  primary(): PrimaryRef | null {
    try {
      const state = this.storage.roster.read();
      const doc = state.roster;
      if (!doc || doc.dissolved) return null;
      return { id: doc.group, name: descriptionOf(state, doc.group)?.name ?? doc.group.slice(0, 8) };
    } catch {
      return null;
    }
  }

  /** Whether this device is its group's primary. */
  isPrimary(): boolean {
    const primary = this.primary();
    return primary !== null && primary.id === this.host.knownId();
  }

  /**
   * The refusal of a member that is not its group's primary: it adds and
   * removes no device. Null for the primary, and for a device in no group.
   */
  notPrimary(): NotPrimary | null {
    const primary = this.primary();
    if (!primary || primary.id === this.host.knownId()) return null;
    return { error: 'not_primary', primary };
  }

  /**
   * A pairing just made this device join `primary`'s group (the other side
   * adds it): from now on it takes that primary's roster, and no other group's.
   */
  joinGroup(primary: string, expires?: number): () => void {
    let previous: Membership | null = null;
    let joined = false;
    this.tryRoster('remember the group joined', () => {
      const m = this.storage.membership.get();
      previous = m;
      // The group it left before, joined again: any founding of that primary, but the versions of the
      // one it left, up to where it left, stay refused.
      const left = m && m.group === primary && !m.member && m.founding !== null ? { founding: m.founding, version: m.version } : null;
      this.storage.membership.set({
        group: primary, founding: null, version: 0, member: true, ...(left ? { left } : {}),
        ...(expires !== undefined ? { expires } : {}),
      });
      joined = true;
      this.droppedJoin = null;
      this.host.changed();
      // The primary may have sent its roster before this was recorded: its digest asks for it again.
      this.host.channel(primary)?.sendGroup({ t: 'roster_digest', digest: this.storage.roster.digest() });
    });
    return () => {
      if (joined) this.tryRoster('undo a join', () => this.storage.membership.set(previous));
    };
  }

  /**
   * The join under way: a ceremony named the primary, and its first roster
   * has not come. One whose code stopped working is dropped here (the
   * membership goes back to what the device left before, if anything), and
   * the pair made for it ends at the relay and here, as a cancel's does.
   */
  pendingJoin(): Membership | null {
    try {
      const m = this.storage.membership.get();
      // A join made by a ceremony carries its code's expiry; a phone migrated from one Mac before groups
      // carries none, and is no join under way.
      if (!m || !m.member || m.founding !== null || m.expires === undefined || this.storage.roster.read().roster) return null;
      if (m.expires <= this.host.now()) {
        this.droppedJoin = { id: m.group, name: this.storage.paired.get(m.group)?.name ?? m.group.slice(0, 8) };
        this.dropJoin(m);
        // As a cancel does (`abandonJoin`): the pair made for the join ends, so pairing with that primary again works.
        if (this.storage.paired.get(m.group)) this.finishExit(m.group);
        return null;
      }
      return m;
    } catch {
      return null;
    }
  }

  /**
   * Gives up the join under way (the user cancelled it): the membership goes
   * back to what it was, and the pair made with the primary for it ends.
   * False when no join is under way.
   */
  abandonJoin(): boolean {
    const m = this.pendingJoin();
    if (!m) return false;
    this.dropJoin(m);
    if (this.storage.paired.get(m.group)) this.finishExit(m.group);
    return true;
  }

  /** The primary of a join dropped by its code's clock, until the user reads it (`droppedJoin`); null otherwise. */
  expiredJoin(): PrimaryRef | null {
    return this.droppedJoin;
  }

  /** The user read that the join was dropped: it is gone. */
  acknowledgeExpiredJoin(): void {
    if (this.droppedJoin === null) return;
    this.droppedJoin = null;
    this.host.changed();
  }

  private dropJoin(m: Membership): void {
    this.storage.membership.set(m.left ? { group: m.group, founding: m.left.founding, version: m.left.version, member: false } : null);
    this.host.changed();
  }

  /** A device whose pair ends once the document that ends it reached it: nothing is served to it meanwhile. */
  exiting(id: string): boolean {
    try {
      return this.storage.exits.has(id);
    } catch {
      // Unreadable: served nothing rather than everything.
      return true;
    }
  }

  /** Every exit older than `EXIT_MAX_MS` ends now, heard or not. At every relay `ok` and at start. */
  private sweepExits(): void {
    this.tryRoster('end exits that waited too long', () => {
      const now = this.host.now();
      for (const exit of this.storage.exits.list()) {
        if (exit.since + EXIT_MAX_MS <= now) {
          this.host.log(`ended the pair with ${exit.id.slice(0, 8)}: it never acknowledged its exit`);
          this.finishExit(exit.id);
        }
      }
    });
  }

  /** Paired afresh by a ceremony: a revoke or an exit still waiting for `id` must not undo the new pair. */
  pairedAfresh(id: string): void {
    this.tryRoster('keep a new pair', () => {
      this.storage.pendingRevokes.remove(id);
      this.storage.exits.remove(id);
    });
  }

  /** The relay no longer holds the pair with `id` (`unpaired`): an exit waiting for it has nothing left to end. */
  pairEnded(id: string): void {
    this.tryRoster('forget an exit', () => this.storage.exits.remove(id));
  }

  /**
   * Why this device is no member of its group any more, when another did it
   * (the primary dissolved the group or removed it), until the user
   * acknowledges the notice; null otherwise. A storage that cannot be read holds none.
   */
  ended(): GroupEnded | null {
    try {
      const m = this.storage.membership.get();
      return m !== null && !m.member ? m.ended ?? null : null;
    } catch {
      return null;
    }
  }

  /** The user read the notice `ended` gives: it is gone. */
  acknowledgeEnded(): void {
    this.tryRoster('acknowledge the group ending', () => {
      const m = this.storage.membership.get();
      if (!m?.ended) return;
      const { ended: _ended, ...rest } = m;
      this.storage.membership.set(rest);
      this.host.changed();
    });
  }

  /**
   * Whether this device is in a group of two or more: a member other than
   * itself that links, or one this device is not paired with (`paired`
   * holds the ids of every pair this device holds). A device paired here
   * that does not link (a shipped phone) makes no group: a device with only
   * such pairs may still join another group and move to another relay. As
   * the status, a roster that cannot be read reads as a group of one.
   */
  inGroup(): boolean {
    try {
      const self = this.host.knownId();
      const paired = new Set(this.storage.paired.list().map((d) => d.id));
      return rosterMembers(this.storage.roster.read()).some((m) => m.id !== self && (m.links || !paired.has(m.id)));
    } catch (err) {
      this.host.log(`could not read the roster: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** A roster that cannot be read holds no one, as `inGroup` reads it. */
  isLiveMember(id: string): boolean {
    try {
      return memberIds(this.storage.roster.read()).includes(id);
    } catch {
      return false;
    }
  }

  /**
   * Removes a member from the group, on every member: the primary signs a
   * version without it; every member that holds a pair with it, the primary
   * first, ends that pair once the version reached it (`endPair`). A member
   * that is not the primary is refused (`not_primary`). A device paired here
   * that is no member (one this device paired before it joined its group)
   * loses its pair. `not_found` when `id` is neither. This device's own id
   * is `leave`, with its refusal while offline.
   */
  async remove(id: string): Promise<RemoveResult> {
    const self = this.host.knownId();
    if (self !== null && id === self) return this.leave();
    const member = this.isLiveMember(id);
    if (!member && !this.storage.paired.get(id)) return { error: 'not_found' };
    if (member) {
      const refused = this.notPrimary();
      if (refused) return refused;
      const identity = this.host.identity();
      if (identity) {
        this.tryRoster('remove a member', () => {
          const state = this.storage.roster.read();
          const next = state.roster && nextRoster(state.roster, identity, { remove: [id] }, this.host.now(), this.highest());
          if (next) this.setRoster({ ...state, roster: next });
        });
      }
    } else {
      // A pair of its own, outside any group: it ends now.
      this.finishExit(id);
      this.host.changed();
    }
    await Promise.all([...this.revoking]);
    return { ok: true };
  }

  /**
   * This device leaves its group. The primary dissolves it: it signs a last
   * version that names it alone, and ends every pair with a member once that
   * version reached it. A member signs a left notice and sends it to every
   * member it reaches; it leaves only once one of them acknowledged it
   * within `LEAVE_ACK_TIMEOUT_MS`, and otherwise answers `offline` and
   * leaves nothing — the group would never hear of it. Its pairs then end
   * as each member acknowledges the notice. Only while the relay is online;
   * `failed` when the roster could not be written.
   */
  leave(): Promise<RemoveResult> {
    // A second call while one runs (two taps, two screens) waits for the same answer: a
    // second notice would take the one waiter the first is listening on.
    this.leaveRun ??= this.leaveOnce().finally(() => { this.leaveRun = null; });
    return this.leaveRun;
  }

  private async leaveOnce(): Promise<RemoveResult> {
    const identity = this.host.identity();
    const relay = this.host.relay();
    if (identity === null || !relay || relay.status !== 'online') return { error: 'offline' };
    const self = deviceId(identity.publicKey);
    let state: RosterState;
    try {
      state = this.storage.roster.read();
    } catch (err) {
      this.host.log(`could not leave the group: ${err instanceof Error ? err.message : String(err)}`);
      return { error: 'failed' };
    }
    const doc = state.roster;
    // A member that holds no document (one stored was dropped, or a join whose roster never came)
    // cannot tell its group: `failed`, and forgetting the group on this device stays the way out.
    if (!doc || doc.dissolved) return this.storage.membership.get()?.member ? { error: 'failed' } : { ok: true };
    const members = memberIds(state).filter((id) => id !== self);
    const links = new Map(rosterMembers(state).map((m) => [m.id, m.links]));
    if (doc.group === self) {
      try {
        const last = dissolveRoster(doc, identity, this.highest());
        if (!last) throw new Error('the roster is at its last version');
        const ending: RosterState = { roster: last, descriptions: [], left: [] };
        this.becomeAlone(ending, members, links, last.version);
      } catch (err) {
        this.host.log(`could not leave the group: ${err instanceof Error ? err.message : String(err)}`);
        return { error: 'failed' };
      }
      await Promise.all([...this.revoking]);
      return { ok: true };
    }
    const ending: RosterState = { roster: null, descriptions: [], left: [leftNotice(identity, doc, this.host.now())] };
    const reached = members.filter((id) => this.storage.paired.get(id) !== null && this.host.channel(id)?.groups === true);
    if (reached.length === 0) return { error: 'offline' };
    const digest = exitDigest(ending);
    const acked = await new Promise<string | null>((resolve) => {
      const send = () => { for (const id of reached) this.host.channel(id)?.sendGroup({ t: 'roster', ...ending }); };
      const again = setInterval(send, LEAVE_RESEND_MS);
      const timer = setTimeout(() => { clearInterval(again); resolve(null); }, LEAVE_ACK_TIMEOUT_MS);
      (again as { unref?: () => void }).unref?.();
      (timer as { unref?: () => void }).unref?.();
      this.leaving = { state: ending, digest, acked: (from) => { clearTimeout(timer); clearInterval(again); resolve(from); } };
      send();
    });
    this.leaving = null;
    if (acked === null) return { error: 'offline' };
    try {
      this.becomeAlone(ending, members, links, doc.version, acked);
    } catch (err) {
      this.host.log(`could not leave the group: ${err instanceof Error ? err.message : String(err)}`);
      return { error: 'failed' };
    }
    await Promise.all([...this.revoking]);
    return { ok: true };
  }

  /**
   * Before this device forgets its group (the phone, once it left): every
   * exit still waiting ends now and every pending revoke is posted, since
   * nothing would post them once the stored group is gone. A member that has
   * not heard the left notice yet learns of it from the primary's next version.
   */
  async endExits(): Promise<void> {
    this.tryRoster('end the exits before forgetting the group', () => {
      for (const exit of this.storage.exits.list()) this.finishExit(exit.id);
      for (const id of this.storage.pendingRevokes.list()) this.revokeAtRelay(id);
    });
    await Promise.all([...this.revoking]);
  }

  /** The highest version this device took of its group, which the next one it signs goes above. */
  private highest(): number {
    return this.storage.membership.get()?.version ?? 0;
  }

  /**
   * The only way the roster changes. The primary first leaves out every
   * member whose left notice holds, in a new version; this device's own
   * description is signed afresh whenever it does not say what this device
   * says of itself. Unchanged, it does nothing: that is what ends an
   * exchange between two members once they agree. Changed, it applies what
   * the change removed, publishes the status and offers the new digest on
   * every group channel but `from`, the one the change came in on.
   */
  setRoster(next: RosterState, from?: string): boolean {
    const before = this.storage.roster.read();
    const membershipBefore = this.storage.membership.get();
    const state = this.describedSelf(this.honoured(normalize(next)));
    if (!this.storage.roster.replace(state)) return false;
    const doc = state.roster;
    const self = this.host.knownId();
    const m = membershipBefore;
    if (doc && !doc.dissolved && self !== null && memberIds(state).includes(self)
      && (m === null || !m.member || ofGroup(doc, m))) {
      const highest = m !== null && ofGroup(doc, m) ? m.version : 0;
      this.storage.membership.set({ group: doc.group, founding: doc.founding, version: Math.max(doc.version, highest), member: true });
    }
    this.applyRemovals(before, state, membershipBefore);
    this.host.changed();
    const digest = this.storage.roster.digest();
    for (const [id, channel] of this.host.channels()) {
      if (id !== from) channel.sendGroup({ t: 'roster_digest', digest });
    }
    this.link();
    return true;
  }

  /** On the primary: a version without every member whose left notice holds. */
  private honoured(state: RosterState): RosterState {
    const identity = this.host.identity();
    const doc = state.roster;
    if (!identity || !doc || doc.group !== deviceId(identity.publicKey) || state.left.length === 0) return state;
    const next = nextRoster(doc, identity, { remove: state.left.map((n) => n.id) }, this.host.now(), this.highest());
    return next ? normalize({ ...state, roster: next }) : state;
  }

  /** `state` with this device's description in its own words, while it is a member; the same object when it is already. */
  private describedSelf(state: RosterState): RosterState {
    const identity = this.host.identity();
    if (!identity) return state;
    const self = deviceId(identity.publicKey);
    if (!memberIds(state).includes(self)) return state;
    const { name, os, links } = this.host.about();
    const held = descriptionOf(state, self);
    if (held && held.by === self && held.name === name && held.os === os && held.links === links) return state;
    const own = describeDevice(self, { name, os, links }, identity, this.host.now(), held);
    return normalize({ ...state, descriptions: [...state.descriptions.filter((d) => d.id !== self), own] });
  }

  /**
   * What a write changed in who is a member. Within one group (the same
   * founding): every member the new state no longer holds has its pair ended
   * (`endPair`), and a version that no longer names this device, or that
   * dissolves the group, makes it alone. A change of group (joining one)
   * ends nothing: a device this one paired before it joined keeps its pair.
   * A device that held no document of its group (one it stored was dropped)
   * was a member of it. Even the device the change came from is sent it
   * and waited for: its acknowledgement of what it sent must reach it first.
   */
  private applyRemovals(before: RosterState, after: RosterState, membershipBefore: Membership | null): void {
    const self = this.host.knownId();
    const doc = after.roster;
    if (!doc || self === null) return;
    const prior = before.roster;
    const same = prior !== null
      ? prior.group === doc.group && prior.founding === doc.founding
      : membershipBefore !== null && membershipBefore.member && ofGroup(doc, membershipBefore);
    if (!same) return;
    const links = new Map([...rosterMembers(before), ...rosterMembers(after)].map((m) => [m.id, m.links]));
    const was = memberIds(before);
    const wasMember = was.includes(self) || prior === null;
    const now = new Set(memberIds(after));
    if ((doc.dissolved && doc.group !== self) || (wasMember && !now.has(self) && !doc.dissolved)) {
      const members = [...new Set([...was, ...doc.members.map((m) => m.id)])].filter((id) => id !== self);
      // The primary's name as this device last held it: a dissolved document travels with no descriptions.
      const name = descriptionOf(before, doc.group)?.name ?? descriptionOf(after, doc.group)?.name ?? doc.group.slice(0, 8);
      const ended: GroupEnded = { why: doc.dissolved ? 'dissolved' : 'removed', by: { id: doc.group, name } };
      this.becomeAlone(after, members, links, doc.version, undefined, ended);
      return;
    }
    for (const id of was) if (id !== self && !now.has(id)) this.endPair(id, after, links.get(id) ?? false);
  }

  /**
   * The pair with a device the group no longer holds here ends once
   * `ending` reached it: it is kept, as a pending exit, and `ending` is sent
   * at once and again at each channel to it (`channelReady`) until the device
   * acknowledges it (`roster_ack`); nothing is served to it meanwhile. A
   * device that does not take group messages (`links` false: a shipped
   * phone, a Mac from before groups), or that acknowledged it already
   * (`delivered`), ends at once. With no pair here, only a mutual half
   * waiting at the relay goes.
   */
  private endPair(id: string, ending: RosterState, links: boolean, delivered = false): void {
    if (!this.storage.paired.get(id)) {
      this.revokeAtRelay(id);
      return;
    }
    if (delivered || !links) {
      this.finishExit(id);
      return;
    }
    const held = this.storage.exits.list().find((e) => e.id === id);
    this.storage.exits.set({ id, state: ending, since: held?.since ?? this.host.now() });
    this.deliverExit(id);
  }

  /** Sends `id` the document that ends its pair, while a channel that carries group messages is open. */
  private deliverExit(id: string): void {
    const exit = this.storage.exits.list().find((e) => e.id === id);
    const channel = this.host.channel(id);
    if (exit?.state && channel?.groups) channel.sendGroup({ t: 'roster', ...exit.state });
  }

  /**
   * A pair whose end the other side heard of (or never could): its channel
   * and the host's state for it go, its row, and its pair at the relay —
   * posted even with no row, so the relay also drops a mutual half.
   */
  private finishExit(id: string): void {
    this.storage.exits.remove(id);
    this.host.forget(id);
    this.storage.paired.remove(id);
    this.revokeAtRelay(id);
    this.host.changed();
  }

  /**
   * This device is no member of its group any more: it removed, left, or
   * was dissolved at `version`, which it records (`Membership.member`
   * false), so nothing at or below it is taken again. Each pair with a
   * member of that group ends once `ending` reached it (`endPair`; `done`
   * heard it already); a pair with a device that was never in the group
   * stays. Then it holds no roster. `ended`: another did it (`GroupEnded`),
   * kept for the notice; leaving by its own hand keeps none.
   */
  private becomeAlone(
    ending: RosterState, members: string[], links: Map<string, boolean>, version: number, done?: string, ended?: GroupEnded,
  ): void {
    const m = this.storage.membership.get();
    const doc = ending.roster ?? this.storage.roster.read().roster;
    if (doc) {
      const highest = m !== null && ofGroup(doc, m) ? m.version : 0;
      this.storage.membership.set({
        group: doc.group, founding: doc.founding, version: Math.max(version, highest), member: false, ...(ended ? { ended } : {}),
      });
    }
    for (const id of members) this.endPair(id, ending, links.get(id) ?? false, id === done);
    this.host.leftGroup();
    if (this.storage.roster.replace(EMPTY_ROSTER)) this.host.changed();
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
   * Asks the relay for a mutual pair with every member this device links
   * with (`linksWith`: never a phone from a phone) and is not paired with
   * yet, each once per relay connection (ADR
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
    for (const m of rosterMembers(this.storage.roster.read())) {
      if (!linksWith(selfKind, m) || m.id === self || asked.has(m.id) || (!paired && this.storage.paired.get(m.id))) continue;
      const id = m.id;
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
   * The relay paired this device with `peer`. Only a member the roster
   * holds, and that links, becomes a paired device — never one on the
   * relay's word alone. Both the control and the post's answer can say so;
   * the second changes nothing.
   */
  private onLinked(peer: string): void {
    const state = this.storage.roster.read();
    const member = rosterMembers(state).find((m) => m.id === peer);
    const self = this.ownId;
    if (self === null || peer === self) return;
    // Asked for while it was a member, and the version that left it out came before the pair: it goes again.
    if (!member && state.roster) {
      this.host.log(`revoked a link with ${peer.slice(0, 8)}: not a member of the group`);
      this.revokeAtRelay(peer);
      return;
    }
    // A member that does not link (a shipped phone) is never asked for, so a `linked` for one is not ours.
    if (!member || !member.links) {
      this.host.log(`ignored a link with ${peer.slice(0, 8)}: no member of the group that links`);
      return;
    }
    // Two phones: neither answers a handshake, so the pair would only retry for ever. It goes,
    // with a row a phone from before this rule may have kept for it.
    if (!linksWith(this.host.about().kind, member)) {
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
      this.storage.paired.add({ id: peer, name: member.name, platform: member.os, kind: member.kind, pairedAt: this.host.now() });
      this.storage.pendingRevokes.remove(peer);
      this.host.paired(peer);
      this.host.changed();
    }
    this.host.open(peer);
  }

  /**
   * At start. A device that is not a phone, holds no roster and holds
   * paired phones (a Mac from before groups) founds its group with them, as
   * its primary: version 1 names it and every phone, described as their
   * pairs name them. A member signs its own description afresh: a rename
   * made while the remote was off reached no roster.
   */
  addSelf(): void {
    this.sweepExits();
    const identity = this.host.identity();
    if (!identity) return;
    const state = this.storage.roster.read();
    if (state.roster) {
      this.setRoster(state);
      return;
    }
    // A join under way: this device founds nothing of its own meanwhile.
    if (this.pendingJoin()) return;
    const { kind } = this.host.about();
    const phones = this.storage.paired.list().filter((d) => (d.kind ?? 'phone') === 'phone').slice(0, ROSTER_MAX_ENTRIES - 1);
    if (kind === 'phone' || phones.length === 0) return;
    const now = this.host.now();
    const doc = foundRoster(identity, kind, phones.map((d) => ({ id: d.id, kind: 'phone' })), now);
    if (!doc) return;
    this.setRoster({
      roster: doc,
      descriptions: phones.map((d) => describeDevice(d.id, { name: d.name, os: osName(d.platform), links: false }, identity, now)),
      left: [],
    });
  }

  /**
   * Whether this device can add `id`: it is a member already; or this
   * device is its group's primary and the roster has room; or it holds no
   * group and is no phone, so it founds one. A roster that cannot be read
   * takes none.
   */
  canAdd(id: string): boolean {
    const self = this.ownId;
    if (self === null || this.pendingJoin()) return false;
    try {
      const state = this.storage.roster.read();
      const doc = state.roster;
      if (memberIds(state).includes(id)) return true;
      if (!doc || doc.dissolved) return this.host.about().kind !== 'phone';
      return doc.group === self && doc.members.length < ROSTER_MAX_ENTRIES;
    } catch {
      return false;
    }
  }

  /**
   * Adds a device a pairing with this one proved: the primary signs the
   * next version naming it, with its description as the pairing named it;
   * a device in no group founds one, signing version 1 that names both. A
   * member already is kept as it is (pairing by hand). False when this
   * device may not add it (`canAdd`), so the pairing is undone rather than
   * left half written.
   */
  addPaired(device: AddedDevice): boolean {
    let added = false;
    this.tryRoster('add a paired device', () => {
      const identity = this.host.identity();
      if (!identity) return;
      const state = this.storage.roster.read();
      if (memberIds(state).includes(device.id)) {
        added = true;
        return;
      }
      if (!this.canAdd(device.id)) return;
      const now = this.host.now();
      const founding = !state.roster || state.roster.dissolved === true;
      const doc = founding
        ? foundRoster(identity, this.host.about().kind, [device], now)
        : nextRoster(state.roster!, identity, { add: [device] }, now, this.highest());
      if (!doc) return;
      const about = describeDevice(device.id, device, identity, now);
      const descriptions = founding ? [about] : [...state.descriptions, about];
      this.setRoster({ roster: doc, descriptions, left: founding ? [] : state.left });
      added = memberIds(this.storage.roster.read()).includes(device.id);
    });
    return added;
  }

  /**
   * Each side sends its digest as the channel opens; a difference is
   * answered with the roster. A device whose pair is ending is sent the
   * document that ends it instead.
   */
  channelReady(id: string, channel: GroupChannel): void {
    if (!channel.groups) return;
    // A channel that came up while this device waits to leave: the notice goes there too.
    if (this.leaving) channel.sendGroup({ t: 'roster', ...this.leaving.state });
    if (this.exiting(id)) {
      this.tryRoster('send an exit', () => this.deliverExit(id));
      return;
    }
    channel.sendGroup({ t: 'roster_digest', digest: this.storage.roster.digest() });
  }

  /**
   * A peer's hello. A member's description is its own to write: the
   * primary writes what the hello says only while the device has not
   * described itself (a device that never signs, a shipped phone, or a Mac
   * from before groups). `kind` is never taken from a hello.
   */
  onPeerHello(from: string, channel: GroupChannel, hello: HelloMessage): void {
    this.tryRoster('describe a peer', () => {
      const identity = this.host.identity();
      if (!identity || !this.isPrimary()) return;
      const state = this.storage.roster.read();
      if (!memberIds(state).includes(from)) return;
      const held = descriptionOf(state, from);
      if (held?.by === from) return;
      const about = {
        name: hello.name ?? hello.macName ?? held?.name ?? from.slice(0, 8), os: hello.os ?? held?.os ?? '', links: channel.groups,
      };
      if (held && held.name === about.name && held.os === about.os && held.links === about.links) return;
      const next = describeDevice(from, about, identity, this.host.now(), held);
      // `from` is skipped: the channel's own `ready` follows with the digest.
      this.setRoster({ ...state, descriptions: [...state.descriptions.filter((d) => d.id !== from), next] }, from);
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
    if (msg.t === 'roster_ack') {
      this.tryRoster('take an acknowledgement', () => {
        if (this.leaving?.digest === msg.digest) this.leaving.acked(from);
        const exit = this.storage.exits.list().find((e) => e.id === from);
        if (exit?.state && exitDigest(exit.state) === msg.digest) this.finishExit(from);
      });
      return;
    }
    if (msg.t === 'roster_digest') {
      this.tryRoster('answer a roster digest', () => {
        if (this.exiting(from)) this.deliverExit(from);
        else if (msg.digest !== this.storage.roster.digest()) channel.sendGroup({ t: 'roster', ...this.storage.roster.read() });
      });
      return;
    }
    const theirs: RosterState = { roster: msg.roster, descriptions: msg.descriptions, left: msg.left };
    this.tryRoster('take a roster', () => {
      const self = this.ownId;
      if (self === null) return;
      this.pendingJoin();
      const next = takeRoster(this.storage.roster.read(), theirs, {
        self, membership: this.storage.membership.get(), from,
      });
      this.setRoster(next, from);
    });
    // Heard: the sender may be waiting for this before it ends the pair.
    this.tryRoster('acknowledge a roster', () => channel.sendGroup({ t: 'roster_ack', digest: exitDigest(theirs) }));
    // The sender may still lack what only this side holds: answered only
    // when the sender would take something of it, so two members that hold
    // what the other does not take do not trade rosters forever.
    this.tryRoster('answer a roster', () => {
      const ours = this.storage.roster.read();
      if (!ours.roster) return;
      // A sender that holds no document is taken to be of this group, as its stored membership would say.
      const of = theirs.roster ?? ours.roster;
      const would = takeRoster(theirs, ours, {
        self: from, membership: { group: of.group, founding: of.founding, version: theirs.roster?.version ?? 0, member: true },
        trusted: true,
      });
      if (rosterKey(would) !== rosterKey(theirs)) channel.sendGroup({ t: 'roster', ...ours });
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
