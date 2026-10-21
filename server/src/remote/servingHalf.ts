/**
 * What a paired device's asks reach on this server, once its channel is up.
 * Everything it asks is handed to the parts of the server that already
 * exist: hub control frames to `Hub` through a virtual socket, REST calls to
 * Fastify's `inject()` behind the allowlist, images to the image store
 * (spec 2026-09-30-mobile-remote-design § 3 Dispatcher). The handshake, the
 * hello and the cipher are the `Channel`'s.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BlobChunk, ChannelReply, ChannelServer } from '@orbital/shared/remote/channel';
import {
  chunkBlob, type AnswerMessage, type AskMessage, type NotificationSettings,
} from '@orbital/shared/remote/messages';
import { LIMITS_TOPIC, isOwnLimitsEntry } from '@orbital/shared/limits';
import { PRESENCE_TOPIC } from '@orbital/shared/presence';
import { PROFILE_LOGINS_TOPIC } from '@orbital/shared/profileLogins';
import { sessionOfTopic } from '@orbital/shared/remote/segments';
import type { Hub } from '../api/hub.js';
import { ATTACHMENT_MAX_BYTES, IMAGE_CONTENT_TYPES } from '../api/routes.js';
import type { ImageStore } from '../images/store.js';
import { thumbnailOf } from '../images/thumbs.js';
import { allowedPath } from './allowlist.js';
import { memberHasGrant, parseGrants, type GrantGroup } from './grants.js';
import type { PhoneFileReader } from './phoneFiles.js';

export const BLOB_PUT_MAX_BYTES = ATTACHMENT_MAX_BYTES;
/** Uploads a phone may hold open at once; each buffers in memory until its last chunk. */
export const MAX_OPEN_UPLOADS = 4;
/**
 * Hub topics another member may subscribe to: the ones the web client uses,
 * and nothing else — the same stance `allowedPath` takes on routes, so a
 * topic added later stays this device's own until it is listed here.
 * `remote` (pairing codes and fingerprints) is deliberately absent.
 * `presence` is the phone's: the web client has no use for it. `limits`
 * carries only this device's own directories to a peer (`ownLimitsFrame`).
 * `claude-dir-logins` is every change of a profile's login (spec
 * 2026-10-21-log-in-from-orbital-design § 2).
 */
export const MEMBER_ALLOWED_TOPICS: ReadonlySet<string> = new Set([
  'sessions', 'errors', PRESENCE_TOPIC, LIMITS_TOPIC, PROFILE_LOGINS_TOPIC,
]);
/** Per-id topics, by prefix: `session:<id>`, `subagent:<session>:<agent>`, `task-output:<session>:<task>`. */
export const MEMBER_ALLOWED_TOPIC_PREFIXES: readonly string[] = ['session:', 'subagent:', 'task-output:'];

/** The grant group the `limits` topic follows: the one `GET /api/limits` is in (`allowlist.ts`). */
export const LIMITS_GRANT: GrantGroup = 'settings';

/** The grant group the `claude-dir-logins` topic follows: the one its routes are in (`allowlist.ts`). */
export const LOGINS_GRANT: GrantGroup = 'manage';

/**
 * Topics that follow the grant group of the route answering the same
 * thing: a member without the grant gets no frame of them.
 */
const TOPIC_GRANTS: ReadonlyMap<string, GrantGroup> = new Map([
  [LIMITS_TOPIC, LIMITS_GRANT],
  [PROFILE_LOGINS_TOPIC, LOGINS_GRANT],
]);

export function memberMayWatch(topic: string): boolean {
  return MEMBER_ALLOWED_TOPICS.has(topic) || MEMBER_ALLOWED_TOPIC_PREFIXES.some((p) => topic.startsWith(p) && topic.length > p.length);
}

/**
 * A `limits` frame as a peer gets it: this device's own directories only,
 * never another member's merged in (no chaining). Any other frame as it is.
 */
export function ownLimitsFrame(frame: unknown): unknown {
  const f = frame as { topic?: unknown; limits?: { dirs?: unknown } | null } | null;
  if (!f || f.topic !== LIMITS_TOPIC || !f.limits || typeof f.limits !== 'object' || !Array.isArray(f.limits.dirs)) return frame;
  const dirs = f.limits.dirs.filter((d) => !(d && typeof d === 'object') || isOwnLimitsEntry(d as { machine?: unknown }));
  return { ...f, limits: { ...f.limits, dirs } };
}

/** A session another device passed on as some third device's: it carries the `machine` it runs on. */
export function carriesMachine(session: { machine?: unknown }): boolean {
  return session.machine !== undefined && session.machine !== null;
}

/** `device`, when given, is the id of the member that asked: it rides as `DEVICE_HEADER`. */
export type InjectFn = (req: { method: string; url: string; payload?: unknown; device?: string }) => Promise<{ statusCode: number; body: string }>;

export type ServingHalfOptions = {
  deviceId: string;
  hub: Hub;
  inject: InjectFn;
  images: ImageStore;
  imagesDir: string;
  /** Reads what a `file_get` asks for, confined to what that session may show (`createPhoneFileReader`). */
  files: PhoneFileReader;
  notifications: { get(): NotificationSettings; set(s: NotificationSettings): void };
  onSeen(sessionId: string): void;
  /** Whether the user is at the Mac, sent when the phone subscribes to `presence`; absent, never. */
  atMac?: () => boolean;
  /**
   * Whether a session is another member's, federated into this hub: never
   * passed on to the peer (no chaining, spec 2026-10-16-device-group-design § 7).
   */
  foreign?: (sessionId: string) => boolean;
  /**
   * Whether the device's pair is ending (`GroupMember.exiting`): it is no
   * member any more, or this device left, and nothing is served to it — no
   * request, no topic, no frame. Absent, never.
   */
  withdrawn?: () => boolean;
  /**
   * Get the current remote_grants setting for checking member permissions.
   */
  getGrants?: () => string | undefined;
};

type VirtualSocket = EventEmitter & { send(data: string): void; peer: string };

type Upload = { mediaType: string; expected: number; parts: Uint8Array[]; received: number; nextSeq: number };

export class ServingHalf implements ChannelServer {
  private reply: ChannelReply | null = null;
  /** The hub's view of this device; a new one for every accepted hello, gone on `reset`. */
  private socket: VirtualSocket | null = null;
  private readonly uploads = new Map<number, Upload>();

  constructor(private readonly opts: ServingHalfOptions) {}

  open(reply: ChannelReply): void {
    this.reset();
    this.reply = reply;
    const socket = this.makeSocket();
    this.socket = socket;
    this.opts.hub.handleSocket(socket);
  }

  /**
   * Everything tied to the old connection goes: hub subscriptions (the
   * device subscribes again after its `hello`), half-sent uploads. Safe
   * before any `open`: the channel resets its serving half on its own start.
   */
  reset(): void {
    this.socket?.emit('close');
    this.socket = null;
    this.reply = null;
    this.uploads.clear();
  }

  /** `ask` runs inside the relay client's frame loop: a throwing hook answers 500, never unwinds into it. */
  ask(msg: AskMessage): void {
    if (this.opts.withdrawn?.()) {
      this.refuse(msg);
      return;
    }
    try {
      this.onAsk(msg);
    } catch (err) {
      this.fail(msg.t, err);
      if (msg.t === 'http') this.answer({ t: 'http_res', id: msg.id, status: 500, body: { error: 'internal' } });
      else if (msg.t === 'blob_get' || msg.t === 'file_get') this.answer({ t: 'blob_meta', id: msg.id, status: 500 });
      else if (msg.t === 'blob_put') this.answer({ t: 'blob_put_done', id: msg.id, error: 'internal' });
    }
  }

  chunk(chunk: BlobChunk): void {
    if (this.opts.withdrawn?.()) return;
    try {
      this.onChunk(chunk);
    } catch (err) {
      this.uploads.delete(chunk.id);
      this.fail('blob chunk', err);
      this.answer({ t: 'blob_put_done', id: chunk.id, error: 'internal' });
    }
  }

  /** What a device whose pair is ending is told: nothing it asked for. */
  private refuse(msg: AskMessage): void {
    if (msg.t === 'http') this.answer({ t: 'http_res', id: msg.id, status: 403, body: { error: 'not_in_group' } });
    else if (msg.t === 'blob_get' || msg.t === 'file_get') this.answer({ t: 'blob_meta', id: msg.id, status: 403 });
    else if (msg.t === 'blob_put') this.answer({ t: 'blob_put_done', id: msg.id, error: 'not_in_group' });
  }

  private answer(msg: AnswerMessage): void {
    this.reply?.json(msg);
  }

  private makeSocket(): VirtualSocket {
    const socket: VirtualSocket = Object.assign(new EventEmitter(), {
      peer: this.opts.deviceId,
      send: (data: string) => {
        if (this.socket !== socket || this.opts.withdrawn?.()) return;
        // Every hub frame goes through, heartbeats included and on purpose:
        // they are what the asker's watchdog tells a live channel by.
        let frame: unknown;
        try {
          frame = JSON.parse(data);
        } catch {
          return; // not JSON: nothing the asker could read
        }
        if (this.withheld(frame) || this.grantWithheld(frame)) return;
        this.answer({ t: 'ws', frame: ownLimitsFrame(frame) });
      },
    });
    return socket;
  }

  /**
   * A frame about another member or its session, which this device only
   * shows: it stays here. A `machine` event is about another member always.
   */
  private withheld(frame: unknown): boolean {
    const f = frame as { topic?: unknown; event?: unknown; sessionId?: unknown; session?: { machine?: unknown } | null } | null;
    if (!f || typeof f.topic !== 'string') return false;
    if (f.topic === 'sessions') {
      if (f.event === 'machine') return true;
      if (f.session && typeof f.session === 'object' && carriesMachine(f.session)) return true;
      return typeof f.sessionId === 'string' && this.isForeign(f.sessionId);
    }
    const session = sessionOfTopic(f.topic);
    return session !== null && this.isForeign(session);
  }

  /**
   * `limits` is what `GET /api/limits` answers, so it follows that route's
   * grant group (`TOPIC_GRANTS`), and `claude-dir-logins` its routes': a
   * member without it gets no frame of it. Checked on every frame, not only
   * on subscribe: the grant can be taken back while the subscription stands.
   */
  private grantWithheld(frame: unknown): boolean {
    const topic = (frame as { topic?: unknown } | null)?.topic;
    return typeof topic === 'string' && !this.mayWatch(topic);
  }

  /** Whether the member holds the grant a topic follows; true for a topic that follows none. */
  private mayWatch(topic: string): boolean {
    const grant = TOPIC_GRANTS.get(topic);
    return grant === undefined || memberHasGrant(parseGrants(this.opts.getGrants?.()), this.opts.deviceId, grant);
  }

  private isForeign(sessionId: string): boolean {
    return this.opts.foreign?.(sessionId) ?? false;
  }

  private onAsk(msg: AskMessage): void {
    const socket = this.socket;
    if (!socket) return;
    switch (msg.t) {
      case 'ws': {
        if (!memberMayWatch(msg.topic)) return;
        // Another member's session is that member's to serve, over its own channel.
        const session = sessionOfTopic(msg.topic);
        if (msg.type === 'subscribe' && session !== null && this.isForeign(session)) return;
        if (msg.type === 'subscribe' && !this.mayWatch(msg.topic)) return;
        socket.emit('message', JSON.stringify({ type: msg.type, topic: msg.topic }));
        // The hub replays nothing on subscribe, so the phone would not know
        // presence until it next changed.
        if (msg.type === 'subscribe' && msg.topic === PRESENCE_TOPIC) {
          this.answer({ t: 'ws', frame: { topic: PRESENCE_TOPIC, event: 'state', atMac: this.opts.atMac?.() ?? false } });
        }
        return;
      }
      case 'http':
        void this.onHttp(msg);
        return;
      case 'blob_get':
        if (msg.edge !== undefined) void this.onThumbGet(msg.id, msg.ref, msg.edge);
        else this.onBlobGet(msg.id, msg.ref);
        return;
      case 'file_get':
        this.onFileGet(msg);
        return;
      case 'blob_put':
        if (msg.bytes > BLOB_PUT_MAX_BYTES) return this.answer({ t: 'blob_put_done', id: msg.id, error: 'too_large' });
        if (this.uploads.size >= MAX_OPEN_UPLOADS) return this.answer({ t: 'blob_put_done', id: msg.id, error: 'busy' });
        this.uploads.set(msg.id, { mediaType: msg.mediaType, expected: msg.bytes, parts: [], received: 0, nextSeq: 0 });
        return;
      case 'notifications_get':
        this.answer({ t: 'notifications', settings: this.opts.notifications.get() });
        return;
      case 'notifications_set':
        this.opts.notifications.set(msg.settings);
        this.answer({ t: 'notifications', settings: this.opts.notifications.get() });
        return;
      case 'seen':
        this.opts.onSeen(msg.sessionId);
        return;
    }
  }

  private fail(what: string, err: unknown): void {
    console.warn(`[remote] phone ${this.opts.deviceId}: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  private async onHttp(msg: Extract<AskMessage, { t: 'http' }>): Promise<void> {
    // `allowedPath` returns the canonical string Fastify will route, or null;
    // the raw `msg.path` is never handed to `inject()` (Task 12 review: the
    // WHATWG parser would otherwise rewrite `\` and `#` into a denied route).
    const allowed = allowedPath(msg.method, msg.path);
    if (allowed === null) {
      return this.answer({ t: 'http_res', id: msg.id, status: 403, body: { error: 'not_allowed' } });
    }

    // Check if the member has the grant for this route (spec 2026-10-19-member-grants-design § 1).
    const grants = parseGrants(this.opts.getGrants?.());
    if (!memberHasGrant(grants, this.opts.deviceId, allowed.group)) {
      return this.answer({ t: 'http_res', id: msg.id, status: 403, body: { error: 'not_granted', grant: allowed.group } });
    }

    try {
      const res = await this.opts.inject({ method: msg.method, url: allowed.path, payload: msg.body, device: this.opts.deviceId });
      let body: unknown = res.body;
      try {
        body = JSON.parse(res.body);
      } catch {
        /* a non-JSON answer travels as text */
      }
      this.answer({ t: 'http_res', id: msg.id, status: res.statusCode, body });
    } catch (err) {
      this.answer({ t: 'http_res', id: msg.id, status: 500, body: { error: err instanceof Error ? err.message : String(err) } });
    }
  }

  /** A thumbnail when one is made, else the image itself (`thumbnailOf`). */
  private async onThumbGet(id: number, ref: string, edge: number): Promise<void> {
    const thumb = await thumbnailOf(this.opts.imagesDir, ref, edge).catch(() => null);
    if (!thumb) return this.onBlobGet(id, ref);
    this.answer({ t: 'blob_meta', id, status: 200, bytes: thumb.bytes.length, mediaType: thumb.mediaType });
    for (const chunk of chunkBlob(id, thumb.bytes)) if (chunk.kind === 'blob') this.reply?.inner(chunk);
  }

  private onBlobGet(id: number, ref: string): void {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(this.opts.imagesDir, ref));
    } catch {
      return this.answer({ t: 'blob_meta', id, status: 404 });
    }
    const ext = ref.slice(ref.lastIndexOf('.') + 1);
    this.answer({ t: 'blob_meta', id, status: 200, bytes: bytes.length, mediaType: IMAGE_CONTENT_TYPES[ext] });
    for (const chunk of chunkBlob(id, new Uint8Array(bytes))) if (chunk.kind === 'blob') this.reply?.inner(chunk);
  }

  /**
   * A file by path (spec 2026-10-05-mobile-next-design § 2). `files` owns
   * the whole confinement; this only frames its answer the way `onBlobGet`
   * frames a stored image, so the phone reassembles both alike.
   */
  private onFileGet(msg: Extract<AskMessage, { t: 'file_get' }>): void {
    const answer = this.opts.files(msg.session, msg.path, msg.as, msg.cwd);
    const meta = {
      ...(answer.mediaType !== undefined ? { mediaType: answer.mediaType } : {}),
      ...(answer.size !== undefined ? { size: answer.size } : {}),
      ...(answer.w !== undefined && answer.h !== undefined ? { w: answer.w, h: answer.h } : {}),
    };
    if (answer.status !== 200 || !answer.bytes) {
      return this.answer({ t: 'blob_meta', id: msg.id, status: answer.status === 200 ? 404 : answer.status, ...meta });
    }
    this.answer({ t: 'blob_meta', id: msg.id, status: 200, bytes: answer.bytes.length, ...meta });
    for (const chunk of chunkBlob(msg.id, answer.bytes)) if (chunk.kind === 'blob') this.reply?.inner(chunk);
  }

  private onChunk(chunk: BlobChunk): void {
    const up = this.uploads.get(chunk.id);
    if (!up) return;
    if (chunk.seq !== up.nextSeq) {
      this.uploads.delete(chunk.id);
      return this.answer({ t: 'blob_put_done', id: chunk.id, error: 'out_of_order' });
    }
    up.nextSeq++;
    up.parts.push(chunk.bytes);
    up.received += chunk.bytes.length;
    // `expected` was already capped at BLOB_PUT_MAX_BYTES by `blob_put`.
    if (up.received > up.expected) {
      this.uploads.delete(chunk.id);
      return this.answer({ t: 'blob_put_done', id: chunk.id, error: 'too_large' });
    }
    if (!chunk.last) return;
    this.uploads.delete(chunk.id);
    if (up.received !== up.expected) return this.answer({ t: 'blob_put_done', id: chunk.id, error: 'size_mismatch' });
    const entry = this.opts.images.putBytes(up.mediaType, Buffer.concat(up.parts.map((p) => Buffer.from(p))));
    if (!entry) return this.answer({ t: 'blob_put_done', id: chunk.id, error: 'not_image' });
    this.answer({ t: 'blob_put_done', id: chunk.id, entry });
  }
}
