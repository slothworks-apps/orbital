/**
 * The phone's side of the mobile remote: one relay link (`RelayLink`,
 * relayLink.ts — the socket, the relay's control messages, reconnect), and
 * one end-to-end tunnel to one Mac that is a `Channel` (channel.ts) — the
 * handshake, the hello and the asking half live there; this file keeps which
 * of the link's peers is the Mac and when a channel starts and ends (spec
 * 2026-10-02-mobile-app-design § 2; the parent spec's § 7 is the contract).
 * No DOM and no Node: the WebSocket is injected — the WebView's on the
 * phone, `ws` in the server's end-to-end test (ADR
 * the-phone-client-lives-in-shared-and-tests-against-the-real-mac).
 *
 * Nothing here throws into a caller's event loop: a bad frame is dropped and
 * counted (`dropped`), a listener that throws is its own problem.
 *
 * The app no longer runs this: a phone is a group member (`GroupClient`).
 * It stays as a stand-in for a shipped phone in the server's tests — an
 * approximation, since it runs on today's `RelayLink`, not the shipped
 * socket code. The types the app uses live in tunnel.ts.
 */
import { deviceId, fromBase64Url, publicKeyOf, type Identity } from './keys.js';
import type { FileAs, NotificationSettings } from './messages.js';
import { PAIRING_TOKEN_TTL_MS, pairingProof, sealPairingDevice } from './relayApi.js';
import type { TunnelEvent } from './tunnel.js';
import type { RelayTooOld } from './version.js';
import { RelayLink, type LinkStatus, type RelayLinkEvent, type SocketConstructor } from './relayLink.js';
import { capabilitiesOf } from './device.js';
import {
  Channel, TunnelError, type BlobResult, type ChannelEvent, type FileResult, type GetFileOptions,
  type HttpMethod, type PutBlobResult, type TunnelResponse,
} from './channel.js';

export { TunnelError, HANDSHAKE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, TUNNEL_SILENCE_TIMEOUT_MS } from './channel.js';
export type {
  HttpMethod, ByeReason, TunnelResponse, BlobResult, FileResult, GetFileOptions, PutBlobResult, TunnelFailure,
} from './channel.js';

export { RECONNECT_DELAY_MS, RECONNECT_MAX_MS, CONNECT_TIMEOUT_MS } from './relayLink.js';
export type { SocketLike, SocketConstructor, LinkStatus } from './relayLink.js';

/** What the client emits: the app's `TunnelEvent`. */
export type RemoteClientEvent = TunnelEvent;

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

export class RemoteClient {
  macOnline = false;
  /** Frames dropped here: from a device that is not the Mac, or from the Mac while no channel is open. */
  private ownDropped = 0;
  /** The tunnel to the Mac; none while the Mac is away or the socket is down. */
  private channel: Channel | null = null;
  /** What the app subscribed to; every new channel is handed the lot. */
  private readonly topics = new Set<string>();
  private readonly listeners = new Set<(event: RemoteClientEvent) => void>();
  private readonly opts: RemoteClientOptions;
  private readonly macKey: Uint8Array;
  /** The Mac's id in its one canonical form, as frames name their peer. */
  private readonly macId: string;
  private readonly link: RelayLink;

  constructor(opts: RemoteClientOptions) {
    const macKey = publicKeyOf(opts.mac);
    if (!macKey) throw new Error('mac is not a device id');
    this.opts = opts;
    this.macKey = macKey;
    this.macId = deviceId(macKey);
    this.link = new RelayLink({
      relayUrl: opts.relayUrl, identity: opts.identity, WebSocketImpl: opts.WebSocketImpl,
      relaySecret: opts.relaySecret, anchor: opts.mac, expectPaired: opts.expectPaired, now: opts.now,
      fetchImpl: opts.fetchImpl, reconnectDelayMs: opts.reconnectDelayMs, connectTimeoutMs: opts.connectTimeoutMs,
    });
    this.link.on((event) => this.onLink(event));
  }

  get id(): string {
    return this.link.id;
  }

  get status(): LinkStatus {
    return this.link.status;
  }

  /** Frames dropped as unreadable since construction before they reached a channel, which counts its own. */
  get dropped(): number {
    return this.link.dropped + this.ownDropped;
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
    this.link.start();
  }

  stop(): void {
    this.link.stop();
  }

  /**
   * One bounded presence check (9a's Retry, 9i's Try again, every return to
   * the foreground): a fresh relay link now, answered with whether the Mac is
   * online once the relay said `ok`, or with what is known when `windowMs`
   * runs out first.
   */
  recheck(windowMs: number): Promise<boolean> {
    return this.link.recheck(windowMs).then(() => this.macOnline);
  }

  request(method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    return this.channel ? this.channel.request(method, path, body) : Promise.reject(new TunnelError('offline'));
  }

  /** `edge`: a thumbnail of at most this many pixels on its longest side, when the Mac makes one. */
  getBlob(ref: string, opts: { edge?: number } = {}): Promise<BlobResult> {
    return this.channel ? this.channel.getBlob(ref, opts) : Promise.reject(new TunnelError('offline'));
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
    this.link.pushToken(token);
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
    return this.link.post('/pair/redeem', 'pair.redeem', payload);
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

  /** What the relay link says, narrowed to the Mac (parent § 7). */
  private onLink(event: RelayLinkEvent): void {
    switch (event.type) {
      case 'status':
        // The link leaves `online` only when its socket went: the tunnel and the Mac's presence go with it.
        if (event.status !== 'online') {
          this.dropTunnel();
          this.setMacOnline(false);
        }
        this.emit({ type: 'status', status: event.status });
        if (event.status === 'online' && this.macOnline) this.beginHandshake();
        return;
      case 'ok':
        this.setMacOnline(event.peers.includes(this.opts.mac));
        return;
      case 'presence':
        if (event.peer !== this.opts.mac) return;
        this.setMacOnline(event.online);
        if (event.online) this.beginHandshake(true);
        else this.dropTunnel();
        return;
      case 'paired':
        if (event.mac !== this.opts.mac) return;
        // The link has turned on `expectPaired` and sent the push token.
        this.emit({ type: 'paired' });
        this.setMacOnline(true);
        this.beginHandshake();
        return;
      case 'rejected':
        if (event.mac === this.opts.mac) this.emit({ type: 'rejected' });
        return;
      case 'unpaired':
        if (event.mac !== this.opts.mac) return;
        this.emit({ type: 'unpaired' });
        this.stop();
        return;
      case 'relay_error':
        this.emit({ type: 'relay_error', code: event.code });
        return;
      case 'relay_too_old':
        this.emit(event);
        return;
      case 'frame':
        if (event.peer === this.macId && this.channel) this.channel.receive(event.body);
        else this.ownDropped++;
        return;
      case 'wake':
        if (event.peer === this.macId) this.emit({ type: 'wake', flags: event.flags });
        else this.ownDropped++;
        return;
      case 'pair_request':
        return; // the Mac's message; a phone never gets one
      case 'linked':
        return; // the phone ignores it; the server handles it (Task 6)
    }
  }

  /**
   * Opens a channel to the Mac (parent § 7: on `paired`, on `ok` listing the
   * Mac, on its `presence` online). One handshake at a time: `paired` is
   * followed by a `presence` for the same Mac, and a second half would use up
   * the first one's reply — a channel still waiting for that reply is that
   * handshake, retrying on its own. A channel with keys when the Mac
   * reappears is stale, whether its hello came or not — the Mac's phone
   * sessions died with its relay link — and is replaced.
   */
  private beginHandshake(macCameBack = false): void {
    if (this.link.status !== 'online') return;
    if (this.channel && !this.channel.keyed) return;
    if (this.channel && !macCameBack) return;
    this.dropTunnel();
    const channel = new Channel({
      identity: this.opts.identity,
      peerKey: this.macKey,
      role: 'initiator',
      hello: {
        app: this.opts.app, kind: 'phone', ...(this.opts.os ? { os: this.opts.os } : {}), capabilities: capabilitiesOf('phone'),
      },
      send: (body) => this.link.send(this.macKey, body),
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
        this.emit({
          type: 'hello', server: event.hello.server ?? '', macName: event.hello.macName ?? '',
          ...(event.hello.kind !== undefined ? { kind: event.hello.kind } : {}),
          ...(event.hello.capabilities !== undefined ? { capabilities: event.hello.capabilities } : {}),
        });
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
        this.link.reconnect();
        return;
      case 'closed':
        return;
    }
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

  private emit(event: RemoteClientEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a listener's bug is its own; the protocol carries on */
      }
    }
  }

  private setMacOnline(online: boolean): void {
    if (this.macOnline === online) return;
    this.macOnline = online;
    this.emit({ type: 'presence', macOnline: online });
  }
}
