import { randomUUID } from 'node:crypto';
import type { ImageStore } from '../images/store.js';
import { BrowserPairings, type PairFailure } from './pairings.js';
import { decodeDataUrl, fitScreenshot, type ScreenshotBytes } from './image.js';
import {
  BROWSER_CLOSE,
  BROWSER_TOPIC,
  type BrowserDropReason,
  type BrowserHubEvent,
  type BrowserOutcome,
  type BrowserStatus,
  type ServerFrame,
} from './protocol.js';

/**
 * The server's half of the browser bridge (spec
 * 2026-11-05-browser-bridge-design): the extension's sockets on
 * `/ws/browser`, the events they send, the outcome each one gets, and the
 * agent's screenshots.
 *
 * An event is published on the `browser` topic and forgotten; what is kept
 * is only who to tell its outcome, until it is told.
 */

/** How long a new socket has to send `pair` or `hello`. */
export const FIRST_FRAME_TIMEOUT_MS = 5_000;

/** How long an event waits for a window to say what became of it; silence reads as no window. */
export const OUTCOME_TIMEOUT_MS = 3_000;

/** How long `browser_screenshot` waits for the extension's capture. */
export const CAPTURE_TIMEOUT_MS = 10_000;

/** The longest selection passed on; the composer cuts it shorter still. */
const SELECTION_MAX_CHARS = 200_000;
const TITLE_MAX_CHARS = 1_000;
const URL_MAX_CHARS = 8_000;

/** The close code for a frame that breaks the protocol (RFC 6455 policy violation). */
const CLOSE_PROTOCOL = 1008;

/** The socket as `ws` gives it; tests hand in a fake. */
export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(ev: string, cb: (...args: any[]) => void): void;
}

/** What the agent's capture came back with. */
export type CaptureResult =
  | { ok: true; shot: ScreenshotBytes; url: string; title: string }
  | { ok: false; reason: 'no-extension' | 'timeout' | 'failed' | 'disabled'; detail?: string };

export interface BrowserBridgeOptions {
  dataDir: string;
  publish: (topic: string, payload: Record<string, unknown>) => void;
  /** Whether any Orbital window is listening on `browser`; none, and an event is dropped at once. */
  windowsListening: () => boolean;
  images: Pick<ImageStore, 'putBytes'>;
  isEnabled: () => boolean;
  /** A session's title, for an outcome that names where an event went. */
  titleOf: (sessionId: string) => string | null;
  /** The ceiling a stored screenshot fits under: the composer attachment's. */
  maxImageBytes: number;
  /** The port Orbital listens on, for Settings' status line. */
  port: number;
  now?: () => number;
  timeouts?: { firstFrameMs?: number; outcomeMs?: number; captureMs?: number };
}

interface Connection {
  socket: BridgeSocket;
  pairingId: string;
  /** When it connected or last sent an event: the latest answers the agent's capture. */
  activeAt: number;
}

interface PendingCapture {
  connection: Connection;
  resolve: (result: CaptureResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PAIR_FAILURE_TEXT: Record<PairFailure, string> = {
  'no-code': 'No pairing code is open. Show one in Orbital\'s Settings first.',
  expired: 'The pairing code expired. Show a new one in Orbital\'s Settings.',
  'wrong-code': 'That is not the code Orbital shows.',
};

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

export class BrowserBridge {
  readonly pairings: BrowserPairings;
  private readonly connections = new Set<Connection>();
  /** eventId → who sent it and the timer that answers "no window" for it. */
  private readonly outcomes = new Map<string, { connection: Connection; timer: ReturnType<typeof setTimeout> }>();
  private readonly captures = new Map<string, PendingCapture>();
  private readonly now: () => number;
  private readonly firstFrameMs: number;
  private readonly outcomeMs: number;
  private readonly captureMs: number;

  constructor(private readonly opts: BrowserBridgeOptions) {
    this.now = opts.now ?? Date.now;
    this.pairings = new BrowserPairings(opts.dataDir, this.now);
    this.firstFrameMs = opts.timeouts?.firstFrameMs ?? FIRST_FRAME_TIMEOUT_MS;
    this.outcomeMs = opts.timeouts?.outcomeMs ?? OUTCOME_TIMEOUT_MS;
    this.captureMs = opts.timeouts?.captureMs ?? CAPTURE_TIMEOUT_MS;
  }

  enabled(): boolean {
    return this.opts.isEnabled();
  }

  status(): BrowserStatus {
    const live = new Set([...this.connections].map((c) => c.pairingId));
    return {
      enabled: this.enabled(),
      port: this.opts.port,
      pairings: this.pairings.list().map((p) => ({
        id: p.id, browser: p.browser, pairedAt: p.pairedAt, connected: live.has(p.id), lastSeenAt: p.lastSeenAt ?? null,
      })),
    };
  }

  /** A pairing code for Settings, or null while the switch is off. */
  newPairingCode(): { code: string; expiresAt: number } | null {
    if (!this.enabled()) return null;
    return this.pairings.newCode();
  }

  /** Unpair: the token stops opening the socket, and a socket open on it now closes. */
  revoke(id: string): boolean {
    if (!this.pairings.revoke(id)) return false;
    for (const c of [...this.connections]) {
      if (c.pairingId === id) c.socket.close(BROWSER_CLOSE.unauthorized, 'unpaired');
    }
    this.publishStatus();
    return true;
  }

  /** The switch may have moved: off closes every socket and the open code. */
  settingsChanged(): void {
    if (!this.enabled()) {
      this.pairings.clearCode();
      for (const c of [...this.connections]) c.socket.close(BROWSER_CLOSE.disabled, 'turned off');
    }
    this.publishStatus();
  }

  /** What the window that acted on an event says became of it; passed to the extension that sent it. */
  outcome(o: BrowserOutcome): void {
    const pending = this.outcomes.get(o.eventId);
    if (!pending) return; // answered already, or timed out
    this.outcomes.delete(o.eventId);
    clearTimeout(pending.timer);
    const title = o.delivered && o.sessionId ? this.opts.titleOf(o.sessionId) : null;
    send(pending.connection.socket, {
      type: 'outcome',
      eventId: o.eventId,
      delivered: o.delivered,
      ...(title ? { sessionTitle: title } : {}),
      ...(!o.delivered && o.reason ? { reason: o.reason } : {}),
    });
  }

  /**
   * The agent's `browser_screenshot`: the extension that sent the latest
   * event, else the one that connected last, captures its active tab.
   */
  capture(): Promise<CaptureResult> {
    if (!this.enabled()) return Promise.resolve({ ok: false, reason: 'disabled' });
    let latest: Connection | null = null;
    for (const c of this.connections) if (!latest || c.activeAt >= latest.activeAt) latest = c;
    if (!latest) return Promise.resolve({ ok: false, reason: 'no-extension' });
    const connection = latest;
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.captures.delete(requestId);
        resolve({ ok: false, reason: 'timeout' });
      }, this.captureMs);
      this.captures.set(requestId, { connection, resolve, timer });
      send(connection.socket, { type: 'capture', requestId });
    });
  }

  /** One socket on `/ws/browser`, from its open to its close. */
  handleSocket(socket: BridgeSocket): void {
    if (!this.enabled()) {
      socket.close(BROWSER_CLOSE.disabled, 'turned off');
      return;
    }
    let connection: Connection | null = null;
    let firstFrame: ReturnType<typeof setTimeout> | null = null;
    const armFirstFrame = () => {
      if (firstFrame) clearTimeout(firstFrame);
      firstFrame = setTimeout(() => socket.close(CLOSE_PROTOCOL, 'no pair or hello'), this.firstFrameMs);
    };
    armFirstFrame();
    const authenticate = (pairingId: string) => {
      if (firstFrame) clearTimeout(firstFrame);
      firstFrame = null;
      connection = { socket, pairingId, activeAt: this.now() };
      this.connections.add(connection);
      this.pairings.seen(pairingId);
      this.publishStatus();
    };

    socket.on('message', (raw: unknown) => {
      let frame: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(String(raw));
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        frame = parsed as Record<string, unknown>;
      } catch {
        socket.close(CLOSE_PROTOCOL, 'malformed frame');
        return;
      }
      if (!connection) {
        if (frame.type === 'hello') {
          const pairing = this.pairings.byToken(typeof frame.token === 'string' ? frame.token : '');
          if (!pairing) {
            socket.close(BROWSER_CLOSE.unauthorized, 'unknown token');
            return;
          }
          authenticate(pairing.id);
          send(socket, { type: 'welcome' });
        } else if (frame.type === 'pair') {
          const result = this.pairings.pair(
            typeof frame.code === 'string' ? frame.code : '',
            typeof frame.browser === 'string' ? frame.browser : '',
          );
          if ('failure' in result) {
            // Left open for another try, on the same first-frame deadline.
            send(socket, { type: 'pair_failed', reason: PAIR_FAILURE_TEXT[result.failure] });
            armFirstFrame();
            return;
          }
          authenticate(result.pairing.id);
          // `paired` is the welcome of a socket that paired.
          send(socket, { type: 'paired', token: result.token });
        } else {
          socket.close(CLOSE_PROTOCOL, 'pair or hello first');
        }
        return;
      }
      void this.onFrame(connection, frame);
    });

    socket.on('close', () => {
      if (firstFrame) clearTimeout(firstFrame);
      if (!connection) return;
      this.connections.delete(connection);
      this.pairings.seen(connection.pairingId);
      for (const [eventId, pending] of this.outcomes) {
        if (pending.connection !== connection) continue;
        clearTimeout(pending.timer);
        this.outcomes.delete(eventId);
      }
      for (const [requestId, pending] of this.captures) {
        if (pending.connection !== connection) continue;
        clearTimeout(pending.timer);
        this.captures.delete(requestId);
        pending.resolve({ ok: false, reason: 'failed', detail: 'The browser disconnected.' });
      }
      this.publishStatus();
    });
  }

  /** Clears every timer; the sockets close with the server. */
  dispose(): void {
    for (const pending of this.outcomes.values()) clearTimeout(pending.timer);
    this.outcomes.clear();
    for (const pending of this.captures.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: 'failed', detail: 'Orbital is shutting down.' });
    }
    this.captures.clear();
  }

  private async onFrame(connection: Connection, frame: Record<string, unknown>): Promise<void> {
    switch (frame.type) {
      case 'ping':
        send(connection.socket, { type: 'pong' });
        return;
      case 'selection': {
        const eventId = str(frame.eventId, 200);
        const text = str(frame.text, SELECTION_MAX_CHARS);
        if (!eventId || !text) return;
        connection.activeAt = this.now();
        this.event(connection, {
          type: 'browser_selection', eventId, text,
          url: str(frame.url, URL_MAX_CHARS) ?? '', title: str(frame.title, TITLE_MAX_CHARS) ?? '', at: this.now(),
        });
        return;
      }
      case 'screenshot': {
        const eventId = str(frame.eventId, 200);
        if (!eventId) return;
        connection.activeAt = this.now();
        const decoded = decodeDataUrl(frame.dataUrl);
        const shot = decoded && await fitScreenshot(decoded, { maxBytes: this.opts.maxImageBytes });
        const entry = shot && this.opts.images.putBytes(shot.mediaType, shot.bytes);
        if (!entry) {
          send(connection.socket, { type: 'outcome', eventId, delivered: false });
          return;
        }
        this.event(connection, {
          type: 'browser_screenshot', eventId, ref: entry.ref,
          url: str(frame.url, URL_MAX_CHARS) ?? '', title: str(frame.title, TITLE_MAX_CHARS) ?? '', at: this.now(),
          ...(entry.w && entry.h ? { w: entry.w, h: entry.h } : {}),
          bytes: entry.bytes,
        });
        return;
      }
      case 'captured':
      case 'capture_failed': {
        const requestId = str(frame.requestId, 200);
        const pending = requestId ? this.captures.get(requestId) : undefined;
        // Only the extension that was asked answers its request.
        if (!pending || pending.connection !== connection) return;
        this.captures.delete(requestId!);
        clearTimeout(pending.timer);
        if (frame.type === 'capture_failed') {
          pending.resolve({ ok: false, reason: 'failed', detail: str(frame.reason, 500) ?? undefined });
          return;
        }
        const shot = decodeDataUrl(frame.dataUrl);
        pending.resolve(shot
          ? { ok: true, shot, url: str(frame.url, URL_MAX_CHARS) ?? '', title: str(frame.title, TITLE_MAX_CHARS) ?? '' }
          : { ok: false, reason: 'failed', detail: 'The browser sent no image.' });
        return;
      }
      default:
        // `pair` or `hello` again, or a frame from a newer extension: nothing to do.
        return;
    }
  }

  /** Publishes an event and waits for the outcome a window gives it. */
  private event(connection: Connection, event: Exclude<BrowserHubEvent, { type: 'browser_status' }>): void {
    if (!this.opts.windowsListening()) {
      this.dropped(connection, event.eventId, 'no-window');
      return;
    }
    const timer = setTimeout(() => {
      this.outcomes.delete(event.eventId);
      this.dropped(connection, event.eventId, 'no-window');
    }, this.outcomeMs);
    // An extension resending an id gets one answer, for the latest.
    const earlier = this.outcomes.get(event.eventId);
    if (earlier) clearTimeout(earlier.timer);
    this.outcomes.set(event.eventId, { connection, timer });
    this.opts.publish(BROWSER_TOPIC, event);
  }

  private dropped(connection: Connection, eventId: string, reason: BrowserDropReason): void {
    send(connection.socket, { type: 'outcome', eventId, delivered: false, reason });
  }

  private publishStatus(): void {
    this.opts.publish(BROWSER_TOPIC, { type: 'browser_status', status: this.status() } satisfies BrowserHubEvent);
  }
}

function send(socket: BridgeSocket, frame: ServerFrame): void {
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    /* closing; its close handler cleans up */
  }
}
