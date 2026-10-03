/**
 * The Mac's one outbound connection to the relay: challenge → signed auth →
 * frames, and back again after every drop with a growing delay. Mirrors what
 * `web/src/lib/ws.ts` does towards this server (spec
 * 2026-09-22-ws-reconnect-resync-design), minus topics — the relay has none.
 * The Mac never listens; this socket is the only way in (spec
 * 2026-09-30-mobile-remote-design § 3).
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { deviceId, type Identity } from '@orbital/shared/remote/keys';
import {
  CLOSE_BAD_SECRET, RelayToDevice, authSignature, relayWsUrl, signRequest, RELAY_PING_INTERVAL_MS,
  type DeviceToRelay, type RelayAction,
} from '@orbital/shared/remote/relayApi';

export const RECONNECT_DELAY_MS = 3_000;
export const RECONNECT_MAX_MS = 30_000;
/** A socket stuck between open and `ok` is worse than no socket; give up and retry. */
export const CONNECT_TIMEOUT_MS = 15_000;
/** The relay pings every `RELAY_PING_INTERVAL_MS`; three missed pings means it's gone, not just slow. */
export const RELAY_SILENCE_TIMEOUT_MS = RELAY_PING_INTERVAL_MS * 3;

export type RelayStatus = 'off' | 'connecting' | 'online';

export type RelayClientOptions = {
  relayUrl: string;
  identity: Identity;
  /** The relay's shared secret; sent with the auth and every signed request when non-empty. */
  relaySecret?: string;
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  reconnectDelayMs?: number;
  connectTimeoutMs?: number;
  silenceTimeoutMs?: number;
};

export class RelayClient extends EventEmitter {
  status: RelayStatus = 'off';
  readonly peersOnline = new Set<string>();
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly fetchImpl: typeof fetch;
  private readonly baseDelay: number;
  private readonly connectTimeoutMs: number;
  private readonly silenceTimeoutMs: number;

  constructor(private readonly opts: RelayClientOptions) {
    super();
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseDelay = opts.reconnectDelayMs ?? RECONNECT_DELAY_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.silenceTimeoutMs = opts.silenceTimeoutMs ?? RELAY_SILENCE_TIMEOUT_MS;
  }

  get id(): string {
    return deviceId(this.opts.identity.publicKey);
  }

  /** Consecutive failed connection attempts; the relay's `ok` resets it. */
  get attempts(): number {
    return this.attempt;
  }

  start(): void {
    if (this.status !== 'off') return;
    this.connect();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.clearWatchdogs();
    const ws = this.ws;
    this.ws = null;
    this.setStatus('off');
    ws?.close();
  }

  sendData(frame: Uint8Array): boolean {
    if (this.status !== 'online' || !this.ws) return false;
    try {
      this.ws.send(frame, { binary: true });
      return true;
    } catch {
      return false;
    }
  }

  sendControl(msg: DeviceToRelay): boolean {
    if (this.status !== 'online' || !this.ws) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Never rejects: a relay that cannot be reached answers status 0 with
   * `{ error: 'network' }`, so callers (route handlers among them) branch on
   * the status alone.
   */
  async post<T>(path: string, action: RelayAction, payload: unknown): Promise<{ status: number; body: T }> {
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(new URL(path, this.opts.relayUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signRequest(this.opts.identity, action, payload, Date.now(), this.opts.relaySecret)),
      });
      text = await res.text();
    } catch {
      return { status: 0, body: { error: 'network' } as T };
    }
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = { error: text } as T;
    }
    return { status: res.status, body };
  }

  private connect(): void {
    this.setStatus('connecting');
    const ws = new this.WebSocketImpl(relayWsUrl(this.opts.relayUrl, this.id));
    this.ws = ws;
    // A socket that never reaches `ok` is as useless as no socket; give up
    // on it rather than wait forever for a challenge that isn't coming.
    this.connectTimer = setTimeout(() => ws.terminate(), this.connectTimeoutMs);
    ws.on('message', (raw, isBinary) => {
      if (this.ws !== ws) return;
      // Any traffic — data or control — proves the relay is still there;
      // only reset the silence watchdog once it's armed (i.e. past `ok`).
      if (this.silenceTimer) this.armSilenceTimer(ws);
      if (isBinary) {
        const buf = raw as Buffer;
        this.emit('data', new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        return;
      }
      let msg: RelayToDevice;
      try {
        msg = RelayToDevice.parse(JSON.parse((raw as Buffer).toString('utf8')));
      } catch {
        return;
      }
      // State first, then listeners: a `control` listener that reads
      // `peersOnline` or `status` sees what the message just said, not the
      // state before it. Every parsed message reaches them, challenge and ok
      // included — callers that want to observe the handshake need them too.
      if (msg.type === 'challenge') {
        const auth: DeviceToRelay = { type: 'auth', pub: this.id, sig: authSignature(this.opts.identity, msg.nonce) };
        if (this.opts.relaySecret) auth.secret = this.opts.relaySecret;
        ws.send(JSON.stringify(auth));
      }
      if (msg.type === 'ok') {
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.attempt = 0;
        this.peersOnline.clear();
        for (const p of msg.peers) this.peersOnline.add(p);
        this.setStatus('online');
        this.armSilenceTimer(ws);
      }
      if (msg.type === 'presence') {
        if (msg.online) this.peersOnline.add(msg.peer);
        else this.peersOnline.delete(msg.peer);
      }
      this.emit('control', msg);
    });
    // The relay's keepalive; a ping is activity too, same as a message.
    ws.on('ping', () => {
      if (this.ws !== ws) return;
      if (this.silenceTimer) this.armSilenceTimer(ws);
    });
    ws.on('error', () => { /* close follows; that is where we react */ });
    ws.on('close', (code) => {
      // A stale `ws` (stop(), or already replaced) owns no live timers of
      // ours to clear — those belong to whatever connection is current.
      if (this.ws !== ws) return;
      this.clearWatchdogs();
      this.ws = null;
      this.peersOnline.clear();
      if (this.status === 'off') return;
      // The secret will not change on its own; retrying would only knock
      // again with the same one. Stopped first, so a `refused` listener
      // reads `off`.
      if (code === CLOSE_BAD_SECRET) {
        this.setStatus('off');
        this.emit('refused', 'bad_secret');
        return;
      }
      const delay = Math.min(this.baseDelay * 2 ** this.attempt++, RECONNECT_MAX_MS);
      // Forced: a repeated failure leaves the status `connecting`, but
      // `attempts` changed and listeners must hear about it.
      this.setStatus('connecting', true);
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }

  private armSilenceTimer(ws: WebSocket): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => ws.terminate(), this.silenceTimeoutMs);
  }

  private clearWatchdogs(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  private setStatus(status: RelayStatus, force = false): void {
    if (this.status === status && !force) return;
    this.status = status;
    this.emit('status', status);
  }
}
