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
  TunnelError, type BlobResult, type Channel, type FileResult, type HttpMethod, type TunnelResponse,
} from '@orbital/shared/remote/channel';
import type { FileAs, HelloMessage } from '@orbital/shared/remote/messages';
import type { RosterEntry } from '@orbital/shared/remote/roster';
import type { Hub } from '../api/hub.js';
import { memberTooOld } from '../remote/memberGate.js';
import type { RemoteService } from '../remote/service.js';
import { sessionOfTopic } from '../remote/servingHalf.js';
import type { MemberSnapshotStore } from './store.js';

/** How many sessions are asked of a member at once; one channel frame has to carry the answer. */
const SEED_LIMITS = [200, 80, 30];

/**
 * How long a member's changes gather before its snapshot is written: a
 * status change per session must not mean a write per frame.
 */
export const SNAPSHOT_WRITE_MS = 5000;

/**
 * Which device a session runs on; absent on a session of this device.
 * `asOf`: when this device last heard from that member, while it is
 * offline; null while it is online.
 */
export type MachineRef = { id: string; name: string; kind: string; os: string; online: boolean; asOf: number | null };

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
};

export type FederationOptions = {
  hub: Hub;
  remote: Pick<RemoteService, 'onChannel' | 'onStatus' | 'peerHello' | 'liveMembers' | 'channel'> & { selfId(): string | null };
  /** This server's tags: a member's tags are matched to them by name. */
  localTags: () => Tag[];
  /** Where each member's last sessions are kept across restarts; absent, they are not. */
  snapshots?: Pick<MemberSnapshotStore, 'load' | 'save' | 'remove'>;
  now?: () => number;
};

/** A session another device passed on as some third device's: not ours to show. */
function carriesMachine(session: { machine?: unknown }): boolean {
  return session.machine !== undefined && session.machine !== null;
}

export class FederationService {
  private readonly links = new Map<string, MemberLink>();
  /** The newest channel to each member and how to stop listening to it. */
  private readonly channels = new Map<string, { channel: Channel; off: () => void }>();
  /** Per-session topics some local window holds, whoever's session they are about. */
  private readonly localTopics = new Set<string>();
  /** A snapshot write waiting out `SNAPSHOT_WRITE_MS`, per member. */
  private readonly pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
  private offs: (() => void)[] = [];
  private running = false;
  private hubHooked = false;
  private readonly now: () => number;

  constructor(private readonly opts: FederationOptions) {
    this.now = opts.now ?? Date.now;
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
      if (channel) this.attach(entry.id, channel);
    }
    this.rosterChanged();
  }

  stop(): void {
    // A member up until now was heard from now; one with changes waiting has them kept.
    for (const link of this.links.values()) {
      if (link.channel?.ready || this.pendingWrites.has(link.id)) this.writeSnapshot(link);
    }
    this.running = false;
    for (const off of this.offs) off();
    this.offs = [];
    for (const { off } of this.channels.values()) off();
    this.channels.clear();
    this.links.clear();
  }

  /** The member a session belongs to; null for this device's own and for one nobody knows. */
  linkOf(sessionId: string): MemberLink | null {
    for (const link of this.links.values()) if (link.sessions.has(sessionId)) return link;
    return null;
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
    const local = this.localTagIds();
    return [...this.links.values()].flatMap((l) => [...l.sessions.values()].map((s) => this.localize(l, s, local)));
  }

  async request(link: MemberLink, method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    const channel = link.channel;
    if (!channel?.ready) return { status: 409, body: { error: 'member_offline' } };
    try {
      const res = await channel.request(method, path, body);
      const payload = res.body as { session?: Session } | null;
      if (payload && typeof payload === 'object' && payload.session && typeof payload.session.id === 'string') {
        // A third device's session, as the member shows it: not ours to pass on as the member's.
        if (carriesMachine(payload.session)) {
          const { session: _chained, ...rest } = payload;
          return { status: res.status, body: rest };
        }
        return { status: res.status, body: { ...payload, session: this.localize(link, payload.session) } };
      }
      return res;
    } catch (err) {
      if (err instanceof TunnelError) return { status: 502, body: { error: 'member_unreachable' } };
      throw err;
    }
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
      } catch {
        return null;
      }
    }
    return out;
  }

  /** A stored image of some member's session, by ref: asked of every member that is up. */
  async blob(ref: string): Promise<BlobResult | null> {
    for (const link of this.links.values()) {
      const channel = link.channel;
      if (!channel?.ready) continue;
      try {
        const res = await channel.getBlob(ref);
        if (res.status === 200) return res;
      } catch {
        /* the next member */
      }
    }
    return null;
  }

  async file(link: MemberLink, sessionId: string, path: string, as: FileAs, cwd?: string): Promise<FileResult | null> {
    const channel = link.channel;
    if (!channel?.ready) return null;
    try {
      return await channel.getFile(sessionId, path, as, cwd ? { cwd } : {});
    } catch {
      return null;
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
    }
    channel.subscribe('sessions');
    // The member answers at once with where the user is, and again at every change.
    if (hello?.capabilities?.includes('presence')) channel.subscribe(PRESENCE_TOPIC);
    for (const topic of this.localTopics) {
      const session = sessionOfTopic(topic);
      if (session !== null && link.sessions.has(session)) channel.subscribe(topic);
    }
    if (channel.ready && !link.seeded) {
      link.seeded = true;
      void this.seed(link, channel);
    }
  }

  /** The member's channel went down: its sessions stay, shown offline as of now, and kept so. */
  private offline(id: string, channel: Channel): void {
    const link = this.links.get(id);
    if (!link || link.channel !== channel) return;
    link.present = false;
    if (!link.seeded) return;
    link.seeded = false;
    link.seenAt = this.now();
    this.republish(link);
    this.writeSnapshot(link);
  }

  /** Whether `link` still rides `channel`, up: an answer that arrives after is dropped. */
  private current(link: MemberLink, channel: Channel): boolean {
    return this.running && this.links.get(link.id) === link && link.channel === channel && channel.ready;
  }

  /** The member's sessions and tags, read afresh whenever its channel comes up. */
  private async seed(link: MemberLink, channel: Channel): Promise<void> {
    const tags = await this.request(link, 'GET', '/api/tags');
    if (!this.current(link, channel)) return;
    const tagList = (tags.body as { tags?: Tag[] } | null)?.tags;
    if (tags.status === 200 && Array.isArray(tagList)) link.tags = new Map(tagList.map((t) => [t.id, t]));
    for (const limit of SEED_LIMITS) {
      const res = await this.request(link, 'GET', `/api/sessions?limit=${limit}`);
      if (!this.current(link, channel)) return;
      if (res.status === 413) continue;
      const list = (res.body as { sessions?: Session[] } | null)?.sessions;
      if (res.status !== 200 || !Array.isArray(list)) return;
      const fresh = new Map(list
        .filter((s) => s && typeof s.id === 'string' && !carriesMachine(s))
        .map((s) => [s.id, s]));
      for (const id of link.sessions.keys()) {
        if (!fresh.has(id)) this.opts.hub.publish('sessions', { event: 'remove', sessionId: id });
      }
      const before = new Set(link.sessions.keys());
      link.sessions.clear();
      for (const [id, s] of fresh) {
        link.sessions.set(id, s);
        if (!before.has(id)) this.followSession(link, id);
      }
      link.seenAt = null;
      this.republish(link);
      this.scheduleSnapshot(link);
      return;
    }
  }

  /** A window that subscribed before this member's list carried the id (a spawn from here). */
  private followSession(link: MemberLink, sessionId: string): void {
    for (const topic of this.localTopics) {
      if (sessionOfTopic(topic) === sessionId) link.channel?.subscribe(topic);
    }
  }

  private republish(link: MemberLink): void {
    const local = this.localTagIds();
    for (const s of link.sessions.values()) {
      this.opts.hub.publish('sessions', { event: 'upsert', session: this.localize(link, s, local) });
    }
  }

  /**
   * A member no longer in the group: its sessions leave the map. The removes
   * go out while the sessions are still known as foreign, so no channel
   * passes them on.
   */
  private drop(link: MemberLink): void {
    for (const id of link.sessions.keys()) this.opts.hub.publish('sessions', { event: 'remove', sessionId: id });
    this.links.delete(link.id);
    clearTimeout(this.pendingWrites.get(link.id));
    this.pendingWrites.delete(link.id);
    this.removeSnapshot(link.id);
    const channel = link.channel;
    if (!channel) return;
    channel.unsubscribe('sessions');
    channel.unsubscribe(PRESENCE_TOPIC);
    for (const topic of this.localTopics) {
      const session = sessionOfTopic(topic);
      if (session !== null && link.sessions.has(session)) channel.unsubscribe(topic);
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
      if (session === null || !link.sessions.has(session)) return;
      if (this.opts.hub.subscriberCount(topic) > 0) this.opts.hub.publish(topic, rest);
      return;
    }
    if (frame.event === 'upsert') {
      const session = frame.session as Session | undefined;
      // Another device's session, passed on by this member: not ours to show (no chaining).
      if (!session || typeof session !== 'object' || typeof session.id !== 'string' || carriesMachine(session)) return;
      const known = link.sessions.has(session.id);
      link.sessions.set(session.id, session);
      if (!known) this.followSession(link, session.id);
      this.opts.hub.publish('sessions', { event: 'upsert', session: this.localize(link, session) });
      this.scheduleSnapshot(link);
    } else if (frame.event === 'remove') {
      const id = frame.sessionId;
      // Published while still known as foreign, so no channel passes it on.
      if (typeof id !== 'string' || !link.sessions.has(id)) return;
      this.opts.hub.publish('sessions', { event: 'remove', sessionId: id });
      link.sessions.delete(id);
      this.scheduleSnapshot(link);
    } else if (frame.event === 'status') {
      const id = frame.sessionId;
      const session = typeof id === 'string' ? link.sessions.get(id) : undefined;
      if (!session) return;
      if (typeof frame.status === 'string') session.status = frame.status;
      this.opts.hub.publish('sessions', rest);
      this.scheduleSnapshot(link);
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
    for (const link of [...this.links.values()]) {
      const entry = live.get(link.id);
      if (!entry || entry.kind === 'phone') {
        this.drop(link);
        continue;
      }
      const before = link.entry;
      link.entry = entry;
      if (before.name !== entry.name || before.kind !== entry.kind || before.os !== entry.os) this.republish(link);
    }
    for (const entry of live.values()) {
      if (this.links.has(entry.id)) continue;
      const channel = this.channels.get(entry.id)?.channel;
      if (channel?.ready) this.engage(entry.id, channel, entry);
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
        sessions: new Map(snap.sessions.filter((s) => !carriesMachine(s)).map((s) => [s.id, s])),
        tags: new Map(snap.tags.map((t) => [t.id, t])),
        channel: null, seenAt: snap.seenAt, entry, seeded: false, present: false,
      };
      this.links.set(link.id, link);
      this.republish(link);
    }
  }

  /** Gathers a member's changes into one write, `SNAPSHOT_WRITE_MS` after the first. */
  private scheduleSnapshot(link: MemberLink): void {
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
    const seenAt = link.channel?.ready ? this.now() : (link.seenAt ?? this.now());
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

  private localTagIds(): Map<string, number> {
    return new Map(this.opts.localTags().map((t) => [t.name, t.id]));
  }

  private machine(link: MemberLink): MachineRef {
    const online = link.channel?.ready === true;
    return {
      id: link.id, name: link.entry.name, kind: link.entry.kind, os: link.entry.os, online,
      asOf: online ? null : link.seenAt,
    };
  }

  /** A member's session as this device shows it: its machine named, its tags this device's of the same name. */
  private localize(link: MemberLink, session: Session, local = this.localTagIds()): Session {
    const tagIds = (session.tagIds ?? [])
      .map((id) => local.get(link.tags.get(id)?.name ?? ''))
      .filter((id): id is number => id !== undefined);
    return { ...session, tagIds, machine: this.machine(link) };
  }
}
