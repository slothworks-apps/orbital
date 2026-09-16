import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Hub } from '../api/hub.js';
import type { PermissionMode, SessionStatus, ChatMessage } from '../types.js';
import type { TranscriptEntry } from '../transcript/parser.js';

/**
 * Sentinel for canvas 1h's "Never — only on Clear": no idle timer at all.
 *
 * A word, not a number. Every numeric sentinel collides with a value some
 * preset might legitimately want (`0` reads as "end immediately", `-1` as a
 * bug), whereas `'never'` can never be mistaken for a minute count. It also
 * fails loudly rather than quietly: `Number('never')` is `NaN`, so a call
 * site that forgets to special-case it trips the `NaN` guard in
 * `parseIdleTimeoutMs` instead of reaching `setTimeout(fn, NaN)` — which
 * fires on the next tick and would end every session the instant it started.
 */
export const IDLE_NEVER = 'never';

/** Fallback when the stored value is missing or unusable (minutes). */
const DEFAULT_IDLE_MINUTES = 30;

/**
 * Turns the stored `ended_after_idle_minutes` value into the milliseconds
 * `Runner` waits before ending an idle session, or `null` for "never arm the
 * timer at all".
 *
 * Deliberately total: anything that is neither `IDLE_NEVER` nor a finite
 * positive minute count falls back to the default rather than reaching
 * `setTimeout` as `NaN`/`0`. Only the explicit sentinel disables the timer,
 * so a corrupt row cannot silently make sessions immortal either.
 */
export function parseIdleTimeoutMs(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === IDLE_NEVER) return null;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_IDLE_MINUTES * 60_000;
  return minutes * 60_000;
}

export type QueryFn = (args: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => AsyncGenerator<any> & { interrupt?: () => Promise<void> };

interface ManagedSession {
  status: SessionStatus;
  queue: Array<(msg: unknown | null) => void>;
  pending: Array<unknown | null>;
  generator: (AsyncGenerator<any> & { interrupt?: () => Promise<void> }) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Converts one SDK message into zero or more ChatMessages.
 * `nextSeq` must return a monotonically increasing number per call — callers
 * (Runner) bind it to a per-instance counter so ids can't collide when two
 * messages land in the same millisecond with the same block index.
 */
export function sdkToChatMessages(sdkMsg: any, nextSeq: () => number): ChatMessage[] {
  const content = sdkMsg.message?.content;
  if (!Array.isArray(content)) return [];
  const out: ChatMessage[] = [];
  content.forEach((block: any, i: number) => {
    const id = `${sdkMsg.session_id}:${nextSeq()}:${i}`;
    if (block.type === 'text' && block.text?.trim()) {
      out.push({ id, role: sdkMsg.type === 'user' ? 'user' : 'assistant', text: block.text });
    } else if (block.type === 'tool_use') {
      out.push({ id, role: 'tool_use', toolName: block.name, toolInput: block.input, toolUseId: block.id });
    } else if (block.type === 'tool_result') {
      out.push({
        id, role: 'tool_result', toolUseId: block.tool_use_id,
        text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
      });
    }
  });
  return out;
}

export class Runner {
  private sessions = new Map<string, ManagedSession>();
  private ended = new Set<string>();
  private seq = 0;
  private hub: Hub;
  private queryFn: QueryFn;
  private newSessionId: () => string;
  private idleTimeoutMs: number | null;
  private onStatus?: (sessionId: string, status: SessionStatus) => void;
  private onEntries?: (sessionId: string, entries: TranscriptEntry[]) => void;

  constructor(deps: {
    hub: Hub;
    queryFn?: QueryFn;
    /**
     * Mints the id a fresh session runs under, handed to the CLI as
     * `options.sessionId`. Injectable so tests can pin a readable id; the
     * default is a v4 UUID, which is the only shape the CLI accepts.
     */
    newSessionId?: () => string;
    /** `null` disables the idle timer entirely (the `IDLE_NEVER` preset). */
    idleTimeoutMs?: number | null;
    onStatus?: (sessionId: string, status: SessionStatus) => void;
    /**
     * Every assistant/user message the SDK streams, in transcript-entry shape.
     * The stream carries the session's `Task` blocks, so a web session's
     * subagents are known continuously without anyone tailing its transcript.
     */
    onEntries?: (sessionId: string, entries: TranscriptEntry[]) => void;
  }) {
    this.hub = deps.hub;
    this.queryFn = deps.queryFn ?? (query as unknown as QueryFn);
    this.newSessionId = deps.newSessionId ?? randomUUID;
    // `??` would turn an explicit `null` ("never") back into the default, so
    // only `undefined` (the key absent) may fall through to it.
    this.idleTimeoutMs =
      deps.idleTimeoutMs === undefined ? DEFAULT_IDLE_MINUTES * 60_000 : deps.idleTimeoutMs;
    this.onStatus = deps.onStatus;
    this.onEntries = deps.onEntries;
  }

  /**
   * Applies a new idle timeout to this Runner *and to sessions that are
   * already idling*, so changing the setting takes effect without restarting
   * the API.
   *
   * Armed timers are re-armed immediately rather than only on the session's
   * next activity: a session parked in `needs_input` may never reach another
   * `armIdleTimer()` call — being untouched is exactly the state this setting
   * governs — so deferring would strand already-idle sessions on the old
   * timeout forever, and switching away from "never" would never arm one at
   * all. The re-arm starts a *full* new interval from now instead of
   * subtracting elapsed idle time, so a change can only postpone an end,
   * never pull one forward past a deadline the user never saw.
   *
   * `working` sessions are left alone here; they pick the new value up at
   * their next `armIdleTimer()` (turn result/interrupt). Idleness is keyed off
   * `status`, not off whether a timer handle exists — under the "never"
   * preset an idling session has no handle, and it is precisely that session
   * that must get a timer when the user switches back to a timed value.
   */
  setIdleTimeoutMs(idleTimeoutMs: number | null): void {
    this.idleTimeoutMs = idleTimeoutMs;
    for (const [sessionId, s] of this.sessions) {
      if (s.status !== 'needs_input') continue;
      this.armIdleTimer(sessionId);
    }
  }

  /**
   * Clears every armed idle timer (server shutdown). The timers are already
   * `unref()`d so they never hold the process open, but one firing after
   * close would call `end()` on a Runner whose Hub and db are gone.
   */
  dispose(): void {
    for (const s of this.sessions.values()) {
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = null;
    }
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === status) return;
    s.status = status;
    this.hub.publish(`session:${sessionId}`, { event: 'status', status });
    this.onStatus?.(sessionId, status);
  }

  private userMessage(sessionId: string, text: string): unknown {
    return {
      type: 'user',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
  }

  private armIdleTimer(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
    // "Never": leave the session without a timer. This runs *after* the clear
    // above, so flipping to "never" also disarms what was already armed.
    if (this.idleTimeoutMs === null) return;
    const timer = setTimeout(() => void this.end(sessionId), this.idleTimeoutMs);
    // Don't let the idle timer keep the process alive (e.g. during tests).
    (timer as unknown as { unref?: () => void }).unref?.();
    s.idleTimer = timer;
  }

  /** Final state transition shared by explicit end() and natural SDK-generator completion. */
  private finish(sessionId: string): void {
    this.setStatus(sessionId, 'ended');
    this.ended.add(sessionId);
    const s = this.sessions.get(sessionId);
    if (s?.idleTimer) clearTimeout(s.idleTimer);
    if (s) s.idleTimer = null;
    this.sessions.delete(sessionId);
  }

  /**
   * Starts (or resumes) a session and returns its id.
   *
   * Resolves without waiting to hear anything from the CLI, because there is
   * nothing to wait for: in stream-json input mode the CLI sits silent on
   * stdin and emits `system/init` only *after* it has been sent a user
   * message. The previous order — withhold the first prompt until `init`
   * arrives — was a deadlock in which the launch request hung forever, the
   * session row was never written, and the only trace was the spawned CLI
   * registering itself in `~/.claude/sessions` (the "record appears, nothing
   * happens" report). Instead Orbital *pins* the id via `options.sessionId`
   * and hands it to the CLI, so the id is known before the process says a
   * word. See `docs/decisions/runner-pins-the-session-id.md`.
   */
  async start(opts: {
    cwd: string;
    prompt: string;
    permissionMode: PermissionMode;
    resume?: string;
    model?: string;
  }): Promise<string> {
    // A resume keeps the transcript's own id; a fresh session gets a new one.
    const sessionId = opts.resume ?? this.newSessionId();
    if (this.sessions.has(sessionId)) {
      throw new Error(`resume collision: session ${sessionId} already active`);
    }
    const state: ManagedSession = {
      status: 'working', queue: [], pending: [], generator: null, idleTimer: null,
    };
    // Registered before anything is awaited, so two concurrent start() calls
    // for the same id can't both get past the check above.
    this.sessions.set(sessionId, state);
    this.ended.delete(sessionId);

    // Input stream: yields queued user messages; null closes it.
    const dequeue = () =>
      new Promise<unknown | null>((resolve) => {
        if (state.pending.length) resolve(state.pending.shift()!);
        else state.queue.push(resolve);
      });
    async function* input() {
      while (true) {
        const msg = await dequeue();
        if (msg === null) return;
        yield msg;
      }
    }
    const options: Record<string, unknown> = {
      cwd: opts.cwd,
      permissionMode: opts.permissionMode,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
    };
    // `sessionId` and `resume` are mutually exclusive in the SDK; resuming
    // already fixes the id, so it is only pinned for a fresh session.
    if (opts.resume) options.resume = opts.resume;
    else options.sessionId = sessionId;
    if (opts.model) options.model = opts.model;

    const generator = this.queryFn({ prompt: input(), options });
    state.generator = generator;
    void this.pump(sessionId, generator);

    // An empty prompt (e.g. clear+startNew) means "start the session but wait
    // for the caller's first send()" — enqueueing an empty user turn would
    // otherwise burn a turn on nothing (I6). Nothing reaches the CLI until
    // then, so it stays parked on stdin, which is exactly `needs_input`.
    if (opts.prompt) this.enqueue(sessionId, this.userMessage(sessionId, opts.prompt));
    else this.setStatus(sessionId, 'needs_input');

    return sessionId;
  }

  /** Drains one session's SDK message stream onto the hub until it ends. */
  private async pump(sessionId: string, generator: AsyncGenerator<any>): Promise<void> {
    const topic = `session:${sessionId}`;
    try {
      for await (const msg of generator) {
        // Every CLI message names the session it belongs to. Anything wearing
        // a different id (a stray from another session) is not ours to
        // publish; messages with no id at all are stream-level noise.
        if (msg?.session_id !== sessionId) continue;
        if (msg.type === 'assistant' || msg.type === 'user') {
          this.onEntries?.(sessionId, [msg as TranscriptEntry]);
          for (const chat of sdkToChatMessages(msg, () => ++this.seq)) {
            this.hub.publish(topic, { event: 'message', message: chat });
          }
        } else if (msg.type === 'result') {
          this.hub.publish(topic, { event: 'turn_result', usage: msg.usage ?? {} });
          this.setStatus(sessionId, 'needs_input');
          this.armIdleTimer(sessionId);
        }
      }
    } catch (err) {
      console.warn('orbital: runner pump error:', err);
    }
    // Generator finished: the SDK process exited, or end() closed the input
    // stream. Harmless after an explicit end() — the session is already gone
    // from the map, so finish() publishes nothing a second time.
    this.finish(sessionId);
  }

  private enqueue(sessionId: string, msg: unknown | null): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const waiter = s.queue.shift();
    if (waiter) waiter(msg);
    else s.pending.push(msg);
  }

  send(sessionId: string, text: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === 'ended') throw new Error(`session ${sessionId} is not active`);
    // Null the handle, not just clear it — a cleared-but-retained handle is a
    // dangling reference to a timer that can never fire again.
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
    this.setStatus(sessionId, 'working');
    this.enqueue(sessionId, this.userMessage(sessionId, text));
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.generator?.interrupt?.();
    this.setStatus(sessionId, 'needs_input');
    this.armIdleTimer(sessionId);
  }

  async end(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
    this.enqueue(sessionId, null); // close the input stream
    this.finish(sessionId);
  }

  status(sessionId: string): SessionStatus | undefined {
    const s = this.sessions.get(sessionId);
    if (s) return s.status;
    return this.ended.has(sessionId) ? 'ended' : undefined;
  }

  active(): string[] {
    return [...this.sessions.keys()];
  }
}
