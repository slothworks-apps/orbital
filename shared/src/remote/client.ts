/**
 * The phone's side of the mobile remote: one relay link, and one end-to-end
 * tunnel to one Mac that is a `Channel` (channel.ts) — the handshake, the
 * hello and the asking half live there; this file keeps the socket, the
 * relay's control messages and when a channel starts and ends (spec
 * 2026-10-02-mobile-app-design § 2; the parent spec's § 7 is the contract).
 * No DOM and no Node: the WebSocket is injected — the WebView's on the
 * phone, `ws` in the server's end-to-end test (ADR
 * the-phone-client-lives-in-shared-and-tests-against-the-real-mac).
 *
 * Nothing here throws into a caller's event loop: a bad frame is dropped and
 * counted (`dropped`), a listener that throws is its own problem.
 */
import { deviceId, fromBase64Url, publicKeyOf, type Identity } from './keys.js';
import { ZERO_WAKE, decodeFrame, encodeFrame } from './frame.js';
import type { FileAs, NotificationSettings } from './messages.js';
import {
  CLOSE_BAD_SECRET, PAIRING_TOKEN_TTL_MS, RelayToDevice, authSignature, pairingProof, relayWsUrl,
  sealPairingDevice, signRequest, type DeviceToRelay,
} from './relayApi.js';
import { RELAY_VERSION_HEADER, relayAnswerTooOld, relayTooOld, type RelayTooOld } from './version.js';
import { capabilitiesOf } from './device.js';
import {
  Channel, TunnelError, type BlobResult, type ByeReason, type ChannelEvent, type FileResult, type GetFileOptions,
  type HttpMethod, type PutBlobResult, type TunnelResponse,
} from './channel.js';

export { TunnelError, HANDSHAKE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, TUNNEL_SILENCE_TIMEOUT_MS } from './channel.js';
export type {
  HttpMethod, ByeReason, TunnelResponse, BlobResult, FileResult, GetFileOptions, PutBlobResult, TunnelFailure,
} from './channel.js';

/** First reconnect delay; it doubles per failed attempt up to `RECONNECT_MAX_MS` — the Mac's `RelayClient` shape. */
export const RECONNECT_DELAY_MS = 3_000;
export const RECONNECT_MAX_MS = 30_000;
/** A socket stuck between open and `ok` is worse than no socket. */
export const CONNECT_TIMEOUT_MS = 15_000;

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

export type RemoteClientEvent =
  | { type: 'status'; status: LinkStatus }
  | { type: 'presence'; macOnline: boolean }
  | { type: 'hello'; server: string; macName: string }
  /** True once a cipher exists and the Mac said hello; false when that tunnel is gone. */
  | { type: 'ready'; ready: boolean }
  /** `needed`: the Mac's `MIN_PHONE_VERSION`, with `app_too_old`. */
  | { type: 'bye'; reason: ByeReason; needed?: string }
  /** The Mac confirmed; its name is the QR's, the relay knows none. */
  | { type: 'paired' }
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

export type RemoteClientOptions = {
  relayUrl: string;
  /** The Mac's id from the QR. */
  mac: string;
  identity: Identity;
  WebSocketImpl: SocketConstructor;
  /** What `hello` names this app as. */
  app: string;
  /** The phone's OS as `hello` names it (`osName` of the Capacitor platform); absent in tests that do not care. */
  os?: string;
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

export class RemoteClient {
  status: LinkStatus = 'off';
  macOnline = false;
  /** Frames dropped as unreadable since construction before they reached a channel, which counts its own. */
  dropped = 0;
  private ws: SocketLike | null = null;
  private stopped = true;
  /** Stopped because the relay is too old (`relay_too_old`); `recheck` may knock again, since a relay gets updated. */
  private relayRefused = false;
  private attempt = 0;
  private reconnectTimer: Timer | null = null;
  private connectTimer: Timer | null = null;
  /** The tunnel to the Mac; none while the Mac is away or the socket is down. */
  private channel: Channel | null = null;
  private token: string | null = null;
  /** Starts as `opts.expectPaired`; turns true on `paired`, so every later connect asks the relay to confirm the pair. */
  private expectPaired: boolean;
  /** What the app subscribed to; every new channel is handed the lot. */
  private readonly topics = new Set<string>();
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

  /** A channel, and the Mac's hello on it: requests and subscriptions go through. */
  get ready(): boolean {
    return this.channel?.ready === true;
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
    return this.channel ? this.channel.request(method, path, body) : Promise.reject(new TunnelError('offline'));
  }

  getBlob(ref: string): Promise<BlobResult> {
    return this.channel ? this.channel.getBlob(ref) : Promise.reject(new TunnelError('offline'));
  }

  /** A file a session may show, by path; `Channel.getFile` says how it answers. */
  getFile(session: string, path: string, as: FileAs, opts: GetFileOptions = {}): Promise<FileResult> {
    return this.channel ? this.channel.getFile(session, path, as, opts) : Promise.reject(new TunnelError('offline'));
  }

  /** Uploads an image into the Mac's store; `Channel.putBlob` says how. */
  putBlob(bytes: Uint8Array, mediaType: string): Promise<PutBlobResult> {
    return this.channel ? this.channel.putBlob(bytes, mediaType) : Promise.reject(new TunnelError('offline'));
  }

  getNotifications(): Promise<NotificationSettings> {
    return this.channel ? this.channel.getNotifications() : Promise.reject(new TunnelError('offline'));
  }

  setNotifications(settings: NotificationSettings): Promise<NotificationSettings> {
    return this.channel ? this.channel.setNotifications(settings) : Promise.reject(new TunnelError('offline'));
  }

  seen(sessionId: string): void {
    this.channel?.seen(sessionId);
  }

  /** Kept and sent on every `ok` and again after `paired`: the relay drops a token from a device it has no row for (parent § 7). */
  pushToken(token: string): void {
    this.token = token;
    this.sendPushToken();
  }

  subscribe(topic: string): void {
    this.topics.add(topic);
    this.channel?.subscribe(topic);
  }

  unsubscribe(topic: string): void {
    this.topics.delete(topic);
    this.channel?.unsubscribe(topic);
  }

  /**
   * Posts `/pair/redeem` with the proof that this key scanned the QR, and
   * this device's `name`, `platform` and `kind` sealed for the Mac alone. Never
   * rejects: an unreachable relay answers status 0, as the Mac's
   * `RelayClient.post` does. A 200 only means the relay passed it on; call
   * `waitForPairing` first and await it after.
   *
   * `relayTooOld` is set when the answer came from a relay below
   * `MIN_RELAY_VERSION`: the client has then emitted `relay_too_old` and
   * stopped, and the pairing goes no further.
   */
  async redeem(
    token: string, secret: string, name: string, platform: string, kind = 'phone',
  ): Promise<{ status: number; body: unknown; relayTooOld?: RelayTooOld }> {
    const key = fromBase64Url(secret);
    const payload = {
      token,
      proof: pairingProof(key, this.opts.identity.publicKey),
      device: sealPairingDevice(key, this.opts.identity.publicKey, { name, platform, kind }),
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
    this.dropTunnel();
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
        else this.dropTunnel();
        return;
      case 'paired':
        if (msg.mac !== this.opts.mac) return;
        // A pair exists from here on: a revoke while this client is away must reach it on its next connect.
        this.expectPaired = true;
        this.emit({ type: 'paired' });
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
   * Opens a channel to the Mac (parent § 7: on `paired`, on `ok` listing the
   * Mac, on its `presence` online). One handshake at a time: `paired` is
   * followed by a `presence` for the same Mac, and a second half would use up
   * the first one's reply — a channel that exists but is not ready is that
   * handshake, retrying on its own. A live tunnel when the Mac reappears is
   * stale — the Mac's phone sessions died with its relay link — and is
   * replaced.
   */
  private beginHandshake(macCameBack = false): void {
    if (!this.ws || this.status !== 'online') return;
    if (this.channel && !this.channel.ready) return;
    if (this.channel && !macCameBack) return;
    this.dropTunnel();
    const channel = new Channel({
      identity: this.opts.identity,
      peerKey: this.macKey,
      role: 'initiator',
      hello: {
        app: this.opts.app, kind: 'phone', ...(this.opts.os ? { os: this.opts.os } : {}), capabilities: capabilitiesOf('phone'),
      },
      send: (body) => this.sendFrame(body),
      handshakeTimeoutMs: this.opts.handshakeTimeoutMs,
      requestTimeoutMs: this.opts.requestTimeoutMs,
      silenceTimeoutMs: this.opts.silenceTimeoutMs,
    });
    for (const topic of this.topics) channel.subscribe(topic);
    channel.on((event) => this.onChannel(channel, event));
    this.channel = channel;
    channel.start();
  }

  /** What the current channel says, in the client's own events; a replaced channel says nothing. */
  private onChannel(channel: Channel, event: ChannelEvent): void {
    if (this.channel !== channel) return;
    switch (event.type) {
      case 'hello':
        // A shipped Mac's hello always names both; only a device kind that does not serve leaves them out.
        this.emit({ type: 'hello', server: event.hello.server ?? '', macName: event.hello.macName ?? '' });
        return;
      case 'ready':
        this.emit({ type: 'ready', ready: event.ready });
        return;
      case 'hub':
        this.emit({ type: 'hub', frame: event.frame });
        return;
      case 'bye':
        // The channel has failed its waiters with `bye`; it goes, so the Mac's next return opens a fresh one.
        this.dropTunnel();
        this.emit({ type: 'bye', reason: event.reason, ...(event.needed !== undefined ? { needed: event.needed } : {}) });
        if (event.reason === 'revoked') this.stop();
        return;
      case 'silent':
        this.lose(this.ws);
        return;
      case 'closed':
        return;
    }
  }

  private onBinary(data: unknown): void {
    const bytes = toBytes(data);
    if (!bytes) {
      this.dropped++;
      return;
    }
    const frame = decodeFrame(bytes);
    if (!frame || !sameBytes(frame.peer, this.macKey)) {
      this.dropped++;
      return;
    }
    if (frame.body.length === 0) {
      this.emit({ type: 'wake', flags: frame.flags });
      return;
    }
    if (this.channel) this.channel.receive(frame.body);
    else this.dropped++;
  }

  /** Ends the current tunnel (not the relay link): everything waiting on it fails with `lost`, and it stops retrying. */
  private dropTunnel(): void {
    const channel = this.channel;
    if (!channel) return;
    const wasReady = channel.ready;
    // Forgotten first, so what the closing channel says is not taken for the next one's.
    this.channel = null;
    channel.close();
    if (wasReady) this.emit({ type: 'ready', ready: false });
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
