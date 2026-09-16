import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Hub } from '../api/hub.js';
import type { PermissionMode, SessionStatus, ChatMessage } from '../types.js';

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
  /**
   * Resume ids currently mid-`start()` but not yet registered in `sessions`
   * (init message not yet received). Guards the race where two concurrent
   * `start({resume: id})` calls both pass the synchronous `sessions.has`
   * check before either has registered — the second reservation attempt
   * throws instead. Always released before `start()` settles (resolve,
   * reject, or an unexpected synchronous throw), so it never leaks.
   */
  private starting = new Set<string>();
  private ended = new Set<string>();
  private seq = 0;
  private hub: Hub;
  private queryFn: QueryFn;
  private idleTimeoutMs: number | null;
  private onStatus?: (sessionId: string, status: SessionStatus) => void;

  constructor(deps: {
    hub: Hub;
    queryFn?: QueryFn;
    /** `null` disables the idle timer entirely (the `IDLE_NEVER` preset). */
    idleTimeoutMs?: number | null;
    onStatus?: (sessionId: string, status: SessionStatus) => void;
  }) {
    this.hub = deps.hub;
    this.queryFn = deps.queryFn ?? (query as unknown as QueryFn);
    // `??` would turn an explicit `null` ("never") back into the default, so
    // only `undefined` (the key absent) may fall through to it.
    this.idleTimeoutMs =
      deps.idleTimeoutMs === undefined ? DEFAULT_IDLE_MINUTES * 60_000 : deps.idleTimeoutMs;
    this.onStatus = deps.onStatus;
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

  async start(opts: {
    cwd: string;
    prompt: string;
    permissionMode: PermissionMode;
    resume?: string;
    model?: string;
  }): Promise<string> {
    if (opts.resume) {
      if (this.sessions.has(opts.resume) || this.starting.has(opts.resume)) {
        throw new Error(`resume collision: session ${opts.resume} already active`);
      }
      // Reserve synchronously (before any await below) so a second
      // concurrent start() for the same resume id — even one whose SDK
      // init hasn't arrived yet — sees the reservation and collides too.
      this.starting.add(opts.resume);
    }
    const releaseReservation = () => {
      if (opts.resume) this.starting.delete(opts.resume);
    };
    try {
      const state: ManagedSession = {
        status: 'working', queue: [], pending: [], generator: null, idleTimer: null,
      };
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
      if (opts.resume) options.resume = opts.resume;
      if (opts.model) options.model = opts.model;

      const generator = this.queryFn({ prompt: input(), options });
      state.generator = generator;

      const sessionId = await new Promise<string>((resolve, reject) => {
        let resolved = false;
        const pump = async () => {
          try {
            for await (const msg of generator) {
              const id: string | undefined = msg?.session_id;
              if (!resolved && id && msg.type === 'system' && msg.subtype === 'init') {
                resolved = true;
                this.sessions.set(id, state);
                releaseReservation();
                resolve(id);
                // First user message goes in only after the session is registered.
                // An empty prompt (e.g. clear+startNew) means "start the session
                // but wait for the caller's first send()" — enqueueing an empty
                // user turn would otherwise burn a turn on nothing (I6).
                if (opts.prompt) {
                  this.enqueue(id, this.userMessage(id, opts.prompt));
                } else {
                  this.setStatus(id, 'needs_input');
                }
              }
              if (!id) continue;
              if (msg.type === 'assistant' || msg.type === 'user') {
                for (const chat of sdkToChatMessages(msg, () => ++this.seq)) {
                  this.hub.publish(`session:${id}`, { event: 'message', message: chat });
                }
              } else if (msg.type === 'result') {
                this.hub.publish(`session:${id}`, { event: 'turn_result', usage: msg.usage ?? {} });
                this.setStatus(id, 'needs_input');
                this.armIdleTimer(id);
              }
            }
          } catch (err) {
            console.warn('orbital: runner pump error:', err);
          }
          // Generator finished (SDK process exited, or the input stream was closed).
          if (resolved) {
            const id = [...this.sessions.entries()].find(([, s]) => s === state)?.[0];
            if (id) this.finish(id);
          } else {
            releaseReservation();
            reject(new Error('SDK query ended before init'));
          }
        };
        void pump();
      });
      return sessionId;
    } catch (err) {
      releaseReservation();
      throw err;
    }
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
