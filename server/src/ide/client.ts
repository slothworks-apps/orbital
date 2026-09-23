import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  IDE_AUTH_HEADER,
  IDE_SUBPROTOCOL,
  MCP_PROTOCOL_VERSION,
  SELECTION_NOTIFICATION,
  type IdeLock,
} from './protocol.js';

/**
 * One MCP connection to one editor window (spec
 * 2026-09-23-ide-bridge-design § The protocol, in four facts).
 *
 * `ws` rather than the platform `WebSocket` because the handshake needs a
 * custom header, which the platform client cannot send.
 *
 * Every failure here is silence. A refused upgrade, a token the extension no
 * longer honours, an editor that quits mid-call — each ends as `closed`, and
 * `IdeStore` drops the entry. Nothing on this path can throw into a session.
 */

/** How long the upgrade may take before the attempt is abandoned. */
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** How long any one request waits before it is answered with nothing. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * What a call may be given instead of a deadline. Exactly one tool needs it —
 * `openDiff` does not answer until a human acts on the tab, and any deadline
 * at all would turn "still reading it" into a lost verdict. The caller that
 * passes it owns the cancellation instead, through `signal`.
 */
export const NO_TIMEOUT = null;

/** Per-call overrides. Both exist for `openDiff` and nothing else needs them. */
export interface CallOptions {
  /** `NO_TIMEOUT` waits indefinitely; absent means `REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number | null;
  /** Abandons the wait, and tells the editor so. Answers null. */
  signal?: AbortSignal;
}

/** What Orbital calls itself in `initialize`, so the editor's log names it. */
const CLIENT_NAME = 'orbital';
const CLIENT_VERSION = '1';

/**
 * The half of a connection `IdeStore` uses. An interface rather than the
 * class so the store's tests can drive one without an editor — the socket is
 * the only part of this feature a test cannot own.
 */
export interface IdeConnection extends EventEmitter {
  /** Whether the extension listed this tool. Never assumed (adr). */
  hasTool(name: string): boolean;
  /**
   * The tool's text content, or null for every kind of "no" there is: the
   * tool was not listed, the call errored, the socket went away, or nothing
   * answered in time.
   */
  callTool(name: string, args?: Record<string, unknown>): Promise<string | null>;
  /**
   * The same call, answering with the result's raw `content` array rather
   * than its text joined together. `openDiff` needs it: its verdict is the
   * FIRST block and the human's file is the SECOND, a distinction joining
   * destroys.
   */
  callToolContent(
    name: string,
    args?: Record<string, unknown>,
    opts?: CallOptions,
  ): Promise<unknown[] | null>;
  close(): void;
}

interface Pending {
  resolve(message: Record<string, unknown> | null): void;
  /** Absent for a call given `NO_TIMEOUT` — `openDiff`, and only it. */
  timer: NodeJS.Timeout | null;
  /** Detaches the abort listener, so an abandoned wait leaks neither. */
  release: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** One frame as text. `ws` hands over a Buffer, a fragment list, or raw bytes. */
function frameText(raw: WebSocket.RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

/**
 * Concatenated `text` blocks of a `tools/call` result. The one tool wired so
 * far answers with a single text block; joining is what makes a second block
 * ordinary rather than a surprise.
 */
function textOf(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const content = result.content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter(isRecord)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
  return parts.length === 0 ? null : parts.join('\n');
}

export class IdeSocket extends EventEmitter implements IdeConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private tools = new Set<string>();
  private finished = false;

  constructor(lock: IdeLock) {
    super();
    this.ws = new WebSocket(`ws://127.0.0.1:${lock.port}`, [IDE_SUBPROTOCOL], {
      headers: { [IDE_AUTH_HEADER]: lock.authToken },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    this.ws.on('open', () => void this.handshake());
    this.ws.on('message', (raw) => this.receive(frameText(raw)));
    // Both have to be listened for: an unhandled `error` on an EventEmitter
    // is a thrown exception, and this one is raised by every refused port.
    this.ws.on('error', () => this.finish());
    this.ws.on('close', () => this.finish());
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string | null> {
    const result = await this.call(name, args);
    return result === null ? null : textOf(result);
  }

  async callToolContent(
    name: string,
    args: Record<string, unknown> = {},
    opts: CallOptions = {},
  ): Promise<unknown[] | null> {
    const result = await this.call(name, args, opts);
    if (result === null) return null;
    return Array.isArray(result.content) ? result.content : null;
  }

  /** One `tools/call`, or null for every kind of "no" there is. */
  private async call(
    name: string,
    args: Record<string, unknown>,
    opts: CallOptions = {},
  ): Promise<Record<string, unknown> | null> {
    if (!this.hasTool(name)) return null;
    const reply = await this.request('tools/call', { name, arguments: args }, opts);
    const result = reply?.result;
    if (!isRecord(result) || result.isError === true) return null;
    return result;
  }

  close(): void {
    this.finish();
    try {
      this.ws.close();
    } catch {
      // A socket still negotiating its upgrade refuses to be closed politely.
      this.ws.terminate();
    }
  }

  /**
   * `initialize`, then the notification that says it took, then the tool
   * list — after which the connection is worth something and says so.
   */
  private async handshake(): Promise<void> {
    const initialized = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });
    if (!initialized?.result) return this.close();

    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const listed = await this.request('tools/list', {});
    const result = listed?.result;
    const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
    for (const tool of tools) {
      if (isRecord(tool) && typeof tool.name === 'string') this.tools.add(tool.name);
    }
    if (this.finished) return;
    this.emit('ready', [...this.tools]);
  }

  /**
   * One JSON-RPC round trip. Every way out answers — a reply, a deadline, an
   * abort, or the socket going away — because a request that never settles
   * is a promise some caller is still holding.
   *
   * An abandoned request tells the editor so (`notifications/cancelled`),
   * which is what lets it drop a diff tab nobody is waiting on any more. The
   * extension is free to ignore it; `close_tab` is the cleanup that does not
   * depend on it being honoured.
   */
  private request(
    method: string,
    params: Record<string, unknown>,
    opts: CallOptions = {},
  ): Promise<Record<string, unknown> | null> {
    if (this.finished) return Promise.resolve(null);
    const { signal } = opts;
    if (signal?.aborted) return Promise.resolve(null);
    const timeoutMs = opts.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : opts.timeoutMs;
    const id = this.nextId++;
    return new Promise((resolve) => {
      const settle = (message: Record<string, unknown> | null) => {
        const waiting = this.pending.get(id);
        if (!waiting) return;
        this.pending.delete(id);
        waiting.release();
        resolve(message);
      };
      const timer =
        timeoutMs === NO_TIMEOUT
          ? null
          : setTimeout(() => {
              settle(null);
            }, timeoutMs);
      timer?.unref?.();
      const onAbort = () => {
        this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
        settle(null);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve,
        timer,
        release: () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      this.finish();
    }
  }

  /**
   * Answers go to whoever asked; `selection_changed` goes to the store.
   * Everything else — the extension's `ping`, its `notifications/cancelled`,
   * any request it makes of us — is dropped without a word, because a log
   * line per keystroke is its own kind of failure.
   */
  private receive(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    if (typeof message.id === 'number') {
      const waiting = this.pending.get(message.id);
      if (waiting) {
        this.pending.delete(message.id);
        waiting.release();
        waiting.resolve(message);
      }
      return;
    }
    if (message.method === SELECTION_NOTIFICATION) this.emit('selection', message.params);
  }

  /** Once. Every in-flight request answers with nothing rather than hanging. */
  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const waiting of this.pending.values()) {
      waiting.release();
      waiting.resolve(null);
    }
    this.pending.clear();
    this.emit('closed');
  }
}
