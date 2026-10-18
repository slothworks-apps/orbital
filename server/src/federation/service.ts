/**
 * Every group member's sessions in this server's hub (spec
 * 2026-10-16-device-group-design § 7). For each member that runs sessions
 * and takes part in the group, this server subscribes to its `sessions`
 * topic over their channel, keeps its sessions in memory, republishes them
 * into the local hub marked with their machine, and carries every request
 * for one of them through that channel. A member that goes offline keeps
 * its last sessions, shown offline. What a member tells us about a third
 * device is never taken in, and nothing here is passed on to another member
 * (no chaining: `ServingHalf` withholds what this holds).
 */
import { PRESENCE_TOPIC, presenceFromFrame } from '@orbital/shared/presence';
import {
  bytesMatchRef, TunnelError, type BlobResult, type Channel, type FileResult, type HttpMethod, type TunnelResponse,
} from '@orbital/shared/remote/channel';
import type { MachineEvent, MachineRef } from '@orbital/shared/remote/device';
import type { FileAs, HelloMessage } from '@orbital/shared/remote/messages';
import type { RosterEntry } from '@orbital/shared/remote/roster';
import { isSafeId, sessionOfRequest, sessionOfTopic } from '@orbital/shared/remote/segments';
import type { Hub } from '../api/hub.js';
import { memberTooOld } from '../remote/memberGate.js';
import type { RemoteService } from '../remote/service.js';
import { carriesMachine } from '../remote/servingHalf.js';
import { ReadCache } from './readCache.js';
import type { MemberSnapshotStore } from './store.js';

/** How many sessions are asked of a member at once; one channel frame has to carry the answer. */
const SEED_LIMITS = [200, 80, 30];

/**
 * The most sessions held of one member, by seed and by upsert together: a
 * member that announces more has the new ones dropped, logged once while it
 * stays full.
 */
export const MEMBER_SESSIONS_MAX = 1000;

/**
 * How long a member's changes gather before its snapshot is written. The
 * snapshot only stands in after a crash — going offline and stopping write
 * at once — so it is written seldom, and a change of a session's `status`
 * or `lastAt` alone schedules no write.
 */
export const SNAPSHOT_WRITE_MS = 60_000;

/**
 * How long a member whose list could not be read waits before it is asked
 * again, doubling at each failure up to `SEED_RETRY_MAX_MS`, while its
 * channel stays up. Until a list is read its sessions stay shown offline.
 */
export const SEED_RETRY_MS = 5_000;
export const SEED_RETRY_MAX_MS = 5 * 60_000;

export type Session = { id: string; tagIds?: number[]; status?: string; machine?: unknown; [key: string]: unknown };
export type Tag = { id: number; name: string; hue?: number };

export type MemberLink = {
  id: string;
  sessions: Map<string, Session>;
  /** The member's tags by id, read at every seed. */
  tags: Map<number, Tag>;
  /** The newest channel to the member; null before one. */
  channel: Channel | null;
  /** When the member was last heard from, while it is offline; null while it is up. */
  seenAt: number | null;
  /** The member as the roster describes it: its machine's name, kind and OS. */
  entry: RosterEntry;
  /** This channel's ready spell has been engaged and seeded; cleared when it ends. */
  seeded: boolean;
  /** The user is at this member, by its own `presence`; false while its channel is not ready. */
  present: boolean;
  /** A seed asked again after its list could not be read (`SEED_RETRY_MS`), and how many failed in a row. */
  seedRetry?: ReturnType<typeof setTimeout>;
  seedFailures?: number;
  /** A session past `MEMBER_SESSIONS_MAX` was dropped and said so; cleared once there is room again. */
  full?: boolean;
};

export type FederationOptions = {
  hub: Hub;
  remote: Pick<RemoteService, 'onChannel' | 'onStatus' | 'peerHello' | 'liveMembers' | 'channel'> & { selfId(): string | null };
  /** This server's tags: a member's tags are matched to them by name. */
  localTags: () => Tag[];
  /** Whether `id` is a session of this device: such an id is never expected of a member. */
  localSession?: (id: string) => boolean;
  /** Where each member's last sessions are kept across restarts; absent, they are not. */
  snapshots?: Pick<MemberSnapshotStore, 'load' | 'save' | 'remove'>;
  /** Where reads of a member's sessions are kept for while it is offline; a default-sized one when absent. */
  readCache?: ReadCache;
  now?: () => number;
};

/** A member's answer; `asOf` when it is a kept copy, answered while the member is offline. */
export type ReadResponse = TunnelResponse & { asOf?: number };

export class FederationService {
  private readonly links = new Map<string, MemberLink>();
  /** The newest channel to each member and how to stop listening to it. */
  private readonly channels = new Map<string, { channel: Channel; off: () => void }>();
  /** Per-session topics some local window holds, whoever's session they are about. */
  private readonly localTopics = new Set<string>();
  /**
   * Sessions being spawned on a member from here, by id, to that member's id:
   * its frames about them are taken in before its list carries them.
   */
  private readonly expected = new Map<string, string>();
  /** This device's tag ids by name; null until read again after a tag changed. */
  private localTagMap: Map<string, number> | null = null;
  /** A snapshot write waiting out `SNAPSHOT_WRITE_MS`, per member. */
  private readonly pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
  private offs: (() => void)[] = [];
  private running = false;
  private hubHooked = false;
  /** Every snapshot row went when this device was last found alone in its group. */
  private cleared = false;
  private readonly readCache: ReadCache;
  private readonly now: () => number;

  constructor(private readonly opts: FederationOptions) {
    this.now = opts.now ?? Date.now;
    this.readCache = opts.readCache ?? new ReadCache();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // The hub cannot take a hook back: they stay, and do nothing while stopped.
    if (!this.hubHooked) {
      this.hubHooked = true;
      this.opts.hub.onFirstSubscriber((topic) => this.followTopic(topic, true));
      this.opts.hub.onLastUnsubscriber((topic) => this.followTopic(topic, false));
    }
    this.restore();
    this.offs = [
      this.opts.remote.onChannel((id, channel) => this.attach(id, channel)),
      this.opts.remote.onStatus(() => this.rosterChanged()),
    ];
    for (const entry of this.opts.remote.liveMembers()) {
      const channel = this.opts.remote.channel(entry.id);
      if (!channel) continue;
      this.attach(entry.id, channel);
      // Up already: no hello or ready is coming to engage it.
      if (channel.ready) this.engage(entry.id, channel, entry);
    }
    this.rosterChanged();
  }

  stop(): void {
    // A member up until now was heard from now; one with changes waiting has them kept.
    for (const link of this.links.values()) {
      if (link.channel?.ready || this.pendingWrites.has(link.id)) this.writeSnapshot(link);
    }
    this.running = false;
    for (const link of this.links.values()) this.clearSeedRetry(link);
    for (const off of this.offs) off();
    this.offs = [];
    for (const { off } of this.channels.values()) off();
    this.channels.clear();
    this.links.clear();
    this.expected.clear();
    this.readCache.clear();
  }

  /** The member a session belongs to; null for this device's own and for one nobody knows. */
  linkOf(sessionId: string): MemberLink | null {
    for (const link of this.links.values()) if (link.sessions.has(sessionId)) return link;
    const expected = this.expected.get(sessionId);
    return expected === undefined ? null : this.links.get(expected) ?? null;
  }

  /**
   * A spawn of `sessionId` on `link` is about to go out. The windows here
   * subscribed to its topics before it exists (the browser mints the id), so
   * the member is asked for them first: the channel is ordered, and the
   * spawn's first frames would otherwise be gone before its list names it.
   */
  expect(link: MemberLink, sessionId: string): void {
    // This device's own session must not be taken for the member's: its topics would go there.
    if (!isSafeId(sessionId) || this.linkOf(sessionId) !== null || this.opts.localSession?.(sessionId)) return;
    this.expected.set(sessionId, link.id);
    this.followSession(link, sessionId);
  }

  /** The spawn `expect` announced did not happen: the member's topics for it are given back. */
  unexpect(link: MemberLink, sessionId: string): void {
    if (this.expected.get(sessionId) !== link.id) return;
    this.expected.delete(sessionId);
    for (const topic of this.localTopics) {
      if (sessionOfTopic(topic) === sessionId) link.channel?.unsubscribe(topic);
    }
  }

  /** This device's tags changed: the next session shown reads them again. */
  tagsChanged(): void {
    this.localTagMap = null;
  }

  link(memberId: string): MemberLink | null {
    return this.links.get(memberId) ?? null;
  }

  /** Whether the user is at some other member that has `presence`: the phone keeps quiet then too (spec § 10). */
  presentElsewhere(): boolean {
    for (const link of this.links.values()) if (link.present && link.channel?.ready) return true;
    return false;
  }

  /** Every member's sessions as this device shows them. */
  sessions(): Session[] {
    return [...this.links.values()].flatMap((l) => [...l.sessions.values()].map((s) => this.localize(l, s)));
  }

  /** A list the member answered, as this device shows it: a third device's sessions left out. */
  localizeList(link: MemberLink, list: Session[]): Session[] {
    return list.filter((s) => s && typeof s.id === 'string' && isSafeId(s.id) && !carriesMachine(s)).map((s) => this.localize(link, s));
  }

  async request(link: MemberLink, method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    return this.localizeAnswer(link, await this.ask(link, method, path, body), sessionOfRequest(path));
  }

  /**
   * A GET about the member's session `sessionId`. A 200 is kept; while the
   * member is offline, the kept answer to the same `path` is given instead,
   * with when it was kept.
   */
  async read(link: MemberLink, sessionId: string, path: string): Promise<ReadResponse> {
    if (!link.channel?.ready) {
      const kept = this.readCache.get(link.id, path);
      // Localized now: the copy names the member as it is, offline.
      if (kept) return { ...this.localizeAnswer(link, { status: 200, body: kept.body }, sessionId), asOf: kept.at };
    }
    const res = await this.ask(link, 'GET', path);
    // Not kept when the member or the session left while the answer was on its way.
    if (res.status === 200 && this.links.get(link.id) === link && this.owns(link, sessionId)) {
      this.readCache.put(link.id, sessionId, path, res.body, this.now());
    }
    return this.localizeAnswer(link, res, sessionId);
  }

  /** The member's answer as it came; 409 while it is offline, 502 when the channel failed. */
  private async ask(link: MemberLink, method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    const channel = link.channel;
    if (!channel?.ready) return { status: 409, body: { error: 'member_offline' } };
    try {
      return await channel.request(method, path, body);
    } catch (err) {
      if (err instanceof TunnelError) return { status: 502, body: { error: 'member_unreachable' } };
      throw err;
    }
  }

  /**
   * A session in a member's answer, as this device shows it. Only the
   * session the request named (`asked`) is passed on: a member answering
   * with another id would claim it here, so that `session` is left out.
   */
  private localizeAnswer(link: MemberLink, res: TunnelResponse, asked: string | null): TunnelResponse {
    const payload = res.body as { session?: Session } | null;
    if (payload && typeof payload === 'object' && payload.session && typeof payload.session === 'object') {
      // A third device's session, as the member shows it, or one the request did not name: not ours to pass on.
      if (payload.session.id !== asked || carriesMachine(payload.session)) {
        const { session: _chained, ...rest } = payload;
        return { status: res.status, body: rest };
      }
      return { status: res.status, body: { ...payload, session: this.localize(link, payload.session) } };
    }
    return res;
  }

  /** `PUT /api/sessions/:id/tags` on a member: this device's tag ids become the member's, by name. */
  async setTags(link: MemberLink, sessionId: string, localIds: number[]): Promise<TunnelResponse> {
    const memberIds: number[] = [];
    for (const id of localIds) {
      const memberId = await this.peerTagId(link, id);
      if (memberId !== null) memberIds.push(memberId);
    }
    return this.request(link, 'PUT', `/api/sessions/${sessionId}/tags`, { tagIds: memberIds });
  }

  /** The member's tag of the same name as this device's tag `localId`, made there when it has none. */
  async peerTagId(link: MemberLink, localId: number): Promise<number | null> {
    const tag = this.opts.localTags().find((t) => t.id === localId);
    if (!tag) return null;
    for (const t of link.tags.values()) if (t.name === tag.name) return t.id;
    const made = await this.request(link, 'POST', '/api/tags', { name: tag.name, hue: tag.hue ?? 0 });
    const madeId = (made.body as { id?: unknown } | null)?.id;
    if (made.status !== 201 || typeof madeId !== 'number') return null;
    link.tags.set(madeId, { id: madeId, name: tag.name, hue: tag.hue });
    this.scheduleSnapshot(link);
    return madeId;
  }

  /**
   * A composer's images go to the member's own store before the message
   * that names them; the store names an image by its hash, so the refs come
   * back as they went. Null when one could not be sent.
   */
  async upload(link: MemberLink, refs: string[], read: (ref: string) => { bytes: Uint8Array; mediaType: string } | null): Promise<string[] | null> {
    const out: string[] = [];
    for (const ref of refs) {
      const image = read(ref);
      const channel = link.channel;
      if (!image || !channel?.ready) return null;
      try {
        const res = await channel.putBlob(image.bytes, image.mediaType);
        if (res.kind !== 'ok') return null;
        out.push(res.entry.ref);
      } catch (err) {
        // The channel failing is the member's; anything else is a bug here, as in `ask`.
        if (err instanceof TunnelError) return null;
        throw err;
      }
    }
    return out;
  }

  /**
   * A stored image of some member's session, by ref (`<sha256>.<ext>`):
   * asked of every member that is up at once, the first whose bytes are the
   * ref's answers. A member answering other bytes does not end the search.
   */
  async blob(ref: string): Promise<BlobResult | null> {
    const asks = [...this.links.values()].flatMap((link) => {
      const channel = link.channel;
      if (!channel?.ready) return [];
      return [channel.getBlob(ref).then((res) => (
        res.status === 200 && bytesMatchRef(ref, res.bytes)
          ? res : Promise.reject(new Error('not held'))
      ))];
    });
    try {
      return await Promise.any(asks);
    } catch {
      return null;
    }
  }

  async file(link: MemberLink, sessionId: string, path: string, as: FileAs, cwd?: string): Promise<FileResult | null> {
    const channel = link.channel;
    if (!channel?.ready) return null;
    try {
      return await channel.getFile(sessionId, path, as, cwd ? { cwd } : {});
    } catch (err) {
      if (err instanceof TunnelError) return null;
      throw err;
    }
  }

  /** Listens to a new channel to `id`; an older one to the same member is ignored from now on. */
  private attach(id: string, channel: Channel): void {
    if (!this.running || id === this.opts.remote.selfId()) return;
    this.channels.get(id)?.off();
    const off = channel.on((event) => {
      if (this.channels.get(id)?.channel !== channel) return;
      switch (event.type) {
        case 'hello':
          this.engage(id, channel);
          return;
        case 'ready':
          if (event.ready) this.engage(id, channel);
          else this.offline(id, channel);
          return;
        case 'closed':
          this.offline(id, channel);
          off();
          this.channels.delete(id);
          return;
        case 'hub': {
          const link = this.links.get(id);
          if (link?.channel === channel) this.onHub(link, event.frame);
          return;
        }
      }
    });
    this.channels.set(id, { channel, off });
  }

  /**
   * A member federates when it is live in the roster, not a phone, and its
   * hello names `sessions` and `group`. One whose hello names neither may be
   * a shipped Mac: it is left alone, nothing is sent to it.
   */
  private federates(entry: RosterEntry, hello: HelloMessage | null): boolean {
    if (entry.kind === 'phone' || entry.id === this.opts.remote.selfId() || hello === null) return false;
    return hello.capabilities?.includes('sessions') === true && !memberTooOld(entry.kind, hello);
  }

  /** Subscribes to a member that federates over `channel`, and seeds it once per ready spell. */
  private engage(id: string, channel: Channel, entry?: RosterEntry): void {
    const member = entry ?? this.opts.remote.liveMembers().find((e) => e.id === id);
    const existing = this.links.get(id);
    const hello = channel.peer ?? this.opts.remote.peerHello(id);
    if (!member || !this.federates(member, hello)) {
      if (existing) this.drop(existing);
      return;
    }
    const link: MemberLink = existing ?? {
      id, sessions: new Map(), tags: new Map(), channel: null, seenAt: null, entry: member, seeded: false, present: false,
    };
    this.links.set(id, link);
    link.entry = member;
    if (link.channel !== channel) {
      link.channel = channel;
      link.seeded = false;
      link.present = false;
      this.clearSeedRetry(link);
    }
    channel.subscribe('sessions');
    // The member answers at once with where the user is, and again at every change.
    if (hello?.capabilities?.includes('presence')) channel.subscribe(PRESENCE_TOPIC);
    for (const topic of this.localTopics) {
      const session = sessionOfTopic(topic);
      if (session !== null && this.owns(link, session)) channel.subscribe(topic);
    }
    if (channel.ready && !link.seeded) {
      link.seeded = true;
      this.startSeed(link, channel);
    }
  }

  /**
   * The member's channel went down: its sessions stay, shown offline as of
   * now, and kept so. Ones shown offline already (a seed that failed) keep
   * the date they had: nothing newer was read of them.
   */
  private offline(id: string, channel: Channel): void {
    const link = this.links.get(id);
    if (!link || link.channel !== channel) return;
    link.present = false;
    this.clearSeedRetry(link);
    if (!link.seeded) return;
    link.seeded = false;
    if (link.seenAt === null) {
      link.seenAt = this.now();
      this.publishMachine(link);
    }
    this.writeSnapshot(link);
  }

  /** Whether `link` still rides `channel`, up: an answer that arrives after is dropped. */
  private current(link: MemberLink, channel: Channel): boolean {
    return this.running && this.links.get(link.id) === link && link.channel === channel && channel.ready;
  }

  /** Seeds `link` over `channel`; a list that could not be read is asked again (`seedFailed`). */
  private startSeed(link: MemberLink, channel: Channel): void {
    void this.seed(link, channel).then((seeded) => {
      if (!seeded && this.current(link, channel)) this.seedFailed(link, channel);
    }, (err: unknown) => {
      console.warn(`[federation] could not read ${link.id}'s sessions: ${err instanceof Error ? err.message : String(err)}`);
      if (this.current(link, channel)) this.seedFailed(link, channel);
    });
  }

  /**
   * The member's sessions and tags, read afresh whenever its channel comes
   * up. True once its list is read, or when the answer no longer matters
   * (the channel went); false when the list could not be read: a non-200,
   * a channel failure, or every `SEED_LIMITS` too large for a frame.
   */
  private async seed(link: MemberLink, channel: Channel): Promise<boolean> {
    const tags = await this.request(link, 'GET', '/api/tags');
    if (!this.current(link, channel)) return true;
    const tagList = (tags.body as { tags?: Tag[] } | null)?.tags;
    let tagsChanged = false;
    if (tags.status === 200 && Array.isArray(tagList)) {
      tagsChanged = JSON.stringify([...link.tags.values()]) !== JSON.stringify(tagList);
      link.tags = new Map(tagList.map((t) => [t.id, t]));
    }
    for (const limit of SEED_LIMITS) {
      const res = await this.request(link, 'GET', `/api/sessions?limit=${limit}`);
      if (!this.current(link, channel)) return true;
      if (res.status === 413) continue;
      const list = (res.body as { sessions?: Session[] } | null)?.sessions;
      if (res.status !== 200 || !Array.isArray(list)) return false;
      const fresh = new Map<string, Session>();
      for (const s of list) {
        if (!s || typeof s !== 'object' || typeof s.id !== 'string' || carriesMachine(s) || !this.mayHold(link.id, s.id)) continue;
        if (fresh.size >= MEMBER_SESSIONS_MAX) {
          this.full(link);
          break;
        }
        fresh.set(s.id, s);
      }
      if (fresh.size < MEMBER_SESSIONS_MAX) link.full = false;
      for (const id of link.sessions.keys()) {
        if (fresh.has(id)) continue;
        this.opts.hub.publish('sessions', { event: 'remove', sessionId: id });
        this.readCache.dropSession(link.id, id);
      }
      const before = new Map(link.sessions);
      const wasOffline = link.seenAt !== null;
      link.sessions.clear();
      link.seenAt = null;
      link.seedFailures = 0;
      for (const [id, s] of fresh) {
        link.sessions.set(id, s);
        this.expected.delete(id);
        const held = before.get(id);
        if (!held) this.followSession(link, id);
        // Only what changed goes out as an upsert; the member coming back online is one `machine` frame.
        if (!held || tagsChanged || JSON.stringify(held) !== JSON.stringify(s)) {
          this.opts.hub.publish('sessions', { event: 'upsert', session: this.localize(link, s) });
        }
      }
      if (wasOffline) this.publishMachine(link);
      this.scheduleSnapshot(link);
      return true;
    }
    return false;
  }

  /**
   * The member's list could not be read while its channel stays up: what
   * is shown of it stays offline, as of when it was last read, and the seed
   * is asked again, `SEED_RETRY_MS` doubling up to `SEED_RETRY_MAX_MS`.
   */
  private seedFailed(link: MemberLink, channel: Channel): void {
    if (link.seenAt === null) {
      link.seenAt = this.now();
      this.publishMachine(link);
    }
    const failures = (link.seedFailures ?? 0) + 1;
    link.seedFailures = failures;
    this.clearSeedRetry(link);
    const delay = Math.min(SEED_RETRY_MS * 2 ** (failures - 1), SEED_RETRY_MAX_MS);
    const timer = setTimeout(() => {
      link.seedRetry = undefined;
      if (this.current(link, channel)) this.startSeed(link, channel);
    }, delay);
    timer.unref?.();
    link.seedRetry = timer;
  }

  private clearSeedRetry(link: MemberLink): void {
    clearTimeout(link.seedRetry);
    link.seedRetry = undefined;
  }

  /** A window that subscribed before this member's list carried the id (a spawn from here). */
  private followSession(link: MemberLink, sessionId: string): void {
    for (const topic of this.localTopics) {
      if (sessionOfTopic(topic) === sessionId) link.channel?.subscribe(topic);
    }
  }

  private republish(link: MemberLink): void {
    for (const s of link.sessions.values()) {
      this.opts.hub.publish('sessions', { event: 'upsert', session: this.localize(link, s) });
    }
  }

  /**
   * The member's state changed — online, offline, renamed: one frame that
   * every session of it takes, not an upsert per session. `ServingHalf`
   * withholds it from every peer: it is about another member.
   */
  private publishMachine(link: MemberLink): void {
    if (link.sessions.size === 0) return;
    const event: MachineEvent = { event: 'machine', machine: this.machine(link) };
    this.opts.hub.publish('sessions', event);
  }

  /**
   * Whether member `memberId` may hold a session of this id: one that is a safe path
   * segment, not this device's own, and not held by (or being spawned on)
   * another member. The first to hold an id keeps it: a member must not
   * take over another's session, and with it what is sent to that session.
   */
  private mayHold(memberId: string, id: string): boolean {
    if (!isSafeId(id) || this.opts.localSession?.(id)) return false;
    const expected = this.expected.get(id);
    if (expected !== undefined && expected !== memberId) return false;
    for (const other of this.links.values()) if (other.id !== memberId && other.sessions.has(id)) return false;
    return true;
  }

  /** A session past `MEMBER_SESSIONS_MAX` was dropped: said once while the member stays full. */
  private full(link: MemberLink): void {
    if (link.full) return;
    link.full = true;
    console.warn(`[federation] ${link.id} holds ${MEMBER_SESSIONS_MAX} sessions; more are not taken in`);
  }

  /** Whether `sessionId` is the member's: listed by it, or being spawned on it from here. */
  private owns(link: MemberLink, sessionId: string): boolean {
    return link.sessions.has(sessionId) || this.expected.get(sessionId) === link.id;
  }

  /**
   * A member no longer in the group: its sessions leave the map. The removes
   * go out while the sessions are still known as foreign, so no channel
   * passes them on.
   */
  private drop(link: MemberLink): void {
    for (const id of link.sessions.keys()) this.opts.hub.publish('sessions', { event: 'remove', sessionId: id });
    this.links.delete(link.id);
    this.readCache.dropMember(link.id);
    const expected = [...this.expected].filter(([, member]) => member === link.id).map(([id]) => id);
    for (const id of expected) this.expected.delete(id);
    clearTimeout(this.pendingWrites.get(link.id));
    this.pendingWrites.delete(link.id);
    this.clearSeedRetry(link);
    this.removeSnapshot(link.id);
    const channel = link.channel;
    if (!channel) return;
    channel.unsubscribe('sessions');
    channel.unsubscribe(PRESENCE_TOPIC);
    for (const topic of this.localTopics) {
      const session = sessionOfTopic(topic);
      if (session !== null && (link.sessions.has(session) || expected.includes(session))) channel.unsubscribe(topic);
    }
  }

  private onHub(link: MemberLink, raw: unknown): void {
    const frame = raw as { topic?: unknown; event?: unknown; [key: string]: unknown } | null;
    if (!frame || typeof frame.topic !== 'string') return;
    const { topic, ...rest } = frame;
    // The member's presence is its own: kept for the phone's quiet, never shown as this device's.
    if (topic === PRESENCE_TOPIC) {
      const atMember = presenceFromFrame(frame);
      if (atMember !== null) link.present = atMember;
      return;
    }
    if (topic !== 'sessions') {
      // Only a topic about one of this member's own sessions: it speaks for nothing else here.
      const session = sessionOfTopic(topic);
      if (session === null || !this.owns(link, session)) return;
      if (this.opts.hub.subscriberCount(topic) > 0) this.opts.hub.publish(topic, rest);
      return;
    }
    if (frame.event === 'upsert') {
      const session = frame.session as Session | undefined;
      // Another device's session, passed on by this member: not ours to show (no chaining).
      if (!session || typeof session !== 'object' || typeof session.id !== 'string' || carriesMachine(session)) return;
      if (!this.mayHold(link.id, session.id)) return;
      const held = link.sessions.get(session.id);
      if (!held && link.sessions.size >= MEMBER_SESSIONS_MAX) {
        this.full(link);
        return;
      }
      link.sessions.set(session.id, session);
      this.expected.delete(session.id);
      if (!held) this.followSession(link, session.id);
      this.opts.hub.publish('sessions', { event: 'upsert', session: this.localize(link, session) });
      if (!held || !sameButLive(held, session)) this.scheduleSnapshot(link);
    } else if (frame.event === 'remove') {
      const id = frame.sessionId;
      // Published while still known as foreign, so no channel passes it on.
      if (typeof id !== 'string' || !link.sessions.has(id)) return;
      this.opts.hub.publish('sessions', { event: 'remove', sessionId: id });
      link.sessions.delete(id);
      link.full = false;
      this.readCache.dropSession(link.id, id);
      this.scheduleSnapshot(link);
    } else if (frame.event === 'status') {
      const id = frame.sessionId;
      const session = typeof id === 'string' ? link.sessions.get(id) : undefined;
      if (!session) return;
      if (typeof frame.status === 'string') session.status = frame.status;
      // A status alone schedules no write (`SNAPSHOT_WRITE_MS`).
      this.opts.hub.publish('sessions', rest);
    }
  }

  /**
   * The roster changed, or something else the status shows: a member gone
   * from the group takes its sessions along, a renamed one is republished
   * (names are on the labels), and a member whose channel came up before
   * the roster held it is engaged now.
   */
  private rosterChanged(): void {
    if (!this.running) return;
    const live = new Map(this.opts.remote.liveMembers().map((e) => [e.id, e]));
    // A roster that could not be read (or holds no self yet) says nothing about who left.
    const self = this.opts.remote.selfId();
    if (self === null || !live.has(self)) return;
    if ([...live.values()].every((e) => e.id === self || e.kind === 'phone')) {
      this.alone();
      return;
    }
    this.cleared = false;
    for (const link of [...this.links.values()]) {
      const entry = live.get(link.id);
      if (!entry || entry.kind === 'phone') {
        this.drop(link);
        continue;
      }
      const before = link.entry;
      link.entry = entry;
      if (before.name !== entry.name || before.kind !== entry.kind || before.os !== entry.os) this.publishMachine(link);
    }
    for (const entry of live.values()) {
      if (this.links.has(entry.id)) continue;
      const channel = this.channels.get(entry.id)?.channel;
      if (channel?.ready) this.engage(entry.id, channel, entry);
    }
  }

  /**
   * This device is in a group of one (it left, or was removed): no other
   * member's sessions stay, in memory or on disk. Once per spell alone.
   */
  private alone(): void {
    for (const link of [...this.links.values()]) this.drop(link);
    if (this.cleared) return;
    this.cleared = true;
    try {
      for (const snap of this.opts.snapshots?.load() ?? []) this.removeSnapshot(snap.memberId);
    } catch (err) {
      console.warn(`[federation] could not read the kept sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The members kept from before a restart, offline as of when they were
   * last heard from, until their channels come up. A snapshot of a member
   * no longer in the group goes.
   */
  private restore(): void {
    const store = this.opts.snapshots;
    if (!store) return;
    const live = new Map(this.opts.remote.liveMembers().map((e) => [e.id, e]));
    // A roster that could not be read (or holds no self yet) says nothing about who left.
    const self = this.opts.remote.selfId();
    if (self === null || !live.has(self)) return;
    for (const snap of store.load()) {
      const entry = live.get(snap.memberId);
      if (!entry || entry.kind === 'phone' || entry.id === self) {
        this.removeSnapshot(snap.memberId);
        continue;
      }
      if (this.links.has(entry.id)) continue;
      const link: MemberLink = {
        id: entry.id,
        sessions: new Map(snap.sessions
          .filter((s) => typeof s.id === 'string' && !carriesMachine(s) && this.mayHold(entry.id, s.id))
          .slice(0, MEMBER_SESSIONS_MAX)
          .map((s) => [s.id, s])),
        tags: new Map(snap.tags.map((t) => [t.id, t])),
        channel: null, seenAt: snap.seenAt, entry, seeded: false, present: false,
      };
      this.links.set(link.id, link);
      this.republish(link);
    }
  }

  /** Gathers a member's changes into one write, `SNAPSHOT_WRITE_MS` after the first. */
  private scheduleSnapshot(link: MemberLink): void {
    // A change that lands after `stop()` or a drop (a tag made late) must not hold up a fresh link's write.
    if (!this.running || this.links.get(link.id) !== link) return;
    if (!this.opts.snapshots || this.pendingWrites.has(link.id)) return;
    const timer = setTimeout(() => {
      this.pendingWrites.delete(link.id);
      if (this.links.get(link.id) === link) this.writeSnapshot(link);
    }, SNAPSHOT_WRITE_MS);
    timer.unref?.();
    this.pendingWrites.set(link.id, timer);
  }

  /**
   * Writes a member's snapshot now. `seen_at` is now while the member is up.
   * At most the sessions a seed asks for are kept, the newest by `lastAt`.
   */
  private writeSnapshot(link: MemberLink): void {
    clearTimeout(this.pendingWrites.get(link.id));
    this.pendingWrites.delete(link.id);
    const store = this.opts.snapshots;
    if (!store) return;
    let sessions = [...link.sessions.values()];
    const limit = SEED_LIMITS[0];
    if (sessions.length > limit) {
      const at = (s: Session) => (typeof s.lastAt === 'number' ? s.lastAt : 0);
      sessions = sessions.sort((a, b) => at(b) - at(a)).slice(0, limit);
    }
    // Up and read (no `seenAt`): heard from now. Otherwise as of the last list read.
    const seenAt = link.seenAt ?? this.now();
    try {
      store.save(link.id, sessions, [...link.tags.values()], seenAt);
    } catch (err) {
      console.warn(`[federation] could not keep ${link.id}'s sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private removeSnapshot(memberId: string): void {
    try {
      this.opts.snapshots?.remove(memberId);
    } catch (err) {
      console.warn(`[federation] could not forget ${memberId}'s sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private followTopic(topic: string, on: boolean): void {
    if (sessionOfTopic(topic) === null) return;
    if (on) this.localTopics.add(topic);
    else this.localTopics.delete(topic);
    if (!this.running) return;
    const link = this.linkOf(sessionOfTopic(topic)!);
    if (!link?.channel) return;
    if (on) link.channel.subscribe(topic);
    else link.channel.unsubscribe(topic);
  }

  /** Read once and kept until `tagsChanged`: a member's frames must not each cost a query. */
  private localTagIds(): Map<string, number> {
    this.localTagMap ??= new Map(this.opts.localTags().map((t) => [t.name, t.id]));
    return this.localTagMap;
  }

  /** Online while its channel is up and its list was read on it: a list that failed leaves the sessions as of before. */
  private machine(link: MemberLink): MachineRef {
    const online = link.channel?.ready === true && link.seenAt === null;
    return {
      id: link.id, name: link.entry.name, kind: link.entry.kind, os: link.entry.os, online,
      asOf: online ? null : link.seenAt,
    };
  }

  /** A member's session as this device shows it: its machine named, its tags this device's of the same name. */
  private localize(link: MemberLink, session: Session): Session {
    const local = this.localTagIds();
    const tagIds = (session.tagIds ?? [])
      .map((id) => local.get(link.tags.get(id)?.name ?? ''))
      .filter((id): id is number => id !== undefined);
    return { ...session, tagIds, machine: this.machine(link) };
  }
}

/** The fields that change with every turn: a session that differs in these alone is not worth a snapshot write. */
const LIVE_FIELDS: ReadonlySet<string> = new Set(['status', 'lastAt']);

function sameButLive(a: Session, b: Session): boolean {
  const rest = (s: Session) => JSON.stringify(Object.entries(s).filter(([k]) => !LIVE_FIELDS.has(k)));
  return rest(a) === rest(b);
}
