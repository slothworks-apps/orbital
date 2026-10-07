/**
 * One connected phone, from its handshake to its close. Everything it sends
 * is decrypted here and handed to the parts of the server that already
 * exist: hub control frames to `Hub` through a virtual socket, REST calls to
 * Fastify's `inject()` behind the allowlist, images to the image store
 * (spec 2026-09-30-mobile-remote-design § 3 Dispatcher).
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Identity } from '@orbital/shared/remote/keys';
import { FRAME_HEADER_BYTES, MAX_FRAME_BYTES } from '@orbital/shared/remote/frame';
import {
  GCM_TAG_BYTES, HANDSHAKE_BYTES, NONCE_BYTES, startHandshake, type Handshake, type SessionCipher,
} from '@orbital/shared/remote/handshake';
import {
  MacMessage, PROTOCOL_VERSION, PhoneMessage, chunkBlob, decodeInner, encodeInner,
  type NotificationSettings,
} from '@orbital/shared/remote/messages';
import {
  MIN_PHONE_VERSION, PHONE_KNOWS_APP_TOO_OLD, compareVersions, phoneAppVersion,
} from '@orbital/shared/remote/version';
import type { Hub } from '../api/hub.js';
import { ATTACHMENT_MAX_BYTES } from '../api/routes.js';
import type { ImageStore } from '../images/store.js';
import { allowedPath } from './allowlist.js';
import type { PhoneFileReader } from './phoneFiles.js';

export const BLOB_PUT_MAX_BYTES = ATTACHMENT_MAX_BYTES;
/** Uploads a phone may hold open at once; each buffers in memory until its last chunk. */
export const MAX_OPEN_UPLOADS = 4;
/**
 * Hub topics a phone may subscribe to: the ones the web client uses, and
 * nothing else — the same stance `allowedPath` takes on routes, so a topic
 * added later stays Mac-only until it is listed here. `remote` (pairing
 * codes and fingerprints) is deliberately absent.
 */
export const PHONE_ALLOWED_TOPICS: ReadonlySet<string> = new Set(['sessions', 'errors']);
/** Per-id topics, by prefix: `session:<id>`, `subagent:<session>:<agent>`, `task-output:<session>:<task>`. */
export const PHONE_ALLOWED_TOPIC_PREFIXES: readonly string[] = ['session:', 'subagent:', 'task-output:'];

export function phoneMayWatch(topic: string): boolean {
  return PHONE_ALLOWED_TOPICS.has(topic) || PHONE_ALLOWED_TOPIC_PREFIXES.some((p) => topic.startsWith(p) && topic.length > p.length);
}
/**
 * The largest encoded inner message that still fits one relay frame once
 * sealed (nonce + tag) and framed (header), with a byte to spare. An
 * `http_res` above it would make `encodeFrame` throw; the phone gets a 413
 * instead of silence.
 */
export const MAX_INNER_BYTES = MAX_FRAME_BYTES - FRAME_HEADER_BYTES - NONCE_BYTES - GCM_TAG_BYTES - 1;

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

/** A phone app below the Mac's minimum: the version its `hello` named, and the minimum. */
export type PhoneTooOld = { version: string; needed: string };

type ByeReason = Extract<MacMessage, { t: 'bye' }>['reason'];

export type InjectFn = (req: { method: string; url: string; payload?: unknown }) => Promise<{ statusCode: number; body: string }>;

export type PhoneSessionOptions = {
  deviceId: string;
  identity: Identity;
  phonePublicKey: Uint8Array;
  hub: Hub;
  inject: InjectFn;
  images: ImageStore;
  imagesDir: string;
  /** Reads what a `file_get` asks for, confined to what that session may show (`createPhoneFileReader`). */
  files: PhoneFileReader;
  serverVersion: string;
  macName: string;
  notifications: { get(): NotificationSettings; set(s: NotificationSettings): void };
  /** Sends one body — handshake or ciphertext — to the phone. */
  send: (body: Uint8Array) => void;
  onSeen: (sessionId: string) => void;
  onClose: () => void;
  /** Every `hello`'s verdict on the app's version: the refusal, or null for an app new enough. */
  onAppVersion?: (refusal: PhoneTooOld | null) => void;
  /** `MIN_PHONE_VERSION` unless a test moves it. */
  minPhoneVersion?: string;
};

type VirtualSocket = EventEmitter & { send(data: string): void };

type Upload = { mediaType: string; expected: number; parts: Uint8Array[]; received: number; nextSeq: number };

export class PhoneSession {
  private handshake: Handshake | null;
  private cipher: SessionCipher | null = null;
  private greeted = false;
  private closed = false;
  /** The hub's view of this phone; replaced on a re-handshake (`rehandshake`). */
  private socket: VirtualSocket;
  private readonly uploads = new Map<number, Upload>();

  constructor(readonly opts: PhoneSessionOptions) {
    this.handshake = startHandshake(opts.identity, opts.phonePublicKey, 'responder');
    this.socket = this.makeSocket();
  }

  private makeSocket(): VirtualSocket {
    const socket: VirtualSocket = Object.assign(new EventEmitter(), {
      send: (data: string) => {
        if (!this.greeted || this.socket !== socket) return;
        // Every hub frame goes through, heartbeats included and on purpose:
        // they are what the phone's watchdog uses to tell a live tunnel from
        // a dead one.
        let frame: unknown;
        try {
          frame = JSON.parse(data);
        } catch {
          return; // not JSON: nothing the phone could read
        }
        this.sendJson({ t: 'ws', frame });
      },
    });
    return socket;
  }

  get ready(): boolean {
    return this.greeted && !this.closed;
  }

  receive(body: Uint8Array): void {
    if (this.closed) return;
    if (!this.cipher) {
      // The responder's half is signed over both ephemerals, so it exists only
      // once the phone's half verified (`Handshake.message` is set by
      // `complete` for a responder); `complete` is single-use.
      const handshake = this.handshake;
      const cipher = handshake?.complete(body) ?? null;
      // `complete` is single-use, so a bad first frame (garbage, stale or
      // replayed) leaves nothing to retry: close so the caller drops us.
      if (!cipher || !handshake?.message) return this.close();
      this.cipher = cipher;
      this.handshake = null;
      this.opts.send(handshake.message);
      return;
    }
    const plain = this.cipher.open(body);
    if (!plain) {
      if (body.length === HANDSHAKE_BYTES) this.rehandshake(body);
      return;
    }
    const inner = decodeInner(plain);
    if (!inner) return;
    // `receive` runs inside the relay client's frame loop; a throwing hook
    // (`putBytes`, `notifications.set`, `onSeen`) must not unwind into it.
    if (inner.kind === 'blob') {
      try {
        this.onChunk(inner);
      } catch (err) {
        this.uploads.delete(inner.id);
        this.fail('blob chunk', err);
        this.sendJson({ t: 'blob_put_done', id: inner.id, error: 'internal' });
      }
      return;
    }
    const parsed = PhoneMessage.safeParse(inner.value);
    if (!parsed.success) return;
    const msg = parsed.data;
    try {
      this.onMessage(msg);
    } catch (err) {
      this.fail(msg.t, err);
      if (msg.t === 'http') this.sendJson({ t: 'http_res', id: msg.id, status: 500, body: { error: 'internal' } });
      else if (msg.t === 'blob_get' || msg.t === 'file_get') this.sendJson({ t: 'blob_meta', id: msg.id, status: 500 });
      else if (msg.t === 'blob_put') this.sendJson({ t: 'blob_put_done', id: msg.id, error: 'internal' });
    }
  }

  /**
   * A body the current keys cannot open, but sized like a handshake: the
   * phone may have reconnected on a new socket and started over while this
   * session survived — the relay replaces a device's socket without telling
   * the Mac `offline`, and the service's presence reset can race or be
   * missed. A fresh responder handshake decides: it completes only if the
   * signature verifies against this phone's identity, so nobody else can
   * reset the session. The relay could replay an old handshake of the
   * phone's, but the keys that yields are useless to it (it never had the
   * ephemeral secret) and dropping frames would hurt the tunnel as much.
   */
  private rehandshake(body: Uint8Array): void {
    const handshake = startHandshake(this.opts.identity, this.opts.phonePublicKey, 'responder');
    const cipher = handshake.complete(body);
    if (!cipher || !handshake.message) return;
    // Everything tied to the old connection goes: hub subscriptions (the
    // phone subscribes again after its `hello`), half-sent uploads.
    this.socket.emit('close');
    this.socket = this.makeSocket();
    this.uploads.clear();
    this.greeted = false;
    this.cipher = cipher;
    this.opts.send(handshake.message);
  }

  private fail(what: string, err: unknown): void {
    console.warn(`[remote] phone ${this.opts.deviceId}: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** `needed` goes with `app_too_old`: the minimum the phone has to reach. */
  close(reason?: ByeReason, needed?: string): void {
    if (this.closed) return;
    if (reason && this.cipher) this.sendJson({ t: 'bye', reason, ...(needed !== undefined ? { needed } : {}) });
    this.closed = true;
    this.socket.emit('close');
    this.opts.onClose();
  }

  private onMessage(msg: PhoneMessage): void {
    if (!this.greeted) {
      if (msg.t !== 'hello') return;
      if (msg.protocol !== PROTOCOL_VERSION) return this.close('protocol');
      const refusal = this.appTooOld(msg.app);
      this.opts.onAppVersion?.(refusal);
      if (refusal) {
        // A phone from before `app_too_old` would drop the bye as unreadable;
        // `protocol` is the closest refusal it understands.
        return compareVersions(refusal.version, PHONE_KNOWS_APP_TOO_OLD) < 0
          ? this.close('protocol')
          : this.close('app_too_old', refusal.needed);
      }
      this.greeted = true;
      this.opts.hub.handleSocket(this.socket);
      this.sendJson({ t: 'hello', protocol: PROTOCOL_VERSION, server: this.opts.serverVersion, macName: this.opts.macName });
      return;
    }
    switch (msg.t) {
      case 'hello':
        return;
      case 'ws':
        if (!phoneMayWatch(msg.topic)) return;
        this.socket.emit('message', JSON.stringify({ type: msg.type, topic: msg.topic }));
        return;
      case 'http':
        void this.onHttp(msg);
        return;
      case 'blob_get':
        this.onBlobGet(msg.id, msg.ref);
        return;
      case 'file_get':
        this.onFileGet(msg);
        return;
      case 'blob_put':
        if (msg.bytes > BLOB_PUT_MAX_BYTES) return this.sendJson({ t: 'blob_put_done', id: msg.id, error: 'too_large' });
        if (this.uploads.size >= MAX_OPEN_UPLOADS) return this.sendJson({ t: 'blob_put_done', id: msg.id, error: 'busy' });
        this.uploads.set(msg.id, { mediaType: msg.mediaType, expected: msg.bytes, parts: [], received: 0, nextSeq: 0 });
        return;
      case 'notifications_get':
        this.sendJson({ t: 'notifications', settings: this.opts.notifications.get() });
        return;
      case 'notifications_set':
        this.opts.notifications.set(msg.settings);
        this.sendJson({ t: 'notifications', settings: this.opts.notifications.get() });
        return;
      case 'seen':
        this.opts.onSeen(msg.sessionId);
        return;
    }
  }

  /** Null for an app at or above the minimum, and for a `hello.app` that names no version to judge. */
  private appTooOld(app: string): PhoneTooOld | null {
    const version = phoneAppVersion(app);
    const needed = this.opts.minPhoneVersion ?? MIN_PHONE_VERSION;
    return version !== null && compareVersions(version, needed) < 0 ? { version, needed } : null;
  }

  private async onHttp(msg: Extract<PhoneMessage, { t: 'http' }>): Promise<void> {
    // `allowedPath` returns the canonical string Fastify will route, or null;
    // the raw `msg.path` is never handed to `inject()` (Task 12 review: the
    // WHATWG parser would otherwise rewrite `\` and `#` into a denied route).
    const path = allowedPath(msg.method, msg.path);
    if (path === null) {
      return this.sendJson({ t: 'http_res', id: msg.id, status: 403, body: { error: 'not_allowed' } });
    }
    try {
      const res = await this.opts.inject({ method: msg.method, url: path, payload: msg.body });
      let body: unknown = res.body;
      try {
        body = JSON.parse(res.body);
      } catch {
        /* a non-JSON answer travels as text */
      }
      this.sendJson({ t: 'http_res', id: msg.id, status: res.statusCode, body });
    } catch (err) {
      this.sendJson({ t: 'http_res', id: msg.id, status: 500, body: { error: err instanceof Error ? err.message : String(err) } });
    }
  }

  private onBlobGet(id: number, ref: string): void {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(this.opts.imagesDir, ref));
    } catch {
      return this.sendJson({ t: 'blob_meta', id, status: 404 });
    }
    const ext = ref.slice(ref.lastIndexOf('.') + 1);
    this.sendJson({ t: 'blob_meta', id, status: 200, bytes: bytes.length, mediaType: IMAGE_CONTENT_TYPES[ext] });
    for (const chunk of chunkBlob(id, new Uint8Array(bytes))) this.sendInner(encodeInner(chunk));
  }

  /**
   * A file by path (spec 2026-10-05-mobile-next-design § 2). `files` owns
   * the whole confinement; this only frames its answer the way `onBlobGet`
   * frames a stored image, so the phone reassembles both alike.
   */
  private onFileGet(msg: Extract<PhoneMessage, { t: 'file_get' }>): void {
    const answer = this.opts.files(msg.session, msg.path, msg.as);
    const meta = {
      ...(answer.mediaType !== undefined ? { mediaType: answer.mediaType } : {}),
      ...(answer.size !== undefined ? { size: answer.size } : {}),
      ...(answer.w !== undefined && answer.h !== undefined ? { w: answer.w, h: answer.h } : {}),
    };
    if (answer.status !== 200 || !answer.bytes) {
      return this.sendJson({ t: 'blob_meta', id: msg.id, status: answer.status === 200 ? 404 : answer.status, ...meta });
    }
    this.sendJson({ t: 'blob_meta', id: msg.id, status: 200, bytes: answer.bytes.length, ...meta });
    for (const chunk of chunkBlob(msg.id, answer.bytes)) this.sendInner(encodeInner(chunk));
  }

  private onChunk(chunk: { id: number; seq: number; last: boolean; bytes: Uint8Array }): void {
    const up = this.uploads.get(chunk.id);
    if (!up) return;
    if (chunk.seq !== up.nextSeq) {
      this.uploads.delete(chunk.id);
      return this.sendJson({ t: 'blob_put_done', id: chunk.id, error: 'out_of_order' });
    }
    up.nextSeq++;
    up.parts.push(chunk.bytes);
    up.received += chunk.bytes.length;
    // `expected` was already capped at BLOB_PUT_MAX_BYTES by `blob_put`.
    if (up.received > up.expected) {
      this.uploads.delete(chunk.id);
      return this.sendJson({ t: 'blob_put_done', id: chunk.id, error: 'too_large' });
    }
    if (!chunk.last) return;
    this.uploads.delete(chunk.id);
    if (up.received !== up.expected) return this.sendJson({ t: 'blob_put_done', id: chunk.id, error: 'size_mismatch' });
    const entry = this.opts.images.putBytes(up.mediaType, Buffer.concat(up.parts.map((p) => Buffer.from(p))));
    if (!entry) return this.sendJson({ t: 'blob_put_done', id: chunk.id, error: 'not_image' });
    this.sendJson({ t: 'blob_put_done', id: chunk.id, entry });
  }

  private sendJson(msg: MacMessage): void {
    const plain = encodeInner({ kind: 'json', value: msg });
    // Only a REST answer (a transcript page, a file preview) and a hub frame
    // can be arbitrarily large; everything else the Mac sends is bounded by
    // construction.
    if (msg.t === 'http_res' && plain.length > MAX_INNER_BYTES) {
      return this.sendInner(encodeInner({ kind: 'json', value: { t: 'http_res', id: msg.id, status: 413, body: { error: 'too_large' } } }));
    }
    // A hub frame can be as large as the message it carries (one huge tool
    // result). Dropping it silently would leave a hole in the phone's
    // transcript it could never notice; this tells it what to refetch.
    if (msg.t === 'ws' && plain.length > MAX_INNER_BYTES) {
      const frame = msg.frame as { topic?: unknown; message?: { id?: unknown } } | null;
      const id = frame?.message?.id;
      return this.sendInner(encodeInner({
        kind: 'json',
        value: { t: 'ws', frame: { topic: frame?.topic, event: 'dropped', reason: 'too_large', ...(id !== undefined ? { id } : {}) } },
      }));
    }
    this.sendInner(plain);
  }

  private sendInner(plain: Uint8Array): void {
    if (!this.cipher || this.closed) return;
    // `send` frames the body (`encodeFrame` throws past MAX_FRAME_BYTES), and
    // its callers run inside the relay client's frame loop: drop, don't throw.
    try {
      this.opts.send(this.cipher.seal(plain));
    } catch (err) {
      this.fail('send', err);
    }
  }
}
