/**
 * One end-to-end channel between two paired devices, over whatever carries
 * its frames (spec 2026-10-16-device-group-design § 5; ADR
 * a-device-has-one-identity-and-one-channel-per-pair). Both sides ask and
 * both may serve: the asking half is the one the phone has always had, the
 * serving half is the caller's (`ChannelServer`). The handshake and the
 * cipher are `handshake.ts`'s. No DOM, no Node.
 *
 * Nothing here throws into a caller's frame loop: a bad frame is dropped and
 * counted (`dropped`), a listener that throws is its own problem.
 */
import type { Identity } from './keys.js';
import { concat } from './keys.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { FRAME_HEADER_BYTES, MAX_FRAME_BYTES } from './frame.js';
import {
  GCM_TAG_BYTES, HANDSHAKE_BYTES, NONCE_BYTES, startHandshake, type Handshake, type Role, type SessionCipher,
} from './handshake.js';
import {
  PROTOCOL_VERSION, chunkBlob, decodeInner, encodeInner, parseChannelMessage, peerServes,
  type AnswerMessage, type AskMessage, type FileAs, type GroupMessage, type HelloMessage, type ImageRefEntry,
  type Inner, type NotificationSettings,
} from './messages.js';
import { RELAY_PING_INTERVAL_MS } from './relayApi.js';
import { RESPONDER_FIRST_ID } from './device.js';

/**
 * Silence on a live tunnel before the link is dropped and rebuilt. The Mac's
 * hub heartbeat rides the tunnel (the server's `WS_HEARTBEAT_INTERVAL_MS`);
 * the relay's own pings never reach page code — a browser answers them below
 * JavaScript — so this watchdog runs only while a tunnel is up.
 */
export const TUNNEL_SILENCE_TIMEOUT_MS = RELAY_PING_INTERVAL_MS * 3;
/**
 * How long the initiator waits for the peer's handshake half, and then for
 * its hello, before a fresh handshake goes out.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** How long a `request`, a `getBlob` or `getFile` (per chunk, unless told otherwise) or a notifications call waits for its answer. */
export const REQUEST_TIMEOUT_MS = 20_000;
/**
 * A download takes in no more than its `blob_meta` announced; this is the
 * bound for one that announced no size, which a Mac never sends. Announced
 * sizes have no cap of their own: a Mac's image store keeps a transcript's
 * images at whatever size they came, so no size is too large for a real
 * one, and `DOWNLOAD_DEADLINE_MS` bounds what a peer can push past that.
 */
export const DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
/**
 * How long one `getBlob` or `getFile` may take in all, however steadily its
 * chunks arrive: a peer trickling chunks inside the idle timeout must not
 * hold a download open for good.
 */
export const DOWNLOAD_DEADLINE_MS = 5 * 60_000;
/**
 * The largest encoded inner message that still fits one relay frame once
 * sealed (nonce + tag) and framed (header), with a byte to spare. An
 * `http_res` above it would make `encodeFrame` throw; the phone gets a 413
 * instead of silence.
 */
export const MAX_INNER_BYTES = MAX_FRAME_BYTES - FRAME_HEADER_BYTES - NONCE_BYTES - GCM_TAG_BYTES - 1;

/**
 * Whether `bytes` are the image a store ref (`<sha256 hex>.<ext>`) names. A
 * full image fetched by ref from a peer is taken only when they are; a
 * thumbnail (`edge`) cannot be checked this way.
 */
export function bytesMatchRef(ref: string, bytes: Uint8Array): boolean {
  const dot = ref.indexOf('.');
  return dot > 0 && bytesToHex(sha256(bytes)) === ref.slice(0, dot).toLowerCase();
}

export type ByeReason = 'protocol' | 'revoked' | 'app_too_old';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type TunnelResponse = { status: number; body: unknown };
export type BlobResult = { status: number; bytes: Uint8Array; mediaType: string | null };
/**
 * A `getFile` answer. `status` is the Mac's: 200, or 403 outside what the
 * session may show, 404 no such session or file, 413 too large (with
 * `size`), 415 not an image or not text (with `mediaType` when the Mac
 * knows it). `w`/`h` only for an image whose header gives them.
 */
export type FileResult = BlobResult & { size: number | null; w: number | null; h: number | null };
export type GetFileOptions = {
  /** Called once per chunk that arrives, in order: bytes so far, and the total when the Mac sent it. */
  onProgress?: (received: number, total: number | null) => void;
  /** How long to wait for the answer and then for each next chunk; `REQUEST_TIMEOUT_MS` by default. */
  idleTimeoutMs?: number;
  /** `getFile` only: the `cwd` of the transcript entry the link came from (`ChatMessage.cwd`). */
  cwd?: string;
  /** `getFile` only: a thumbnail of at most this many pixels on its longest side, when the Mac makes one. */
  edge?: number;
};
/** The Mac's two refusals the composer shows are values; every other failure is a `TunnelError`. */
export type PutBlobResult =
  | { kind: 'ok'; entry: ImageRefEntry }
  | { kind: 'too_large' }
  | { kind: 'not_image' };
/**
 * `lost` also covers a blob whose chunks arrived out of order, and an upload
 * the Mac refused for any reason but the two `PutBlobResult` names: what came
 * is unusable and the rest is not coming.
 */
export type TunnelFailure = 'offline' | 'timeout' | 'lost' | 'bye';

export class TunnelError extends Error {
  readonly reason: TunnelFailure;

  constructor(reason: TunnelFailure) {
    super(`tunnel ${reason}`);
    this.name = 'TunnelError';
    this.reason = reason;
  }
}

type Timer = ReturnType<typeof setTimeout>;
type Waiter<T> = { resolve: (value: T) => void; reject: (err: Error) => void; timer: Timer };
/** One `getBlob` or `getFile` on its way in; `getBlob` leaves the file-only fields at their defaults. */
type BlobWaiter = Waiter<FileResult> & {
  mediaType: string | null;
  parts: Uint8Array[];
  nextSeq: number;
  received: number;
  total: number | null;
  size: number | null;
  w: number | null;
  h: number | null;
  idleMs: number;
  onProgress?: (received: number, total: number | null) => void;
};

export type OwnHello = Omit<HelloMessage, 't' | 'protocol'>;
export type BlobChunk = { id: number; seq: number; last: boolean; bytes: Uint8Array };

/** How a serving half answers: an answer, or one chunk of a blob it sends. */
export interface ChannelReply {
  json(msg: AnswerMessage): void;
  inner(chunk: BlobChunk): void;
}

/**
 * What a device that serves plugs in. `open` once the peer's hello is
 * accepted, `reset` whenever the keys change or the channel ends — whatever
 * was tied to the old connection (subscriptions, half-sent uploads) goes.
 */
export interface ChannelServer {
  open(reply: ChannelReply, peer: HelloMessage): void;
  ask(msg: AskMessage): void;
  chunk(chunk: BlobChunk): void;
  reset(): void;
}

export type HelloVerdict = { reason: ByeReason; needed?: string } | null;

export type ChannelEvent =
  | { type: 'hello'; hello: HelloMessage }
  /** True once the peer's hello is in; false when that tunnel is gone. */
  | { type: 'ready'; ready: boolean }
  /** A hub frame from the serving peer, verbatim. */
  | { type: 'hub'; frame: unknown }
  | { type: 'bye'; reason: ByeReason; needed?: string }
  /** A serving peer said nothing for `silenceTimeoutMs`: the caller drops the link it rides on. */
  | { type: 'silent' }
  | { type: 'closed' }
  /** A roster message from the peer; only after its hello, and only when it named `group`. */
  | { type: 'group'; msg: GroupMessage };

export type ChannelOptions = {
  identity: Identity;
  peerKey: Uint8Array;
  role: Role;
  hello: OwnHello;
  /** One frame body — a handshake half or a ciphertext — to the peer. */
  send(body: Uint8Array): void;
  /** Absent on a device that serves nothing: the peer's asks are ignored and time out there. */
  serve?: ChannelServer;
  /** The responder's check of the peer's hello; a refusal answers with `bye` and closes. */
  judge?(hello: HelloMessage): HelloVerdict;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** `DOWNLOAD_DEADLINE_MS` unless given. */
  downloadDeadlineMs?: number;
  /** A frame `send` threw on (one past `MAX_FRAME_BYTES`, a socket gone); dropped either way. */
  onSendError?(err: unknown): void;
  silenceTimeoutMs?: number;
};

export class Channel {
  /** Frames dropped as unreadable since construction. */
  dropped = 0;
  private handshake: Handshake | null = null;
  private handshakeTimer: Timer | null = null;
  private cipher: SessionCipher | null = null;
  private peerHello: HelloMessage | null = null;
  private closed = false;
  private silenceTimer: Timer | null = null;
  private nextId: number;
  private readonly topics = new Set<string>();
  private readonly requests = new Map<number, Waiter<TunnelResponse>>();
  private readonly blobs = new Map<number, BlobWaiter>();
  private readonly puts = new Map<number, Waiter<PutBlobResult>>();
  private readonly notificationWaiters: Waiter<NotificationSettings>[] = [];
  private readonly listeners = new Set<(event: ChannelEvent) => void>();
  private readonly opts: ChannelOptions;
  private readonly reply: ChannelReply = {
    json: (msg) => { this.sendJson(msg); },
    inner: (chunk) => { this.sendInner({ kind: 'blob', ...chunk }); },
  };

  constructor(opts: ChannelOptions) {
    this.opts = opts;
    this.nextId = opts.role === 'initiator' ? 1 : RESPONDER_FIRST_ID;
  }

  /** The peer's hello is in: asks go through, if it serves. */
  get ready(): boolean {
    return this.cipher !== null && this.peerHello !== null && !this.closed;
  }

  /** Keys are set, whether or not the peer's hello is in yet. */
  get keyed(): boolean {
    return this.cipher !== null && !this.closed;
  }

  get peer(): HelloMessage | null {
    return this.peerHello;
  }

  get serves(): boolean {
    return this.peerHello !== null && peerServes(this.peerHello);
  }

  /** The peer's hello named the `group` capability: it takes roster messages. */
  get groups(): boolean {
    return this.peerHello?.capabilities?.includes('group') === true;
  }

  on(listener: (event: ChannelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * The initiator's half, now and again every `handshakeTimeoutMs` until a
   * reply completes it and the peer's hello follows; anything tied to a
   * previous handshake is dropped first. A responder only answers, so this
   * does nothing there.
   */
  start(): void {
    if (this.opts.role !== 'initiator' || this.closed) return;
    this.reset('lost');
    const handshake = startHandshake(this.opts.identity, this.opts.peerKey, 'initiator');
    this.handshake = handshake;
    // Armed before the send: a peer that answers synchronously completes the
    // handshake inside `send`, and that re-arms this timer.
    this.armRestart();
    this.opts.send(handshake.message!);
  }

  receive(body: Uint8Array): void {
    if (this.closed) return;
    if (this.silenceTimer) this.armSilence();
    if (!this.cipher) return this.completeHandshake(body);
    const plain = this.cipher.open(body);
    if (!plain) {
      if (this.opts.role === 'responder' && body.length === HANDSHAKE_BYTES) this.rehandshake(body);
      else this.dropped++;
      return;
    }
    const inner = decodeInner(plain);
    if (!inner) {
      this.dropped++;
      return;
    }
    if (inner.kind === 'blob') return this.onBlob(inner);
    const parsed = parseChannelMessage(inner.value);
    if (!parsed) {
      this.dropped++;
      return;
    }
    if (parsed.kind === 'hello') return this.onHello(parsed.msg);
    // A `bye` comes before any hello when the responder refuses one.
    if (parsed.kind === 'answer') return this.onAnswer(parsed.msg);
    if (parsed.kind === 'group') {
      // `groups`, checked here, is this side's view of the sender's hello:
      // a peer that never named the capability does not get to say otherwise.
      if (this.groups) this.emit({ type: 'group', msg: parsed.msg });
      else this.dropped++;
      return;
    }
    if (this.peerHello && this.opts.serve) this.serving(this.opts.serve, (s) => s.ask(parsed.msg));
  }

  /** `reason` goes to the peer as `bye` when there are keys to send it with. */
  close(reason?: ByeReason, needed?: string): void {
    if (this.closed) return;
    if (reason && this.cipher) this.sendJson({ t: 'bye', reason, ...(needed !== undefined ? { needed } : {}) });
    this.reset('lost');
    this.closed = true;
    this.emit({ type: 'closed' });
  }

  request(method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    if (!this.ready || !this.serves) return Promise.reject(new TunnelError('offline'));
    const id = this.nextId++;
    return new Promise<TunnelResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(this.requests, id, new TunnelError('timeout')), this.requestTimeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      const msg: AskMessage =
        body === undefined ? { t: 'http', id, method, path } : { t: 'http', id, method, path, body };
      if (!this.sendJson(msg)) this.fail(this.requests, id, new TunnelError('lost'));
    });
  }

  /** `edge`: a thumbnail of at most this many pixels on its longest side, when the peer makes one. */
  getBlob(ref: string, opts: { edge?: number } = {}): Promise<BlobResult> {
    const edge = opts.edge !== undefined ? { edge: opts.edge } : {};
    return this.receiveBlob((id) => ({ t: 'blob_get', id, ref, ...edge }), {})
      .then(({ status, bytes, mediaType }) => ({ status, bytes, mediaType }));
  }

  /**
   * A file a session may show, by path (spec 2026-10-05-mobile-next-design
   * § 2): the Mac decides what that is and answers a refusal as a status,
   * never as a rejection. The idle timeout re-arms with every chunk, so a
   * large file on a slow link is fine while it keeps moving.
   */
  getFile(session: string, path: string, as: FileAs, opts: GetFileOptions = {}): Promise<FileResult> {
    const cwd = opts.cwd ? { cwd: opts.cwd } : {};
    const edge = opts.edge !== undefined ? { edge: opts.edge } : {};
    return this.receiveBlob((id) => ({ t: 'file_get', id, session, path, as, ...cwd, ...edge }), opts);
  }

  /** Uploads an image into the Mac's store: the header, every chunk, then one `blob_put_done` answers. */
  putBlob(bytes: Uint8Array, mediaType: string): Promise<PutBlobResult> {
    if (!this.ready || !this.serves) return Promise.reject(new TunnelError('offline'));
    const id = this.nextId++;
    return new Promise<PutBlobResult>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(this.puts, id, new TunnelError('timeout')), this.requestTimeoutMs);
      const waiter: Waiter<PutBlobResult> = { resolve, reject, timer };
      this.puts.set(id, waiter);
      if (!this.sendJson({ t: 'blob_put', id, mediaType, bytes: bytes.length })) {
        this.fail(this.puts, id, new TunnelError('lost'));
        return;
      }
      for (const chunk of chunkBlob(id, bytes)) {
        if (!this.sendInner(chunk)) {
          this.fail(this.puts, id, new TunnelError('lost'));
          return;
        }
      }
      // The Mac answers only once it holds every chunk: the timeout counts from the last one sent.
      clearTimeout(waiter.timer);
      waiter.timer = setTimeout(() => this.fail(this.puts, id, new TunnelError('timeout')), this.requestTimeoutMs);
    });
  }

  getNotifications(): Promise<NotificationSettings> {
    return this.askNotifications({ t: 'notifications_get' });
  }

  setNotifications(settings: NotificationSettings): Promise<NotificationSettings> {
    return this.askNotifications({ t: 'notifications_set', settings });
  }

  seen(sessionId: string): void {
    if (this.ready && this.serves) this.sendJson({ t: 'seen', sessionId });
  }

  /** A roster message to a peer that takes them; false (nothing sent) otherwise. */
  sendGroup(msg: GroupMessage): boolean {
    if (!this.ready || !this.groups) return false;
    return this.sendJson(msg);
  }

  subscribe(topic: string): void {
    if (this.topics.has(topic)) return;
    this.topics.add(topic);
    if (this.ready && this.serves) this.sendJson({ t: 'ws', type: 'subscribe', topic });
  }

  unsubscribe(topic: string): void {
    if (!this.topics.delete(topic)) return;
    if (this.ready && this.serves) this.sendJson({ t: 'ws', type: 'unsubscribe', topic });
  }

  private get requestTimeoutMs(): number {
    return this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private completeHandshake(body: Uint8Array): void {
    if (this.opts.role === 'responder') {
      // `complete` is single-use, so a bad first frame leaves nothing to retry.
      const handshake = startHandshake(this.opts.identity, this.opts.peerKey, 'responder');
      const cipher = handshake.complete(body);
      if (!cipher || !handshake.message) return this.close();
      this.cipher = cipher;
      this.opts.send(handshake.message);
      return;
    }
    const handshake = this.handshake;
    if (!handshake || body.length !== HANDSHAKE_BYTES) {
      this.dropped++;
      return;
    }
    this.handshake = null;
    const cipher = handshake.complete(body);
    // A reply that does not verify used the handshake up; the armed timer sends a fresh one.
    if (!cipher) {
      this.dropped++;
      return;
    }
    this.cipher = cipher;
    // Keys alone are not a channel: a peer that keeps them but never greets
    // (its hello lost, or a refusal it had no keys to send) would leave this
    // side keyed and never ready. Armed before the send, as in `start`.
    this.armRestart();
    this.sendJson(this.ownHello());
  }

  /** The initiator's retry: a fresh handshake unless the peer's hello is in by then. */
  private armRestart(): void {
    this.handshakeTimer = this.clear(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (!this.peerHello) this.start();
    }, this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  }

  /**
   * A body the keys cannot open but sized like a handshake: the initiator
   * started over on a new socket while this side kept the channel. It
   * completes only if it verifies against the peer's identity, so nobody
   * else can reset the channel (as `PhoneSession` did until 2026-10-16).
   */
  private rehandshake(body: Uint8Array): void {
    const handshake = startHandshake(this.opts.identity, this.opts.peerKey, 'responder');
    const cipher = handshake.complete(body);
    if (!cipher || !handshake.message) return;
    this.reset('lost');
    this.cipher = cipher;
    this.opts.send(handshake.message);
  }

  private onHello(hello: HelloMessage): void {
    if (this.peerHello) return;
    if (this.opts.role === 'responder') {
      if (hello.protocol !== PROTOCOL_VERSION) return this.close('protocol');
      const verdict = this.opts.judge?.(hello) ?? null;
      if (verdict) return this.close(verdict.reason, verdict.needed);
    }
    this.peerHello = hello;
    this.handshakeTimer = this.clear(this.handshakeTimer);
    if (this.opts.role === 'responder') this.sendJson(this.ownHello());
    if (this.opts.serve) this.serving(this.opts.serve, (s) => s.open(this.reply, hello));
    this.emit({ type: 'hello', hello });
    if (this.serves) {
      this.armSilence();
      // The peer dropped the previous connection's subscriptions.
      for (const topic of this.topics) this.sendJson({ t: 'ws', type: 'subscribe', topic });
    }
    this.emit({ type: 'ready', ready: true });
  }

  private ownHello(): HelloMessage {
    return { t: 'hello', protocol: PROTOCOL_VERSION, ...this.opts.hello };
  }

  private onAnswer(msg: AnswerMessage): void {
    switch (msg.t) {
      case 'bye':
        this.reset('bye');
        this.emit({ type: 'bye', reason: msg.reason, ...(msg.needed !== undefined ? { needed: msg.needed } : {}) });
        return;
      case 'ws':
        this.emit({ type: 'hub', frame: msg.frame });
        return;
      case 'http_res': {
        const waiter = this.requests.get(msg.id);
        if (!waiter) return;
        this.requests.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve({ status: msg.status, body: msg.body });
        return;
      }
      case 'blob_meta': {
        const waiter = this.blobs.get(msg.id);
        if (!waiter) return;
        waiter.size = msg.size ?? null;
        waiter.w = msg.w ?? null;
        waiter.h = msg.h ?? null;
        if (msg.status === 200) {
          if (msg.bytes !== undefined && msg.bytes < 0) {
            this.fail(this.blobs, msg.id, new TunnelError('lost'));
            return;
          }
          waiter.mediaType = msg.mediaType ?? null;
          waiter.total = msg.bytes ?? null;
          this.rearmBlob(msg.id, waiter);
          return;
        }
        this.blobs.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve({
          status: msg.status, bytes: new Uint8Array(0), mediaType: msg.mediaType ?? null,
          size: waiter.size, w: waiter.w, h: waiter.h,
        });
        return;
      }
      case 'notifications': {
        // The Mac answers each notifications call once, in order: a reply settles the oldest waiter only.
        const waiter = this.notificationWaiters.shift();
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waiter.resolve(msg.settings);
        return;
      }
      case 'blob_put_done': {
        const waiter = this.puts.get(msg.id);
        if (!waiter) return;
        if (msg.entry) {
          this.puts.delete(msg.id);
          clearTimeout(waiter.timer);
          waiter.resolve({ kind: 'ok', entry: msg.entry });
        } else if (msg.error === 'too_large' || msg.error === 'not_image') {
          this.puts.delete(msg.id);
          clearTimeout(waiter.timer);
          waiter.resolve({ kind: msg.error });
        } else {
          this.fail(this.puts, msg.id, new TunnelError('lost'));
        }
        return;
      }
    }
  }

  /**
   * A chunk of a blob this side asked for, by the id it chose; any other id
   * is the peer's upload, for the serving half. The two id ranges never
   * meet (`RESPONDER_FIRST_ID`), so a download is never taken for an upload.
   */
  private onBlob(chunk: BlobChunk): void {
    const waiter = this.blobs.get(chunk.id);
    if (!waiter) {
      if (this.peerHello && this.opts.serve) this.serving(this.opts.serve, (s) => s.chunk(chunk));
      else this.dropped++;
      return;
    }
    // A gap or a repeat makes the bytes wrong, not late; the server's `ServingHalf` refuses an upload the same way.
    if (chunk.seq !== waiter.nextSeq) {
      this.fail(this.blobs, chunk.id, new TunnelError('lost'));
      return;
    }
    // More than was announced, or past the bound for one that announced nothing: the rest is not taken in.
    if (waiter.received + chunk.bytes.length > (waiter.total ?? DOWNLOAD_MAX_BYTES)) {
      this.fail(this.blobs, chunk.id, new TunnelError('lost'));
      return;
    }
    waiter.nextSeq++;
    waiter.parts.push(chunk.bytes);
    waiter.received += chunk.bytes.length;
    try {
      waiter.onProgress?.(waiter.received, waiter.total);
    } catch {
      /* a throwing progress listener is its own problem; the transfer goes on */
    }
    // The listener may have closed the channel, which failed this waiter.
    if (this.blobs.get(chunk.id) !== waiter) return;
    if (!chunk.last) {
      this.rearmBlob(chunk.id, waiter);
      return;
    }
    this.blobs.delete(chunk.id);
    clearTimeout(waiter.timer);
    waiter.resolve({
      status: 200, bytes: concat(...waiter.parts), mediaType: waiter.mediaType,
      size: waiter.size, w: waiter.w, h: waiter.h,
    });
  }

  /** What `getBlob` and `getFile` share: ask, then `blob_meta` and the chunks (`onAnswer`, `onBlob`). */
  private receiveBlob(ask: (id: number) => AskMessage, opts: GetFileOptions): Promise<FileResult> {
    if (!this.ready || !this.serves) return Promise.reject(new TunnelError('offline'));
    const id = this.nextId++;
    const idleMs = opts.idleTimeoutMs ?? this.requestTimeoutMs;
    return new Promise<FileResult>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(this.blobs, id, new TunnelError('timeout')), idleMs);
      // The whole download's deadline, beside the idle timer that every chunk re-arms; gone once it settles.
      const deadline = setTimeout(
        () => this.fail(this.blobs, id, new TunnelError('timeout')), this.opts.downloadDeadlineMs ?? DOWNLOAD_DEADLINE_MS,
      );
      this.blobs.set(id, {
        resolve: (result) => { clearTimeout(deadline); resolve(result); },
        reject: (err) => { clearTimeout(deadline); reject(err); },
        timer, mediaType: null, parts: [], nextSeq: 0, received: 0, total: null,
        size: null, w: null, h: null, idleMs, onProgress: opts.onProgress,
      });
      if (!this.sendJson(ask(id))) this.fail(this.blobs, id, new TunnelError('lost'));
    });
  }

  /** A large image is many chunks: its timeout counts from the last one, not from the ask. */
  private rearmBlob(id: number, waiter: BlobWaiter): void {
    clearTimeout(waiter.timer);
    waiter.timer = setTimeout(() => this.fail(this.blobs, id, new TunnelError('timeout')), waiter.idleMs);
  }

  private askNotifications(msg: AskMessage): Promise<NotificationSettings> {
    if (!this.ready || !this.serves) return Promise.reject(new TunnelError('offline'));
    return new Promise<NotificationSettings>((resolve, reject) => {
      const waiter: Waiter<NotificationSettings> = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const at = this.notificationWaiters.indexOf(waiter);
          if (at >= 0) this.notificationWaiters.splice(at, 1);
          reject(new TunnelError('timeout'));
        }, this.requestTimeoutMs),
      };
      this.notificationWaiters.push(waiter);
      if (this.sendJson(msg)) return;
      this.notificationWaiters.splice(this.notificationWaiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      reject(new TunnelError('lost'));
    });
  }

  private fail<T>(map: Map<number, Waiter<T>>, id: number, err: TunnelError): void {
    const waiter = map.get(id);
    if (!waiter) return;
    map.delete(id);
    clearTimeout(waiter.timer);
    waiter.reject(err);
  }

  /**
   * Ends the current keys (not the channel): a pending handshake and its
   * retry go, everything waiting fails with `why`, and the serving half
   * forgets what was tied to them.
   */
  private reset(why: 'lost' | 'bye'): void {
    const wasReady = this.ready;
    this.cipher = null;
    this.peerHello = null;
    this.handshake = null;
    this.handshakeTimer = this.clear(this.handshakeTimer);
    this.silenceTimer = this.clear(this.silenceTimer);
    const err = new TunnelError(why);
    for (const id of [...this.requests.keys()]) this.fail(this.requests, id, err);
    for (const id of [...this.blobs.keys()]) this.fail(this.blobs, id, err);
    for (const id of [...this.puts.keys()]) this.fail(this.puts, id, err);
    for (const waiter of this.notificationWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    if (this.opts.serve) this.serving(this.opts.serve, (s) => s.reset());
    if (wasReady) this.emit({ type: 'ready', ready: false });
  }

  private armSilence(): void {
    this.silenceTimer = this.clear(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.emit({ type: 'silent' }), this.opts.silenceTimeoutMs ?? TUNNEL_SILENCE_TIMEOUT_MS);
  }

  private sendJson(msg: HelloMessage | AskMessage | AnswerMessage | GroupMessage): boolean {
    const plain = encodeInner({ kind: 'json', value: msg });
    if (plain.length <= MAX_INNER_BYTES) return this.sendPlain(plain);
    // Only a REST answer (a transcript page, a file preview) and a hub frame
    // can be arbitrarily large; everything else is bounded by construction.
    if (msg.t === 'http_res') {
      return this.sendInner({ kind: 'json', value: { t: 'http_res', id: msg.id, status: 413, body: { error: 'too_large' } } });
    }
    // A hub frame can be as large as the message it carries (one huge tool
    // result). Dropping it silently would leave a hole in the peer's
    // transcript it could never notice; this tells it what to refetch.
    if (msg.t === 'ws' && 'frame' in msg) {
      const frame = msg.frame as { topic?: unknown; message?: { id?: unknown } } | null;
      const id = frame?.message?.id;
      return this.sendInner({
        kind: 'json',
        value: { t: 'ws', frame: { topic: frame?.topic, event: 'dropped', reason: 'too_large', ...(id !== undefined ? { id } : {}) } },
      });
    }
    return this.sendPlain(plain);
  }

  private sendInner(inner: Inner): boolean {
    return this.sendPlain(encodeInner(inner));
  }

  /** `send` frames the body and may throw past `MAX_FRAME_BYTES`; its callers run in a frame loop: drop, don't throw. */
  private sendPlain(plain: Uint8Array): boolean {
    if (!this.cipher || this.closed) return false;
    try {
      this.opts.send(this.cipher.seal(plain));
      return true;
    } catch (err) {
      try {
        this.opts.onSendError?.(err);
      } catch {
        /* the caller's report of a failure is its own problem */
      }
      return false;
    }
  }

  /** The serving half is the caller's code; a throw there must not unwind into the frame loop. */
  private serving(server: ChannelServer, call: (server: ChannelServer) => void): void {
    try {
      call(server);
    } catch {
      /* the serving half answers its own failures */
    }
  }

  private emit(event: ChannelEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a listener's bug is its own; the protocol carries on */
      }
    }
  }

  private clear(timer: Timer | null): null {
    if (timer) clearTimeout(timer);
    return null;
  }
}
