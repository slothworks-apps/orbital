/**
 * The phone's side of the mobile remote: one relay link, one end-to-end
 * tunnel to one Mac, and every rule the Mac's `PhoneSession` expects of the
 * other end (spec 2026-10-02-mobile-app-design § 2; the parent spec's § 7 is
 * the contract). No DOM and no Node: the WebSocket is injected — the
 * WebView's on the phone, `ws` in the server's end-to-end test (ADR
 * the-phone-client-lives-in-shared-and-tests-against-the-real-mac).
 *
 * Nothing here throws into a caller's event loop: a bad frame is dropped and
 * counted (`dropped`), a listener that throws is its own problem.
 */
import { concat, deviceId, fromBase64Url, publicKeyOf, type Identity } from './keys.js';
import { ZERO_WAKE, decodeFrame, encodeFrame } from './frame.js';
import { HANDSHAKE_BYTES, startHandshake, type Handshake, type SessionCipher } from './handshake.js';
import {
  MacMessage, PROTOCOL_VERSION, chunkBlob, decodeInner, encodeInner, type FileAs, type ImageRefEntry, type Inner,
  type NotificationSettings, type PhoneMessage,
} from './messages.js';
import {
  CLOSE_BAD_SECRET, PAIRING_TOKEN_TTL_MS, RELAY_PING_INTERVAL_MS, RelayToDevice, authSignature, pairingProof, relayWsUrl,
  signRequest, type DeviceToRelay,
} from './relayApi.js';
import { RELAY_VERSION_HEADER, relayAnswerTooOld, relayTooOld, type RelayTooOld } from './version.js';

/** First reconnect delay; it doubles per failed attempt up to `RECONNECT_MAX_MS` — the Mac's `RelayClient` shape. */
export const RECONNECT_DELAY_MS = 3_000;
export const RECONNECT_MAX_MS = 30_000;
/** A socket stuck between open and `ok` is worse than no socket. */
export const CONNECT_TIMEOUT_MS = 15_000;
/**
 * Silence on a live tunnel before the link is dropped and rebuilt. The Mac's
 * hub heartbeat rides the tunnel (the server's `WS_HEARTBEAT_INTERVAL_MS`);
 * the relay's own pings never reach page code — a browser answers them below
 * JavaScript — so this watchdog runs only while a tunnel is up.
 */
export const TUNNEL_SILENCE_TIMEOUT_MS = RELAY_PING_INTERVAL_MS * 3;
/** How long one handshake waits for the Mac's half before a fresh one goes out. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** How long a `request`, a `getBlob` or `getFile` (per chunk, unless told otherwise) or a notifications call waits for its answer. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** The relay's `RedeemPayload` caps (relay/src/pairing.ts). */
export const PAIR_NAME_MAX_CHARS = 80;
export const PAIR_PLATFORM_MAX_CHARS = 20;

/** What the client needs of a WebSocket: the browser's surface, which `ws` offers too. */
export interface SocketLike {
  binaryType: string;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
}
export type SocketConstructor = new (url: string) => SocketLike;

export type LinkStatus = 'off' | 'connecting' | 'online';
export type ByeReason = 'protocol' | 'revoked' | 'app_too_old';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RemoteClientEvent =
  | { type: 'status'; status: LinkStatus }
  | { type: 'presence'; macOnline: boolean }
  | { type: 'hello'; server: string; macName: string }
  /** True once a cipher exists and the Mac said hello; false when that tunnel is gone. */
  | { type: 'ready'; ready: boolean }
  /** `needed`: the Mac's `MIN_PHONE_VERSION`, with `app_too_old`. */
  | { type: 'bye'; reason: ByeReason; needed?: string }
  | { type: 'paired'; macName: string }
  | { type: 'rejected' }
  | { type: 'unpaired' }
  | { type: 'relay_error'; code: string }
  /**
   * The relay is below `MIN_RELAY_VERSION` (at connect, or in a redeem's
   * answer): the client has stopped, and only `recheck` or `start` tries
   * that relay again.
   */
  | ({ type: 'relay_too_old' } & RelayTooOld)
  /** A hub frame, verbatim — `dropped` ones included (parent § 7). */
  | { type: 'hub'; frame: unknown }
  /** A frame with an empty body: its header flags, and nothing else (parent § 7). */
  | { type: 'wake'; flags: number };

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

export type RemoteClientOptions = {
  relayUrl: string;
  /** The Mac's id from the QR. */
  mac: string;
  identity: Identity;
  WebSocketImpl: SocketConstructor;
  /** What `hello` names this app as. */
  app: string;
  /**
   * True when the client is built from a stored pairing: the relay then
   * answers `unpaired` on connect if the Mac no longer has this phone, which
   * is the only way a phone revoked while it was away ever learns it. Off
   * while pairing, when no pair exists yet; the client turns it on itself
   * once it hears `paired`.
   */
  expectPaired?: boolean;
  /**
   * The relay's shared secret, from the QR (`relaySecret`). Sent in `auth`
   * and with the redeem; absent for an open relay. A relay that refuses it
   * ends the client: `relay_error` `bad_secret`, then `stop()`.
   */
  relaySecret?: string;
  now?: () => number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  reconnectDelayMs?: number;
  connectTimeoutMs?: number;
  silenceTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
};

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

export class RemoteClient {
  status: LinkStatus = 'off';
  macOnline = false;
  /** Frames dropped as unreadable since construction. */
  dropped = 0;
  private ws: SocketLike | null = null;
  private stopped = true;
  /** Stopped because the relay is too old (`relay_too_old`); `recheck` may knock again, since a relay gets updated. */
  private relayRefused = false;
  private attempt = 0;
  private reconnectTimer: Timer | null = null;
  private connectTimer: Timer | null = null;
  private silenceTimer: Timer | null = null;
  private handshakeTimer: Timer | null = null;
  private handshake: Handshake | null = null;
  private cipher: SessionCipher | null = null;
  private greeted = false;
  private nextId = 1;
  private token: string | null = null;
  /** Starts as `opts.expectPaired`; turns true on `paired`, so every later connect asks the relay to confirm the pair. */
  private expectPaired: boolean;
  private readonly topics = new Set<string>();
  private readonly requests = new Map<number, Waiter<TunnelResponse>>();
  private readonly blobs = new Map<number, BlobWaiter>();
  private readonly puts = new Map<number, Waiter<PutBlobResult>>();
  private readonly notificationWaiters: Waiter<NotificationSettings>[] = [];
  private readonly listeners = new Set<(event: RemoteClientEvent) => void>();
  private readonly opts: RemoteClientOptions;
  private readonly macKey: Uint8Array;

  constructor(opts: RemoteClientOptions) {
    const macKey = publicKeyOf(opts.mac);
    if (!macKey) throw new Error('mac is not a device id');
    this.opts = opts;
    this.macKey = macKey;
    this.expectPaired = opts.expectPaired === true;
  }

  get id(): string {
    return deviceId(this.opts.identity.publicKey);
  }

  /** A cipher, and the Mac's hello on it: requests and subscriptions go through. */
  get ready(): boolean {
    return this.cipher !== null && this.greeted;
  }

  on(listener: (event: RemoteClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.relayRefused = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.reconnectTimer = this.clear(this.reconnectTimer);
    this.lose(this.ws, false);
    this.setStatus('off');
  }

  /**
   * One bounded presence check (9a's Retry, 9i's Try again, every return to
   * the foreground): a fresh relay link now, answered with whether the Mac is
   * online once the relay said `ok`, or with what is known when `windowMs`
   * runs out first.
   */
  recheck(windowMs: number): Promise<boolean> {
    if (this.stopped && !this.relayRefused) return Promise.resolve(false);
    // A relay refused as too old may have been updated since: this is the one way back to it.
    this.stopped = false;
    this.relayRefused = false;
    return new Promise<boolean>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        off();
        resolve(this.macOnline);
      };
      const timer = setTimeout(finish, windowMs);
      const off = this.on((event) => {
        if ((event.type === 'status' && event.status === 'online') || event.type === 'relay_too_old') finish();
      });
      this.reconnectTimer = this.clear(this.reconnectTimer);
      this.attempt = 0;
      this.lose(this.ws, false);
      this.connect();
    });
  }

  request(method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    if (!this.ready) return Promise.reject(new TunnelError('offline'));
    const id = this.nextId++;
    return new Promise<TunnelResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(this.requests, id, new TunnelError('timeout')), this.requestTimeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      const msg: PhoneMessage =
        body === undefined ? { t: 'http', id, method, path } : { t: 'http', id, method, path, body };
      if (!this.sendJson(msg)) this.fail(this.requests, id, new TunnelError('lost'));
    });
  }

  getBlob(ref: string): Promise<BlobResult> {
    return this.receiveBlob((id) => ({ t: 'blob_get', id, ref }), {})
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
    return this.receiveBlob((id) => ({ t: 'file_get', id, session, path, as, ...cwd }), opts);
  }

  /** What `getBlob` and `getFile` share: ask, then `blob_meta` and the chunks (`onMac`, `onChunk`). */
  private receiveBlob(ask: (id: number) => PhoneMessage, opts: GetFileOptions): Promise<FileResult> {
    if (!this.ready) return Promise.reject(new TunnelError('offline'));
    const id = this.nextId++;
    const idleMs = opts.idleTimeoutMs ?? this.requestTimeoutMs;
    return new Promise<FileResult>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(this.blobs, id, new TunnelError('timeout')), idleMs);
      this.blobs.set(id, {
        resolve, reject, timer, mediaType: null, parts: [], nextSeq: 0, received: 0, total: null,
        size: null, w: null, h: null, idleMs, onProgress: opts.onProgress,
      });
      if (!this.sendJson(ask(id))) this.fail(this.blobs, id, new TunnelError('lost'));
    });
  }

  /** Uploads an image into the Mac's store: the header, every chunk, then one `blob_put_done` answers. */
  putBlob(bytes: Uint8Array, mediaType: string): Promise<PutBlobResult> {
    if (!this.ready) return Promise.reject(new TunnelError('offline'));
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
    if (this.ready) this.sendJson({ t: 'seen', sessionId });
  }

  /** Kept and sent on every `ok` and again after `paired`: the relay drops a token from a device it has no row for (parent § 7). */
  pushToken(token: string): void {
    this.token = token;
    this.sendPushToken();
  }

  subscribe(topic: string): void {
    if (this.topics.has(topic)) return;
    this.topics.add(topic);
    if (this.ready) this.sendJson({ t: 'ws', type: 'subscribe', topic });
  }

  unsubscribe(topic: string): void {
    if (!this.topics.delete(topic)) return;
    if (this.ready) this.sendJson({ t: 'ws', type: 'unsubscribe', topic });
  }

  /**
   * Posts `/pair/redeem` with the proof that this key scanned the QR. Never
   * rejects: an unreachable relay answers status 0, as the Mac's
   * `RelayClient.post` does. A 200 only means the relay passed it on; call
   * `waitForPairing` first and await it after.
   *
   * `relayTooOld` is set when the answer came from a relay below
   * `MIN_RELAY_VERSION`: the client has then emitted `relay_too_old` and
   * stopped, and the pairing goes no further.
   */
  async redeem(
    token: string, secret: string, name: string, platform: string,
  ): Promise<{ status: number; body: unknown; relayTooOld?: RelayTooOld }> {
    const payload = {
      token,
      name: name.slice(0, PAIR_NAME_MAX_CHARS),
      platform: platform.slice(0, PAIR_PLATFORM_MAX_CHARS),
      proof: pairingProof(fromBase64Url(secret), this.opts.identity.publicKey),
    };
    const fetchImpl = this.opts.fetchImpl ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));
    const now = this.opts.now ?? Date.now;
    try {
      const res = await fetchImpl(new URL('/pair/redeem', this.opts.relayUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signRequest(this.opts.identity, 'pair.redeem', payload, now(), this.opts.relaySecret)),
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
      const tooOld = relayAnswerTooOld(res.headers.get(RELAY_VERSION_HEADER), res.ok);
      if (tooOld) {
        this.refuseRelay(tooOld);
        return { status: res.status, body, relayTooOld: tooOld };
      }
      return { status: res.status, body };
    } catch {
      return { status: 0, body: { error: 'network' } };
    }
  }

  /** The Mac's answer to a redeem, bounded by `PAIRING_TOKEN_TTL_MS` (parent § 7: a 200 can still go nowhere). */
  waitForPairing(timeoutMs = PAIRING_TOKEN_TTL_MS): Promise<'paired' | 'rejected' | 'timeout'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve('timeout');
      }, timeoutMs);
      const off = this.on((event) => {
        if (event.type !== 'paired' && event.type !== 'rejected') return;
        clearTimeout(timer);
        off();
        resolve(event.type);
      });
    });
  }

  /** As `bad_secret`: the relay will not update itself while we knock, so the client stops instead of looping. */
  private refuseRelay(tooOld: RelayTooOld): void {
    this.emit({ type: 'relay_too_old', ...tooOld });
    this.stop();
    this.relayRefused = true;
  }

  private get requestTimeoutMs(): number {
    return this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private connect(): void {
    this.setStatus('connecting');
    let ws: SocketLike;
    try {
      ws = new this.opts.WebSocketImpl(relayWsUrl(this.opts.relayUrl, this.opts.mac, { paired: this.expectPaired }));
    } catch {
      // A relay URL no socket can open will not open on the next attempt either.
      this.stopped = true;
      this.setStatus('off');
      this.emit({ type: 'relay_error', code: 'bad_url' });
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.connectTimer = setTimeout(() => this.lose(ws), this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    ws.onmessage = (ev: { data: unknown }) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === 'string') this.onControl(ws, ev.data);
      else this.onBinary(ev.data);
    };
    ws.onclose = (ev: { code?: number } | undefined) => {
      // The secret will not change on its own, so retrying would only knock
      // on the same door; the app treats it as the pair being gone.
      if (ev?.code === CLOSE_BAD_SECRET && this.ws === ws) {
        this.emit({ type: 'relay_error', code: 'bad_secret' });
        this.stop();
        return;
      }
      this.lose(ws);
    };
    ws.onerror = () => {
      /* `close` follows; that is where the link is rebuilt */
    };
  }

  /** Forgets one socket and everything tied to it; schedules the next attempt unless told not to or stopped. */
  private lose(ws: SocketLike | null, reconnect = true): void {
    if (!ws || this.ws !== ws) return;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* a socket that never opened may refuse to close */
    }
    this.connectTimer = this.clear(this.connectTimer);
    this.dropTunnel('lost');
    this.setMacOnline(false);
    if (!reconnect || this.stopped) return;
    const base = this.opts.reconnectDelayMs ?? RECONNECT_DELAY_MS;
    const delay = Math.min(base * 2 ** this.attempt++, RECONNECT_MAX_MS);
    // Forced: a repeated failure stays `connecting`, and listeners still hear of the attempt.
    this.setStatus('connecting', true);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onControl(ws: SocketLike, text: string): void {
    let msg: RelayToDevice;
    try {
      msg = RelayToDevice.parse(JSON.parse(text));
    } catch {
      this.dropped++;
      return;
    }
    switch (msg.type) {
      case 'challenge': {
        // An auth would only open a link the relay may not be able to carry.
        const tooOld = relayTooOld(msg.version);
        if (tooOld) {
          this.refuseRelay(tooOld);
          return;
        }
        this.sendControl(ws, {
          type: 'auth', pub: this.id, sig: authSignature(this.opts.identity, msg.nonce),
          ...(this.opts.relaySecret ? { secret: this.opts.relaySecret } : {}),
        });
        return;
      }
      case 'ok':
        this.connectTimer = this.clear(this.connectTimer);
        this.attempt = 0;
        this.setMacOnline(msg.peers.includes(this.opts.mac));
        this.setStatus('online');
        this.sendPushToken();
        if (this.macOnline) this.beginHandshake();
        return;
      case 'presence':
        if (msg.peer !== this.opts.mac) return;
        this.setMacOnline(msg.online);
        if (msg.online) this.beginHandshake(true);
        else this.dropTunnel('lost');
        return;
      case 'paired':
        if (msg.mac !== this.opts.mac) return;
        // A pair exists from here on: a revoke while this client is away must reach it on its next connect.
        this.expectPaired = true;
        this.emit({ type: 'paired', macName: msg.name });
        this.sendPushToken();
        this.setMacOnline(true);
        this.beginHandshake();
        return;
      case 'rejected':
        if (msg.mac === this.opts.mac) this.emit({ type: 'rejected' });
        return;
      case 'unpaired':
        if (msg.mac !== this.opts.mac) return;
        this.emit({ type: 'unpaired' });
        this.stop();
        return;
      case 'error':
        this.emit({ type: 'relay_error', code: msg.code });
        return;
      case 'pair_request':
        return; // the Mac's message; a phone never gets one
    }
  }

  /**
   * Sends the initiator's half (parent § 7: on `paired`, on `ok` listing the
   * Mac, on its `presence` online). One handshake at a time: `paired` is
   * followed by a `presence` for the same Mac, and a second half would use up
   * the first one's reply. A live tunnel when the Mac reappears is stale —
   * the Mac's phone sessions died with its relay link — and is replaced.
   */
  private beginHandshake(macCameBack = false): void {
    if (!this.ws || this.status !== 'online' || this.handshake) return;
    if (this.cipher && !macCameBack) return;
    this.dropTunnel('lost');
    const handshake = startHandshake(this.opts.identity, this.macKey, 'initiator');
    this.handshake = handshake;
    this.sendFrame(handshake.message!);
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      this.handshake = null;
      if (this.macOnline) this.beginHandshake();
    }, this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  }

  private onBinary(data: unknown): void {
    const bytes = toBytes(data);
    if (!bytes) {
      this.dropped++;
      return;
    }
    if (this.silenceTimer) this.armSilence();
    const frame = decodeFrame(bytes);
    if (!frame || !sameBytes(frame.peer, this.macKey)) {
      this.dropped++;
      return;
    }
    if (frame.body.length === 0) {
      this.emit({ type: 'wake', flags: frame.flags });
      return;
    }
    if (!this.cipher) {
      this.completeHandshake(frame.body);
      return;
    }
    const plain = this.cipher.open(frame.body);
    const inner = plain ? decodeInner(plain) : null;
    if (!inner) {
      this.dropped++;
      return;
    }
    if (inner.kind === 'blob') {
      this.onChunk(inner);
      return;
    }
    const parsed = MacMessage.safeParse(inner.value);
    if (!parsed.success) {
      this.dropped++;
      return;
    }
    this.onMac(parsed.data);
  }

  private completeHandshake(body: Uint8Array): void {
    const handshake = this.handshake;
    if (!handshake || body.length !== HANDSHAKE_BYTES) {
      this.dropped++;
      return;
    }
    this.handshake = null;
    const cipher = handshake.complete(body);
    // A reply that does not verify used the handshake up; the timer that is
    // still armed sends a fresh one.
    if (!cipher) {
      this.dropped++;
      return;
    }
    this.handshakeTimer = this.clear(this.handshakeTimer);
    this.cipher = cipher;
    this.sendJson({ t: 'hello', protocol: PROTOCOL_VERSION, app: this.opts.app });
  }

  private onMac(msg: MacMessage): void {
    switch (msg.t) {
      case 'hello':
        if (this.greeted) return;
        this.greeted = true;
        this.armSilence();
        this.emit({ type: 'hello', server: msg.server, macName: msg.macName });
        // The Mac dropped the previous connection's subscriptions (parent § 7).
        for (const topic of this.topics) this.sendJson({ t: 'ws', type: 'subscribe', topic });
        this.emit({ type: 'ready', ready: true });
        return;
      case 'bye':
        this.dropTunnel('bye');
        this.emit({ type: 'bye', reason: msg.reason, ...(msg.needed !== undefined ? { needed: msg.needed } : {}) });
        if (msg.reason === 'revoked') this.stop();
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

  private onChunk(chunk: { id: number; seq: number; last: boolean; bytes: Uint8Array }): void {
    const waiter = this.blobs.get(chunk.id);
    if (!waiter) {
      this.dropped++;
      return;
    }
    // A gap or a repeat makes the bytes wrong, not late; the Mac's `PhoneSession` refuses an upload the same way.
    if (chunk.seq !== waiter.nextSeq) {
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
    // The listener may have stopped the client, which failed this waiter.
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

  /** A large image is many chunks: its timeout counts from the last one, not from the ask. */
  private rearmBlob(id: number, waiter: BlobWaiter): void {
    clearTimeout(waiter.timer);
    waiter.timer = setTimeout(() => this.fail(this.blobs, id, new TunnelError('timeout')), waiter.idleMs);
  }

  private askNotifications(msg: PhoneMessage): Promise<NotificationSettings> {
    if (!this.ready) return Promise.reject(new TunnelError('offline'));
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

  /** Ends the current tunnel (not the relay link): everything waiting on it fails with `why`. */
  private dropTunnel(why: 'lost' | 'bye'): void {
    const wasReady = this.ready;
    this.cipher = null;
    this.greeted = false;
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
    if (wasReady) this.emit({ type: 'ready', ready: false });
  }

  private armSilence(): void {
    this.silenceTimer = this.clear(this.silenceTimer);
    const ws = this.ws;
    this.silenceTimer = setTimeout(() => this.lose(ws), this.opts.silenceTimeoutMs ?? TUNNEL_SILENCE_TIMEOUT_MS);
  }

  private sendJson(msg: PhoneMessage): boolean {
    return this.sendInner({ kind: 'json', value: msg });
  }

  private sendInner(inner: Inner): boolean {
    if (!this.cipher) return false;
    try {
      this.sendFrame(this.cipher.seal(encodeInner(inner)));
      return true;
    } catch {
      return false;
    }
  }

  private sendFrame(body: Uint8Array): void {
    // A copy typed as an `ArrayBuffer`, which both the browser and `ws` send as one binary frame.
    const frame = encodeFrame({ peer: this.macKey, flags: 0, wake: ZERO_WAKE, body }).slice().buffer;
    try {
      this.ws?.send(frame);
    } catch {
      /* a closing socket; its `close` rebuilds the link */
    }
  }

  private sendControl(ws: SocketLike, msg: DeviceToRelay): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* as in `sendFrame` */
    }
  }

  private sendPushToken(): void {
    // An empty token is a token too: "stop pushing to this phone" (a phone pairing a different Mac).
    if (this.token !== null && this.ws && this.status === 'online') this.sendControl(this.ws, { type: 'push_token', token: this.token });
  }

  private emit(event: RemoteClientEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a listener's bug is its own; the protocol carries on */
      }
    }
  }

  private setStatus(status: LinkStatus, force = false): void {
    if (this.status === status && !force) return;
    this.status = status;
    this.emit({ type: 'status', status });
  }

  private setMacOnline(online: boolean): void {
    if (this.macOnline === online) return;
    this.macOnline = online;
    this.emit({ type: 'presence', macOnline: online });
  }

  private clear(timer: Timer | null): null {
    if (timer) clearTimeout(timer);
    return null;
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data as ArrayBuffer);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
