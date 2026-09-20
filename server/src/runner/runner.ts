import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Hub } from '../api/hub.js';
import type { PermissionMode, SessionStatus, ChatMessage } from '../types.js';
import type { TranscriptEntry } from '../transcript/parser.js';
import { TASK_EVENT_SUBTYPES, type TaskEvent } from '../transcript/subagents.js';
import { imageRefOf, splitUserText, toolResultParts } from '../transcript/parser.js';
import type { ImageStore, ImageWriter } from '../images/store.js';

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

/**
 * The subset of the SDK's `Query` object Orbital uses. `supportedModels`,
 * `supportedCommands` and `setModel` are optional because a fake in a test may
 * implement only what that test exercises — and because a CLI too old to
 * answer a control request must degrade to "unknown", never to a crash.
 */
export type QueryFn = (args: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => AsyncGenerator<any> & {
  interrupt?: () => Promise<void>;
  setModel?: (model?: string) => Promise<void>;
  supportedModels?: () => Promise<unknown[]>;
  supportedCommands?: () => Promise<unknown[]>;
};

/**
 * One row of the session's slash-command list, as the composer's popup needs
 * it — the SDK's `SlashCommand` with the empties dropped, so a command with no
 * argument hint carries no field rather than an empty string the UI would then
 * have to test for. `source` is not here: it is the *route* that attributes
 * one, by matching these names against the filesystem catalog.
 */
export interface SessionCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

/**
 * Keeps what the popup can use and drops what it cannot. Anything without a
 * name is not a command anyone could type, and the CLI's own `argumentHint`
 * is frequently `''` — an absent field says "none" more honestly.
 */
function shapeCommands(raw: unknown[]): SessionCommand[] {
  const out: SessionCommand[] = [];
  for (const entry of raw) {
    const c = entry as { name?: unknown; description?: unknown; argumentHint?: unknown; aliases?: unknown };
    if (typeof c?.name !== 'string' || !c.name) continue;
    const aliases = Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === 'string') : [];
    out.push({
      name: c.name,
      description: typeof c.description === 'string' ? c.description : '',
      ...(typeof c.argumentHint === 'string' && c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      ...(aliases.length ? { aliases } : {}),
    });
  }
  return out;
}

/**
 * What the session was started with, kept so a failure can say what it was
 * trying to run. The sessions row carries the same three, but not always in
 * time: `POST /api/sessions` inserts it only *after* `start()` returns, and a
 * spawn that fails is precisely the case where the two race. The Runner knows
 * them before the CLI is asked for anything, so it is the one place they are
 * always available.
 */
export interface SessionAttempt {
  cwd: string;
  permissionMode: PermissionMode;
  model: string | null;
}

/**
 * The one tool Orbital can render a surface for. Every other tool the CLI asks
 * about is denied — see `decide`.
 */
const QUESTION_TOOL = 'AskUserQuestion';

/**
 * A blocked tool call waiting on the browser, as it travels on the hub
 * (`decision_pending`) and in the session snapshot (`ApiSession`).
 *
 * `kind` is an open union on purpose: ordinary permission prompts and
 * `onUserDialog` dialogs ride this same envelope later without changing the
 * transport (spec 2026-09-20-interactive-decisions-design § Channel).
 */
export interface PendingDecision {
  /** The SDK's `toolUseID` — what an answer has to name to be accepted. */
  id: string;
  kind: 'question';
  /** The tool's own input, verbatim: `AskUserQuestionInput` for `question`. */
  input: Record<string, unknown>;
  createdAt: number;
}

/**
 * The question texts of a decision's input, which are the keys its `answers`
 * map is keyed by. Total: anything that is not a question with text is not
 * something an answer could be missing for.
 */
export function decisionQuestions(input: Record<string, unknown>): string[] {
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q) => (q as { question?: unknown })?.question)
    .filter((q): q is string => typeof q === 'string' && q.length > 0);
}

interface ManagedSession {
  status: SessionStatus;
  queue: Array<(msg: unknown | null) => void>;
  pending: Array<unknown | null>;
  /**
   * The decision this session's CLI is blocked on, with the resolver of the
   * `canUseTool` promise that block *is*. One at a time: the model cannot ask
   * a second question while it waits on the first.
   */
  decision: {
    pending: PendingDecision;
    /** Settles the SDK's promise and drops the abort listener with it. */
    settle: (result: PermissionResult) => void;
  } | null;
  /**
   * The live query handle — the object `queryFn` returned. It is both the
   * message stream `pump()` drains and the control channel `interrupt`,
   * `setModel` and `supportedCommands` travel on, which is why it is kept per
   * session rather than consumed and forgotten.
   */
  generator:
    | (AsyncGenerator<any> & {
        interrupt?: () => Promise<void>;
        setModel?: (model?: string) => Promise<void>;
        supportedCommands?: () => Promise<unknown[]>;
      })
    | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  attempt: SessionAttempt;
  /** The session's command list once asked for (or pushed), `null` until then.
   * It lives on the session, so it dies with it — see `finish()`. */
  commands: SessionCommand[] | null;
}

/**
 * Converts one SDK message into zero or more ChatMessages.
 * `nextSeq` must return a monotonically increasing number per call — callers
 * (Runner) bind it to a per-instance counter so ids can't collide when two
 * messages land in the same millisecond with the same block index.
 */
export function sdkToChatMessages(sdkMsg: any, nextSeq: () => number, images?: ImageWriter): ChatMessage[] {
  const content = sdkMsg.message?.content;
  if (!Array.isArray(content)) return [];
  const model = typeof sdkMsg.message?.model === 'string' ? sdkMsg.message.model : undefined;
  const out: ChatMessage[] = [];
  content.forEach((block: any, i: number) => {
    const id = `${sdkMsg.session_id}:${nextSeq()}:${i}`;
    if (block.type === 'text' && block.text?.trim()) {
      if (sdkMsg.type === 'user') {
        // Same split as the indexed path (`entriesToMessages`) — a live
        // command expansion must fold identically to a reloaded one.
        const split = splitUserText(block.text);
        out.push({ id, role: 'user', text: split.text, ...(split.command ? { command: split.command } : {}) });
      } else {
        out.push({ id, role: 'assistant', text: block.text, model });
      }
    } else if (block.type === 'tool_use') {
      out.push({ id, role: 'tool_use', toolName: block.name, toolInput: block.input, toolUseId: block.id });
    } else if (block.type === 'tool_result') {
      const parts = toolResultParts(block.content ?? '', images);
      out.push({
        id, role: 'tool_result', toolUseId: block.tool_use_id,
        text: parts.text,
        ...(parts.images.length ? { images: parts.images } : {}),
        ...(block.is_error === true ? { isError: true } : {}),
      });
    } else if (block.type === 'image') {
      const entry = imageRefOf(block, images);
      if (entry) out.push({ id, role: sdkMsg.type === 'user' ? 'user' : 'assistant', images: [entry] });
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
  private onTurnUsage?: (modelUsage: unknown) => void;
  private onInit?: (sessionId: string, model: string | null) => void;
  private onEntries?: (sessionId: string, entries: TranscriptEntry[]) => void;
  private onTaskEvent?: (sessionId: string, msg: TaskEvent) => void;
  private onError?: (sessionId: string, err: unknown, attempt?: SessionAttempt) => void;
  private images?: ImageStore;

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
    /** Content-addressed store live image blocks are decoded into; absent
     * (some tests) they drop, which was always the live path's behaviour. */
    images?: ImageStore;
    onStatus?: (sessionId: string, status: SessionStatus) => void;
    /** Receives each turn result's `modelUsage`, which is where context-window sizes come from. */
    onTurnUsage?: (modelUsage: unknown) => void;
    /** Receives the resolved model a session actually started on (`system/init`). */
    onInit?: (sessionId: string, model: string | null) => void;
    /**
     * Every assistant/user message the SDK streams, in transcript-entry shape.
     * What the session said, for readers that care about its contents — the
     * auto-titler. Subagent liveness does *not* come from here; see
     * `onTaskEvent`.
     */
    onEntries?: (sessionId: string, entries: TranscriptEntry[]) => void;
    /**
     * The task lifecycle the SDK streams as `system` messages
     * (`TASK_EVENT_SUBTYPES`): where a subagent's live state comes from.
     * The tool blocks cannot answer it, because `Agent` runs in the background
     * and its `tool_result` comes back at launch
     * (adr: subagent-liveness-from-sdk-task-events).
     */
    onTaskEvent?: (sessionId: string, msg: TaskEvent) => void;
    /**
     * Whatever the SDK generator threw, with the session it was running.
     * Called from `pump()`'s catch, where the only record of a session dying
     * on its own used to be a line on the server's terminal that nobody was
     * reading — see
     * `docs/superpowers/specs/2026-09-17-error-surface-design.md`.
     *
     * Reporting only; the session still ends the same way it always did.
     * `finish()` runs regardless of whether this is wired, and there is no
     * `failed` status for it to reach.
     *
     * `attempt` is what the session was started with, so a failure can name
     * the directory it could not run in without waiting for the sessions row
     * to exist. Absent only if the session is already gone from the map.
     */
    onError?: (sessionId: string, err: unknown, attempt?: SessionAttempt) => void;
  }) {
    this.hub = deps.hub;
    this.queryFn = deps.queryFn ?? (query as unknown as QueryFn);
    this.newSessionId = deps.newSessionId ?? randomUUID;
    // `??` would turn an explicit `null` ("never") back into the default, so
    // only `undefined` (the key absent) may fall through to it.
    this.idleTimeoutMs =
      deps.idleTimeoutMs === undefined ? DEFAULT_IDLE_MINUTES * 60_000 : deps.idleTimeoutMs;
    this.onStatus = deps.onStatus;
    this.onTurnUsage = deps.onTurnUsage;
    this.onInit = deps.onInit;
    this.onEntries = deps.onEntries;
    this.onTaskEvent = deps.onTaskEvent;
    this.onError = deps.onError;
    this.images = deps.images;
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
      // A parked question has no deadline (see `decide`), so a setting change
      // must not hand it one either.
      if (s.decision) continue;
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

  /**
   * One SDK user message, or `null` when there is nothing to say.
   *
   * Images first, then the text — the order the model reads them in, and the
   * order the composer shows them in (chips above the field). Base64 exists on
   * exactly this hop: everything Orbital stores or puts on its own wire is a
   * ref, and only the message handed to the CLI carries bytes.
   *
   * A ref the store no longer holds is skipped without a word. The alternative
   * is failing a turn over a thumbnail the cache pruned, which is a worse
   * answer than sending the rest of what was typed.
   */
  private userMessage(sessionId: string, text: string, attachments?: string[]): unknown | null {
    const content: unknown[] = [];
    for (const ref of attachments ?? []) {
      const image = this.images?.read(ref);
      if (!image) continue;
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
      });
    }
    if (text) content.push({ type: 'text', text });
    // "An empty prompt enqueues nothing" now reads "empty prompt *and* nothing
    // attached": a turn of only images is a real turn, a turn of neither is not.
    if (content.length === 0) return null;
    return {
      type: 'user',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content },
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
    // The backstop for the paths that do not go through end(): a generator
    // that completed or threw while a question was parked. No promise may
    // outlive its session.
    this.settleDecision(sessionId, { behavior: 'deny', message: 'The session ended.' });
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
   *
   * `sessionId` lets the *caller* pin that id rather than have one minted
   * here. The browser mints it and subscribes to `session:<id>` before it
   * posts the launch, so the window in which the first turn could publish to
   * a topic nobody is listening on never opens. `resume` still wins over it:
   * a resumed session's id is already fixed by its transcript, and the two
   * are mutually exclusive in the SDK.
   */
  async start(opts: {
    cwd: string;
    prompt: string;
    permissionMode: PermissionMode;
    resume?: string;
    /** An id the caller has already committed to. Must be a v4 UUID — the only shape the CLI accepts. */
    sessionId?: string;
    model?: string;
    /** Image store refs to send alongside the first prompt — the New Session
     * dialog's attachments, and a revived session's. */
    attachments?: string[];
  }): Promise<string> {
    // A resume keeps the transcript's own id; otherwise the caller's pinned
    // id if it brought one, and a freshly minted one if it did not.
    const sessionId = opts.resume ?? opts.sessionId ?? this.newSessionId();
    if (this.sessions.has(sessionId)) {
      throw new Error(`resume collision: session ${sessionId} already active`);
    }
    const state: ManagedSession = {
      status: 'working', queue: [], pending: [], generator: null, idleTimer: null,
      attempt: { cwd: opts.cwd, permissionMode: opts.permissionMode, model: opts.model ?? null },
      commands: null, decision: null,
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
      // Without this the SDK treats every "ask" decision as terminal and
      // auto-denies it, which is what used to push `AskUserQuestion` into
      // plain prose (spec 2026-09-20-interactive-decisions-design).
      canUseTool: ((toolName, input, canUseOpts) =>
        this.decide(sessionId, toolName, input, canUseOpts)) satisfies CanUseTool,
    };
    // `sessionId` and `resume` are mutually exclusive in the SDK; resuming
    // already fixes the id, so it is only pinned for a fresh session.
    if (opts.resume) options.resume = opts.resume;
    else options.sessionId = sessionId;
    if (opts.model) options.model = opts.model;

    const generator = this.queryFn({ prompt: input(), options });
    state.generator = generator;
    void this.pump(sessionId, generator);

    // An empty prompt with nothing attached (e.g. clear+startNew) means "start
    // the session but wait for the caller's first send()" — enqueueing an empty
    // user turn would otherwise burn a turn on nothing (I6). Nothing reaches
    // the CLI until then, so it stays parked on stdin, which is exactly
    // `needs_input`.
    const first = this.userMessage(sessionId, opts.prompt, opts.attachments);
    if (first) this.enqueue(sessionId, first);
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
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.onInit?.(sessionId, typeof msg.model === 'string' ? msg.model : null);
          continue;
        }
        // A fire-and-forget push of the whole command list after a mid-session
        // change (a skill discovered as the agent moves into a subdirectory).
        // The SDK's instruction is to REPLACE the cached list with it, so that
        // is what this does — a re-ask would return the same thing anyway.
        // A subagent's life, as the CLI reports it; the tool blocks below
        // cannot tell when one ends (`onTaskEvent`). Every other `system`
        // subtype falls through unread, as before.
        if (msg.type === 'system' && TASK_EVENT_SUBTYPES.has(msg.subtype)) {
          this.onTaskEvent?.(sessionId, msg as TaskEvent);
          continue;
        }
        if (msg.type === 'system' && msg.subtype === 'commands_changed') {
          const s = this.sessions.get(sessionId);
          if (s && Array.isArray(msg.commands)) s.commands = shapeCommands(msg.commands);
          continue;
        }
        if (msg.type === 'assistant' || msg.type === 'user') {
          this.onEntries?.(sessionId, [msg as TranscriptEntry]);
          for (const chat of sdkToChatMessages(msg, () => ++this.seq, this.images)) {
            this.hub.publish(topic, { event: 'message', message: chat });
          }
        } else if (msg.type === 'result') {
          this.hub.publish(topic, { event: 'turn_result', usage: msg.usage ?? {} });
          this.onTurnUsage?.(msg.modelUsage);
          this.setStatus(sessionId, 'needs_input');
          this.armIdleTimer(sessionId);
        }
      }
    } catch (err) {
      // Both, deliberately: the terminal keeps saying it, and the browser
      // finally gets to. A reporter that throws must not stop `finish()`
      // below from running — a session that failed twice is still a session
      // that has to end.
      console.warn('orbital: runner pump error:', err);
      try {
        this.onError?.(sessionId, err, this.sessions.get(sessionId)?.attempt);
      } catch (reportErr) {
        console.warn('orbital: failed to record runner error:', reportErr);
      }
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

  /**
   * The SDK's `canUseTool`: what the CLI blocks on while it waits for a
   * human. An unsettled promise blocks the tool forever — the SDK gives it no
   * park deadline — so every path out of here settles exactly once.
   */
  private decide(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    opts: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    // The extension point for permission prompts and dialogs: a new `kind` on
    // the same envelope. Until Orbital has a surface for one, denying
    // reproduces exactly what the SDK did while no `canUseTool` was passed.
    if (toolName !== QUESTION_TOOL) {
      return Promise.resolve({
        behavior: 'deny',
        message: `Orbital has no prompt surface for ${toolName}.`,
      });
    }
    const s = this.sessions.get(sessionId);
    if (!s) {
      return Promise.resolve({ behavior: 'deny', message: `session ${sessionId} is not active` });
    }
    // Defensive: the model is blocked on the first question, so a second
    // cannot normally arrive. If one does, the older promise is settled rather
    // than dropped — an overwritten resolver is a permanently blocked tool.
    this.settleDecision(sessionId, {
      behavior: 'deny',
      message: 'Superseded by a newer question.',
    });
    const pending: PendingDecision = {
      id: opts.toolUseID, kind: 'question', input, createdAt: Date.now(),
    };
    return new Promise<PermissionResult>((resolve) => {
      // Already aborted: `addEventListener` would never fire, and parking a
      // decision nothing will ever answer is worse than denying it now.
      if (opts.signal.aborted) {
        resolve({ behavior: 'deny', message: 'The request was aborted.' });
        return;
      }
      const onAbort = () =>
        this.settleDecision(sessionId, { behavior: 'deny', message: 'The request was aborted.' });
      opts.signal.addEventListener('abort', onAbort, { once: true });
      s.decision = {
        pending,
        settle: (result) => {
          opts.signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
      };
      this.hub.publish(`session:${sessionId}`, { event: 'decision_pending', decision: pending });
      // No idle timer is armed for this: a parked question has no deadline,
      // mirroring the SDK, whose `canUseTool` promise has none either.
      this.setStatus(sessionId, 'needs_input');
    });
  }

  /**
   * Settles this session's parked decision, if it has one, and tells every
   * client so their cards lock. `false` when there was nothing parked, which
   * is what makes calling this from every exit path harmless.
   */
  private settleDecision(sessionId: string, result: PermissionResult): boolean {
    const s = this.sessions.get(sessionId);
    const parked = s?.decision;
    if (!s || !parked) return false;
    // Cleared before the resolve, so a settle path that re-enters here
    // (abort racing an answer) finds nothing left to settle.
    s.decision = null;
    parked.settle(result);
    this.hub.publish(`session:${sessionId}`, {
      event: 'decision_resolved',
      decisionId: parked.pending.id,
    });
    return true;
  }

  /**
   * The decision this session is blocked on, or `null` — including for every
   * session this process does not run, whose questions died with it. It is on
   * the session snapshot so a page reload recovers the question.
   */
  pendingDecision(sessionId: string): PendingDecision | null {
    return this.sessions.get(sessionId)?.decision?.pending ?? null;
  }

  /**
   * Answers the parked question and unblocks the tool. `false` for every case
   * the route reports as 404: a session it does not run, and an id that is not
   * the parked one — a decision already settled among them, which is how the
   * loser of two open windows finds out.
   *
   * `answers` is taken as given: the route checks there is one per question,
   * nothing checks what they say.
   */
  answerDecision(sessionId: string, decisionId: string, answers: Record<string, string>): boolean {
    const parked = this.sessions.get(sessionId)?.decision;
    if (!parked || parked.pending.id !== decisionId) return false;
    this.settleDecision(sessionId, {
      behavior: 'allow',
      updatedInput: { ...parked.pending.input, answers },
    });
    this.setStatus(sessionId, 'working');
    return true;
  }

  send(sessionId: string, text: string, attachments?: string[]): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === 'ended') throw new Error(`session ${sessionId} is not active`);
    // Composer text answers a parked question instead of starting a turn: the
    // model asked, so the text it gets back is the answer, which is what the
    // typing meant. Every question gets the same text — the web client routes
    // per question before it ever posts here, and this is the fallback for the
    // race and for the API. Attachments have nowhere to go on this path.
    const parked = s.decision;
    if (parked && text) {
      const answers: Record<string, string> = {};
      for (const question of decisionQuestions(parked.pending.input)) answers[question] = text;
      this.settleDecision(sessionId, {
        behavior: 'allow',
        updatedInput: { ...parked.pending.input, answers },
      });
      this.setStatus(sessionId, 'working');
      return;
    }
    const msg = this.userMessage(sessionId, text, attachments);
    // Nothing to say: leave the session exactly as it was. Flipping it to
    // `working` first would strand it there — no turn is running, so no
    // `result` is coming to move it back.
    if (!msg) return;
    // Null the handle, not just clear it — a cleared-but-retained handle is a
    // dangling reference to a timer that can never fire again.
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
    this.setStatus(sessionId, 'working');
    this.enqueue(sessionId, msg);
  }

  /**
   * The slash commands this session's CLI will actually honour, or `null` when
   * there is no live query to ask (an ended session, or one this process never
   * ran). The route treats `null` as its cue to answer from the filesystem
   * catalog alone — see spec 2026-09-20-composer-design § Server.
   *
   * Cached per session and thrown away with it. The cache is also *replaced*
   * whenever the CLI pushes a new list (`system/commands_changed` in
   * `pump()`), which is what keeps a skill discovered mid-session from needing
   * a re-ask.
   */
  async commands(sessionId: string): Promise<SessionCommand[] | null> {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (s.commands) return s.commands;
    const generator = s.generator;
    // A CLI too old to know the control request answers "unknown", not an error.
    if (!generator?.supportedCommands) return null;
    let raw: unknown[];
    try {
      raw = await generator.supportedCommands();
    } catch {
      return null;
    }
    if (!Array.isArray(raw)) return null;
    const shaped = shapeCommands(raw);
    // A push that landed while this request was in flight is newer than it, so
    // it keeps the cache; and the session may have ended in the meantime.
    const still = this.sessions.get(sessionId);
    if (still && !still.commands) still.commands = shaped;
    return still?.commands ?? shaped;
  }

  async interrupt(sessionId: string): Promise<void> {
    // Nothing is auto-answered on the user's behalf: an interrupted question
    // is a denied one, and its card locks unanswered.
    this.settleDecision(sessionId, { behavior: 'deny', message: 'The user interrupted.' });
    await this.sessions.get(sessionId)?.generator?.interrupt?.();
    this.setStatus(sessionId, 'needs_input');
    this.armIdleTimer(sessionId);
  }

  /**
   * Changes the model for this session's next turn. The SDK keeps the
   * conversation — only what serves it changes — which is why the UI can
   * promise "context is kept".
   */
  async setModel(sessionId: string, model: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === 'ended') throw new Error(`session ${sessionId} is not active`);
    await s.generator?.setModel?.(model);
  }

  async end(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    // Before the input stream closes, so the CLI is unblocked while it can
    // still read the answer to the question it is parked on.
    this.settleDecision(sessionId, { behavior: 'deny', message: 'The session ended.' });
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
