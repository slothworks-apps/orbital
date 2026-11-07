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

/**
 * The longest a screenshot waits for its outcome, counted from the frame's
 * arrival: reading and shrinking it comes first, and `OUTCOME_TIMEOUT_MS`
 * after it is published, but never past this. The extension waits longer
 * than this for a screenshot's outcome. A shrink that runs past it answers
 * `unreadable`, and the screenshot is not published.
 */
export const SCREENSHOT_OUTCOME_MAX_MS = 8_000;

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
  timeouts?: { firstFrameMs?: number; outcomeMs?: number; screenshotOutcomeMs?: number; captureMs?: number };
  /** Fits a screenshot under `maxImageBytes`; tests hand in a slow one. */
  fit?: typeof fitScreenshot;
}

interface Connection {
  socket: BridgeSocket;
  pairingId: string;
  /** When it connected or last sent an event: the latest answers the agent's capture. */
  activeAt: number;
}

/** An event that has not been told its outcome yet: who sent it, and the timers that answer for silence. */
interface PendingOutcome {
  connection: Connection;
  timers: ReturnType<typeof setTimeout>[];
  /** Marks it published, arming the wait for a window's answer. */
  publish: () => void;
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
  /** eventId → who sent it and the timers that answer for it when no window does. */
  private readonly outcomes = new Map<string, PendingOutcome>();
  private readonly captures = new Map<string, PendingCapture>();
  private readonly now: () => number;
  private readonly firstFrameMs: number;
  private readonly outcomeMs: number;
  private readonly screenshotOutcomeMs: number;
  private readonly captureMs: number;
  private readonly fit: typeof fitScreenshot;

  constructor(private readonly opts: BrowserBridgeOptions) {
    this.now = opts.now ?? Date.now;
    this.pairings = new BrowserPairings(opts.dataDir, this.now);
    this.firstFrameMs = opts.timeouts?.firstFrameMs ?? FIRST_FRAME_TIMEOUT_MS;
    this.outcomeMs = opts.timeouts?.outcomeMs ?? OUTCOME_TIMEOUT_MS;
    this.screenshotOutcomeMs = opts.timeouts?.screenshotOutcomeMs ?? SCREENSHOT_OUTCOME_MAX_MS;
    this.captureMs = opts.timeouts?.captureMs ?? CAPTURE_TIMEOUT_MS;
    this.fit = opts.fit ?? fitScreenshot;
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
      codeExpiresAt: this.pairings.codeExpiresAt(),
    };
  }

  /** A pairing code for Settings, or null while the switch is off. */
  newPairingCode(): { code: string; expiresAt: number } | null {
    if (!this.enabled()) return null;
    const code = this.pairings.newCode();
    this.publishStatus();
    return code;
  }

  /** Settings' Cancel: the code stops pairing at once, not when it lapses. */
  cancelPairingCode(): void {
    this.pairings.clearCode();
    this.publishStatus();
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
    this.settle(o.eventId, pending);
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
          const codeWasOpen = this.pairings.codeExpiresAt() !== null;
          const result = this.pairings.pair(
            typeof frame.code === 'string' ? frame.code : '',
            typeof frame.browser === 'string' ? frame.browser : '',
          );
          if ('failure' in result) {
            // Left open for another try, on the same first-frame deadline.
            send(socket, { type: 'pair_failed', reason: PAIR_FAILURE_TEXT[result.failure] });
            armFirstFrame();
            // The last wrong try ends the code: Settings stops showing it as open.
            if (codeWasOpen && this.pairings.codeExpiresAt() === null) this.publishStatus();
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
        if (pending.connection === connection) this.settle(eventId, pending);
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
    for (const [eventId, pending] of this.outcomes) this.settle(eventId, pending);
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
        const pending = this.expect(connection, eventId);
        if (!pending) return;
        this.publishEvent(pending, {
          type: 'browser_selection', eventId, text,
          url: str(frame.url, URL_MAX_CHARS) ?? '', title: str(frame.title, TITLE_MAX_CHARS) ?? '', at: this.now(),
        });
        return;
      }
      case 'screenshot': {
        const eventId = str(frame.eventId, 200);
        if (!eventId) return;
        connection.activeAt = this.now();
        // The wait starts now, not once the shrink is done: the extension's
        // own wait started when it sent the frame.
        const pending = this.expect(connection, eventId, this.screenshotOutcomeMs);
        if (!pending) return;
        const decoded = decodeDataUrl(frame.dataUrl);
        const shot = decoded && await this.fit(decoded, { maxBytes: this.opts.maxImageBytes });
        // Answered while it shrank: past the cap, resent, or the socket left.
        if (this.outcomes.get(eventId) !== pending) return;
        const entry = shot && this.opts.images.putBytes(shot.mediaType, shot.bytes);
        if (!entry) {
          this.settle(eventId, pending);
          this.dropped(connection, eventId, 'unreadable');
          return;
        }
        this.publishEvent(pending, {
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

  /**
   * An event just arrived: from now on it waits for its outcome. A selection
   * is published at once and waits `outcomeMs`; a screenshot is read and
   * shrunk first, and `capMs` bounds the whole wait, the shrink included —
   * running out before it is published answers `unreadable`. Null when no
   * window listens: answered `no-window` at once.
   */
  private expect(connection: Connection, eventId: string, capMs?: number): PendingOutcome | null {
    if (!this.opts.windowsListening()) {
      this.dropped(connection, eventId, 'no-window');
      return null;
    }
    // An extension resending an id gets one answer, for the latest.
    const earlier = this.outcomes.get(eventId);
    if (earlier) this.settle(eventId, earlier);
    let published = false;
    const silence = (ms: number) => setTimeout(() => {
      if (this.outcomes.get(eventId) !== pending) return;
      this.settle(eventId, pending);
      this.dropped(connection, eventId, published ? 'no-window' : 'unreadable');
    }, ms);
    const pending: PendingOutcome = {
      connection,
      timers: [],
      publish: () => {
        published = true;
        // The cap's timer stays: whichever runs out first answers.
        if (capMs !== undefined) pending.timers.push(silence(this.outcomeMs));
      },
    };
    pending.timers.push(silence(capMs ?? this.outcomeMs));
    this.outcomes.set(eventId, pending);
    return pending;
  }

  /** Publishes an event already waiting for its outcome; the windows decide it from here. */
  private publishEvent(pending: PendingOutcome, event: Exclude<BrowserHubEvent, { type: 'browser_status' }>): void {
    pending.publish();
    this.opts.publish(BROWSER_TOPIC, event);
  }

  /** The event is answered or forgotten: its timers stop. */
  private settle(eventId: string, pending: PendingOutcome): void {
    for (const timer of pending.timers) clearTimeout(timer);
    if (this.outcomes.get(eventId) === pending) this.outcomes.delete(eventId);
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
