/**
 * The phone's one socket to the relay, on its own: challenge → signed auth →
 * `ok`, the relay's control messages, binary frames to and from any peer,
 * reconnect with backoff, and signed requests to the relay. What runs over
 * it — one channel to one Mac (`RemoteClient`), or one to every member of a
 * group — is the caller's; this file filters no peer (spec
 * 2026-10-16-device-group-design § 5). No DOM and no Node: the WebSocket and
 * fetch are injected, as in `client.ts`.
 *
 * Nothing here throws into a caller's event loop: a bad frame is dropped and
 * counted (`dropped`), a listener that throws is its own problem.
 */
import { deviceId, type Identity } from './keys.js';
import { ZERO_WAKE, decodeFrame, encodeFrame } from './frame.js';
import {
  CLOSE_BAD_SECRET, RelayToDevice, authSignature, relayWsUrl, signRequest, type DeviceToRelay, type RelayAction,
} from './relayApi.js';
import { RELAY_VERSION_HEADER, relayAnswerTooOld, relayTooOld, type RelayTooOld } from './version.js';

/** First reconnect delay; it doubles per failed attempt up to `RECONNECT_MAX_MS` — the Mac's `RelayClient` shape. */
export const RECONNECT_DELAY_MS = 3_000;
export const RECONNECT_MAX_MS = 30_000;
/** A socket stuck between open and `ok` is worse than no socket. */
export const CONNECT_TIMEOUT_MS = 15_000;

/** What the link needs of a WebSocket: the browser's surface, which `ws` offers too. */
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

/** The relay's control messages a caller hears as they came, `challenge` (the link's own) and `error` aside. */
export type RelayControl = Exclude<RelayToDevice, { type: 'challenge' | 'error' }>;

export type RelayLinkEvent =
  | { type: 'status'; status: LinkStatus }
  | RelayControl
  | { type: 'relay_error'; code: string }
  /**
   * The relay is below `MIN_RELAY_VERSION` (at connect, or in a `post`'s
   * answer): the link has stopped, and only `recheck` or `start` tries that
   * relay again.
   */
  | ({ type: 'relay_too_old' } & RelayTooOld)
  /** A frame from `peer` (a device id) with a body; the caller decides whether it knows that peer. */
  | { type: 'frame'; peer: string; body: Uint8Array; flags: number }
  /** A frame with an empty body: its header flags, and nothing else (parent § 7). */
  | { type: 'wake'; peer: string; flags: number };

export type RelayLinkOptions = {
  relayUrl: string;
  identity: Identity;
  WebSocketImpl: SocketConstructor;
  /**
   * The relay's shared secret (`relaySecret` from the QR). Sent in `auth`
   * and with every signed request; absent for an open relay. A relay that
   * refuses it ends the link: `relay_error` `bad_secret`, then `stop()`.
   */
  relaySecret?: string;
  /**
   * The device id the socket URL names (`relayWsUrl`): the pair's anchor a
   * load balancer hashes on. Absent: this device's own id.
   */
  anchor?: string;
  /**
   * True when this device believes it holds a pair with `anchor`: the relay
   * then answers `unpaired` on connect if it does not, which is the only way
   * a device revoked while it was away ever learns it. Off while pairing,
   * when no pair exists yet; the link turns it on itself once it hears
   * `paired` from the anchor.
   */
  expectPaired?: boolean;
  now?: () => number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  reconnectDelayMs?: number;
  connectTimeoutMs?: number;
};

export type RelayPostResult<T> = { status: number; body: T; relayTooOld?: RelayTooOld };

type Timer = ReturnType<typeof setTimeout>;

export class RelayLink {
  status: LinkStatus = 'off';
  /** Paired devices the relay says are online: from `ok`, kept by `presence`; empty while the socket is down. */
  readonly peersOnline = new Set<string>();
  /**
   * Every device the relay holds a pair with, online or not: from `ok`, kept
   * by `paired`, `linked` and `unpaired`. Null until an `ok` named them,
   * and from a relay that does not. Kept across a dropped socket.
   */
  pairs: ReadonlySet<string> | null = null;
  /** Controls and frames dropped as unreadable since construction. */
  dropped = 0;
  private ws: SocketLike | null = null;
  private stopped = true;
  /** Stopped because the relay is too old (`relay_too_old`); `recheck` may knock again, since a relay gets updated. */
  private relayRefused = false;
  private attempt = 0;
  private reconnectTimer: Timer | null = null;
  private connectTimer: Timer | null = null;
  private token: string | null = null;
  /** Starts as `opts.expectPaired`; turns true on `paired` from the anchor, so every later connect asks the relay to confirm the pair. */
  private expectPaired: boolean;
  private readonly anchor: string;
  private readonly listeners = new Set<(event: RelayLinkEvent) => void>();
  private readonly opts: RelayLinkOptions;

  constructor(opts: RelayLinkOptions) {
    this.opts = opts;
    this.anchor = opts.anchor ?? deviceId(opts.identity.publicKey);
    this.expectPaired = opts.expectPaired === true;
  }

  get id(): string {
    return deviceId(this.opts.identity.publicKey);
  }

  on(listener: (event: RelayLinkEvent) => void): () => void {
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
   * the foreground): a fresh relay link now, settled once the relay said
   * `ok` (`peersOnline` is then fresh), or when `windowMs` runs out first.
   */
  recheck(windowMs: number): Promise<void> {
    if (this.stopped && !this.relayRefused) return Promise.resolve();
    // A relay refused as too old may have been updated since: this is the one way back to it.
    this.stopped = false;
    this.relayRefused = false;
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        off();
        resolve();
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

  /** The socket looks open but a channel on it heard nothing: drop it and connect again, with the usual backoff. */
  reconnect(): void {
    this.lose(this.ws);
  }

  /** One frame to a peer; dropped while the socket is down. */
  send(peerKey: Uint8Array, body: Uint8Array): void {
    // A copy typed as an `ArrayBuffer`, which both the browser and `ws` send as one binary frame.
    const frame = encodeFrame({ peer: peerKey, flags: 0, wake: ZERO_WAKE, body }).slice().buffer;
    try {
      this.ws?.send(frame);
    } catch {
      /* a closing socket; its `close` rebuilds the link */
    }
  }

  /** Kept and sent on every `ok` and again after `paired`: the relay drops a token from a device it has no row for (parent § 7). */
  pushToken(token: string): void {
    this.token = token;
    this.sendPushToken();
  }

  /**
   * A signed request to the relay. Never rejects: an unreachable relay
   * answers status 0, as the Mac's `RelayClient.post` does.
   *
   * `relayTooOld` is set when the answer came from a relay below
   * `MIN_RELAY_VERSION`: the link has then emitted `relay_too_old` and
   * stopped.
   */
  async post<T = unknown>(path: string, action: RelayAction, payload: unknown): Promise<RelayPostResult<T>> {
    const fetchImpl = this.opts.fetchImpl ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));
    const now = this.opts.now ?? Date.now;
    try {
      const res = await fetchImpl(new URL(path, this.opts.relayUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signRequest(this.opts.identity, action, payload, now(), this.opts.relaySecret)),
      });
      const text = await res.text();
      let body: T;
      try {
        body = JSON.parse(text) as T;
      } catch {
        body = { error: text } as T;
      }
      const tooOld = relayAnswerTooOld(res.headers.get(RELAY_VERSION_HEADER), res.ok);
      if (tooOld) {
        this.refuseRelay(tooOld);
        return { status: res.status, body, relayTooOld: tooOld };
      }
      return { status: res.status, body };
    } catch {
      return { status: 0, body: { error: 'network' } as T };
    }
  }

  /** As `bad_secret`: the relay will not update itself while we knock, so the link stops instead of looping. */
  private refuseRelay(tooOld: RelayTooOld): void {
    this.emit({ type: 'relay_too_old', ...tooOld });
    this.stop();
    this.relayRefused = true;
  }

  private connect(): void {
    this.setStatus('connecting');
    let ws: SocketLike;
    try {
      ws = new this.opts.WebSocketImpl(relayWsUrl(this.opts.relayUrl, this.anchor, { paired: this.expectPaired }));
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

  /**
   * Forgets one socket and everything tied to it; schedules the next attempt
   * unless told not to or stopped. Whoever runs channels over the link
   * hears of it as the status leaving `online`.
   */
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
    this.peersOnline.clear();
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
        this.peersOnline.clear();
        for (const peer of msg.peers) this.peersOnline.add(peer);
        if (msg.pairs) this.pairs = new Set(msg.pairs);
        // Heard before the status turns `online`, so whoever waits for
        // `online` (a recheck) finds `peersOnline` and the caller's own
        // state already as `ok` said; the push token goes out before either.
        this.emit(msg);
        this.status = 'online';
        this.sendPushToken();
        this.emit({ type: 'status', status: 'online' });
        return;
      case 'presence':
        if (msg.online) this.peersOnline.add(msg.peer);
        else this.peersOnline.delete(msg.peer);
        this.emit(msg);
        return;
      case 'paired':
        // A pair exists from here on: a revoke while this link is away must reach it on its next connect.
        if (msg.mac === this.anchor) this.expectPaired = true;
        this.addPair(msg.mac);
        this.sendPushToken();
        this.emit(msg);
        return;
      case 'linked':
        this.addPair(msg.peer);
        this.emit(msg);
        return;
      case 'unpaired':
        if (this.pairs?.has(msg.mac)) this.pairs = new Set([...this.pairs].filter((id) => id !== msg.mac));
        this.emit(msg);
        return;
      case 'error':
        this.emit({ type: 'relay_error', code: msg.code });
        return;
      case 'rejected':
      case 'pair_request':
        this.emit(msg);
        return;
    }
  }

  private addPair(id: string): void {
    if (this.pairs && !this.pairs.has(id)) this.pairs = new Set([...this.pairs, id]);
  }

  private onBinary(data: unknown): void {
    const bytes = toBytes(data);
    const frame = bytes ? decodeFrame(bytes) : null;
    if (!frame) {
      this.dropped++;
      return;
    }
    const peer = deviceId(frame.peer);
    if (frame.body.length === 0) this.emit({ type: 'wake', peer, flags: frame.flags });
    else this.emit({ type: 'frame', peer, body: frame.body, flags: frame.flags });
  }

  private sendControl(ws: SocketLike, msg: DeviceToRelay): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* as in `send` */
    }
  }

  private sendPushToken(): void {
    // An empty token is a token too: "stop pushing to this phone" (a phone pairing a different Mac).
    if (this.token !== null && this.ws && this.status === 'online') this.sendControl(this.ws, { type: 'push_token', token: this.token });
  }

  private emit(event: RelayLinkEvent): void {
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
