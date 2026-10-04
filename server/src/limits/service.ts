import { eq } from 'drizzle-orm';
import type { OrbitalDb } from '../db/database.js';
import { limitWaits, sessions } from '../db/schema.js';
import type { QueryFn } from '../runner/runner.js';
import type { ChatMessage } from '../types.js';
import { FIRST_CLAUDE_DIR_ID } from '../claudeDirs/paths.js';
import {
  AUTO_CONTINUE_KEY,
  CONTINUE_TEXT_KEY,
  LIMITS_REFRESH_INTERVAL_MS,
  RESET_GRACE_MS,
  autoContinueOf,
  continueTextOf,
  probeResetFor,
  readUsageAnswer,
  waitFromLimitHit,
  whatFiringSends,
  type ClaudeDirLimits,
  type ExtraUsage,
  type LimitWait,
  type LimitWindow,
  type LimitsSnapshot,
  type QueuedMessage,
  type RejectedLimit,
} from './logic.js';

/** A probe that neither answers nor exits gives up after this long. */
export const LIMITS_PROBE_TIMEOUT_MS = 15_000;

/**
 * The longest a wait timer is armed for. A timer does not count time the Mac
 * spent asleep, so a wait due during sleep is caught by the next check after
 * waking rather than by a timer that still thinks it has hours to go.
 */
export const WAIT_CHECK_INTERVAL_MS = 60_000;

/** The WS topic the limits view listens on. */
export const LIMITS_TOPIC = 'limits';

/** What a delivery into a session did — `deliverToSession`'s outcome. */
export type LimitDeliveryOutcome = 'sent' | 'revived' | 'not_found' | 'terminal';

/** What the limits need to know about the Claude directories. */
export interface LimitsClaudeDirs {
  /** The configured directories, in the order the view lists them. */
  list(): { id: number; name: string }[];
  /** The environment a probe of this directory runs under (`claudeDirEnv`). */
  envFor(claudeDirId: number): Record<string, string> | undefined;
  /** The directory a session belongs to. */
  dirOf(sessionId: string): number;
}

const SINGLE_DIR: LimitsClaudeDirs = {
  list: () => [{ id: FIRST_CLAUDE_DIR_ID, name: '' }],
  envFor: () => undefined,
  dirOf: () => FIRST_CLAUDE_DIR_ID,
};

/** One directory's last reading of its plan, and the read in flight. */
interface DirReading {
  windows: LimitWindow[];
  extraUsage: ExtraUsage | null;
  /** False once the server said plan limits do not apply to this account. */
  serverTracked: boolean;
  readAt: number | null;
  stale: boolean;
  refreshing: Promise<void> | null;
}

/** One stored wait, as this service holds it. */
interface StoredWait {
  sessionId: string;
  resetsAt: number;
  windowKind: string;
  windowLabel: string;
  cancelled: boolean;
  queued: QueuedMessage[];
}

export interface LimitsServiceDeps {
  db: OrbitalDb;
  hub: { publish(topic: string, payload: Record<string, unknown>): void };
  settings: { get(key: string): string };
  queryFn: QueryFn;
  /**
   * False with an API key: there are no plan windows, the probe never runs
   * and no session ever waits.
   */
  tracked: boolean;
  cwd?: string;
  claudeExecutablePath?: string | null;
  /**
   * The Claude directories, each with its own account and so its own plan
   * (spec 2026-10-04-multiple-claude-directories-design § 5). Absent (tests),
   * one directory, `FIRST_CLAUDE_DIR_ID`, probed in the SDK's default
   * environment.
   */
  claudeDirs?: LimitsClaudeDirs;
  /** Republishes one session's snapshot — `limitWait` rides on it. */
  republish: (sessionId: string) => void;
  /** Records a failure in the error log; never announced. */
  onError?: (err: unknown, during: string, sessionId?: string) => void;
  now?: () => number;
}

/**
 * Usage limits, server side (spec 2026-10-03-usage-limits-design): the
 * probe's cached answer and its refresh, and the waits — made when a turn ends
 * on the limit, stored, and fired at the window's reset.
 *
 * `deliver` is assigned by the routes, which own the one path into a
 * session (send if live, revive if not). `start()` is called once it is.
 */
export class LimitsService {
  deliver?: (sessionId: string, text: string, attachments: string[]) => Promise<{ outcome: LimitDeliveryOutcome; uuid: string | null }>;

  private deps: LimitsServiceDeps;
  private now: () => number;
  private waits = new Map<string, StoredWait>();
  /** Per Claude directory, made on first use. */
  private readings = new Map<number, DirReading>();
  private dirs: LimitsClaudeDirs;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private firing: Promise<void> | null = null;
  private started = false;
  private disposed = false;
  private seq = 0;

  constructor(deps: LimitsServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.dirs = deps.claudeDirs ?? SINGLE_DIR;
  }

  // ---- Lifecycle --------------------------------------------------------

  /** Reads the stored waits. */
  load(): void {
    this.waits.clear();
    for (const row of this.deps.db.select().from(limitWaits).all()) {
      this.waits.set(row.sessionId, {
        sessionId: row.sessionId,
        resetsAt: row.resetsAt,
        windowKind: row.windowKind,
        windowLabel: row.windowLabel,
        cancelled: row.cancelled === 1,
        queued: Array.isArray(row.queued) ? row.queued : [],
      });
    }
  }

  /** Arms the wait timer; an overdue wait fires at once. */
  start(): void {
    this.started = true;
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.unwatch();
  }

  // ---- The limits view --------------------------------------------------

  /** Every configured directory's reading, each with the waits of its own sessions. */
  snapshot(): LimitsSnapshot {
    return { dirs: this.dirs.list().map((dir) => this.dirSnapshot(dir.id, dir.name)) };
  }

  private dirSnapshot(id: number, name: string): ClaudeDirLimits {
    const r = this.reading(id);
    const tracked = this.deps.tracked && r.serverTracked;
    return {
      id,
      name,
      tracked,
      readAt: r.readAt === null ? null : new Date(r.readAt).toISOString(),
      stale: r.stale,
      windows: tracked ? r.windows : [],
      extraUsage: tracked ? r.extraUsage : null,
      waits: [...this.waits.values()]
        .filter((w) => this.dirs.dirOf(w.sessionId) === id)
        .sort((a, b) => a.resetsAt - b.resetsAt)
        .map((w) => ({
          sessionId: w.sessionId,
          title: this.titleOf(w.sessionId),
          resetsAt: new Date(w.resetsAt).toISOString(),
          windowLabel: w.windowLabel,
          willContinue: this.willContinue(w),
        })),
    };
  }

  /** The cached answer at once; a read behind it for each directory whose answer is older than the interval. */
  get(): LimitsSnapshot {
    for (const { id } of this.dirs.list()) {
      const { readAt } = this.reading(id);
      if (readAt === null || this.now() - readAt >= LIMITS_REFRESH_INTERVAL_MS) void this.refresh(id);
    }
    return this.snapshot();
  }

  /**
   * Reads the probe again — one directory's, or every directory's when none
   * is named. Concurrent callers share one read per directory; never rejects.
   */
  refresh(claudeDirId?: number): Promise<void> {
    if (!this.deps.tracked) return Promise.resolve();
    if (claudeDirId === undefined) {
      return Promise.all(this.dirs.list().map(({ id }) => this.refresh(id))).then(() => undefined);
    }
    const r = this.reading(claudeDirId);
    if (r.refreshing) return r.refreshing;
    const wasStale = r.stale;
    r.refreshing = this.probe(claudeDirId)
      .then((answer) => {
        const reading = readUsageAnswer(answer);
        r.serverTracked = reading.tracked;
        r.windows = reading.windows;
        r.extraUsage = reading.extraUsage;
        r.readAt = this.now();
        r.stale = false;
      })
      .catch((err) => {
        r.stale = true;
        // One line per outage, not one per read.
        if (!wasStale) this.deps.onError?.(err, 'reading the plan limits');
      })
      .finally(() => {
        r.refreshing = null;
        this.publishLimits();
      });
    return r.refreshing;
  }

  /** A directory was removed: its reading goes with it. */
  forgetDir(claudeDirId: number): void {
    this.readings.delete(claudeDirId);
    this.publishLimits();
  }

  private reading(claudeDirId: number): DirReading {
    let r = this.readings.get(claudeDirId);
    if (!r) {
      r = { windows: [], extraUsage: null, serverTracked: true, readAt: null, stale: false, refreshing: null };
      this.readings.set(claudeDirId, r);
    }
    return r;
  }

  /** Someone opened the view: read now and every interval until `unwatch`. */
  watch(): void {
    if (this.watchTimer || !this.deps.tracked) return;
    void this.refresh();
    this.watchTimer = setInterval(() => void this.refresh(), LIMITS_REFRESH_INTERVAL_MS);
    (this.watchTimer as unknown as { unref?: () => void }).unref?.();
  }

  unwatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /** A running session heard a `rate_limit_event`: its own directory's plan is read again. */
  rateLimitEvent(sessionId: string): void {
    void this.refresh(this.dirs.dirOf(sessionId));
  }

  // ---- Waits ------------------------------------------------------------

  waitFor(sessionId: string): LimitWait | null {
    const w = this.waits.get(sessionId);
    if (!w) return null;
    return {
      resetsAt: new Date(w.resetsAt).toISOString(),
      windowKind: w.windowKind,
      windowLabel: w.windowLabel,
      cancelled: w.cancelled,
      willContinue: this.willContinue(w),
      queued: w.queued.map((q) => q.text),
      autoContinue: autoContinueOf(this.deps.settings.get(AUTO_CONTINUE_KEY)),
      continueText: continueTextOf(this.deps.settings.get(CONTINUE_TEXT_KEY)),
    };
  }

  isWaiting(sessionId: string): boolean {
    return this.waits.has(sessionId);
  }

  /**
   * A main turn ended after a rejected event. Makes the wait when the turn
   * ended on the limit error and a reset time is known — from the event, else
   * from a fresh probe read. A wait already standing keeps what the user
   * queued on it. True when a wait was made.
   */
  async limitHit(sessionId: string, rejected: RejectedLimit, turnError: string | null): Promise<boolean> {
    if (!this.deps.tracked || turnError !== 'rate_limit') return false;
    // The session's own account's windows: a work session waits for the
    // work plan's reset, not the personal one's.
    const dir = this.dirs.dirOf(sessionId);
    if (rejected.resetsAt === null) await this.refresh(dir);
    const made = waitFromLimitHit(rejected, turnError, (type) => probeResetFor(type, this.reading(dir).windows));
    if (!made) return false;
    const prior = this.waits.get(sessionId);
    this.store({
      sessionId,
      resetsAt: made.resetsAt,
      windowKind: made.windowKind,
      windowLabel: made.windowLabel,
      cancelled: false,
      queued: prior?.queued ?? [],
    }, prior === undefined);
    this.changed(sessionId);
    this.schedule();
    return true;
  }

  /** A message written to a waiting session: kept for the reset. False when there is no wait. */
  queue(sessionId: string, text: string, attachments?: string[]): boolean {
    const w = this.waits.get(sessionId);
    if (!w) return false;
    w.queued = [...w.queued, attachments?.length ? { text, attachments } : { text }];
    this.deps.db.update(limitWaits).set({ queued: w.queued }).where(eq(limitWaits.sessionId, sessionId)).run();
    this.changed(sessionId);
    return true;
  }

  /** Cancel (true) or Undo (false) auto-continue for this wait. False when there is no wait. */
  setCancelled(sessionId: string, cancelled: boolean): boolean {
    const w = this.waits.get(sessionId);
    if (!w) return false;
    if (w.cancelled !== cancelled) {
      w.cancelled = cancelled;
      this.deps.db.update(limitWaits).set({ cancelled: cancelled ? 1 : 0 })
        .where(eq(limitWaits.sessionId, sessionId)).run();
      this.changed(sessionId);
    }
    return true;
  }

  /**
   * The auto-continue switch or the continuation text changed. Both apply to
   * sessions already waiting, so each one is republished with its new
   * `willContinue`, `autoContinue` and `continueText`.
   */
  settingsChanged(): void {
    for (const sessionId of this.waits.keys()) this.deps.republish(sessionId);
    this.publishLimits();
  }

  /** The session ended: its wait goes, unfired. */
  drop(sessionId: string): void {
    if (!this.remove(sessionId)) return;
    this.changed(sessionId);
    this.schedule();
  }

  /** Fires every wait that is due. Concurrent calls share one pass. */
  fireDue(): Promise<void> {
    if (this.firing) return this.firing;
    this.firing = (async () => {
      const now = this.now();
      const due = [...this.waits.values()].filter((w) => w.resetsAt + RESET_GRACE_MS <= now);
      for (const w of due) await this.fire(w);
    })().finally(() => {
      this.firing = null;
      this.schedule();
    });
    return this.firing;
  }

  // ---- Internals --------------------------------------------------------

  private willContinue(w: StoredWait): boolean {
    return autoContinueOf(this.deps.settings.get(AUTO_CONTINUE_KEY)) && !w.cancelled;
  }

  private titleOf(sessionId: string): string {
    return this.deps.db.select({ title: sessions.title }).from(sessions)
      .where(eq(sessions.id, sessionId)).get()?.title ?? '';
  }

  private store(w: StoredWait, isNew: boolean): void {
    this.waits.set(w.sessionId, w);
    const values = {
      resetsAt: w.resetsAt, windowKind: w.windowKind, windowLabel: w.windowLabel,
      cancelled: w.cancelled ? 1 : 0, queued: w.queued,
    };
    this.deps.db.insert(limitWaits)
      .values({ sessionId: w.sessionId, createdAt: this.now(), ...values })
      .onConflictDoUpdate({ target: limitWaits.sessionId, set: isNew ? { ...values, createdAt: this.now() } : values })
      .run();
  }

  private remove(sessionId: string): boolean {
    const had = this.waits.delete(sessionId);
    this.deps.db.delete(limitWaits).where(eq(limitWaits.sessionId, sessionId)).run();
    return had;
  }

  private changed(sessionId: string): void {
    this.deps.republish(sessionId);
    this.publishLimits();
  }

  private publishLimits(): void {
    if (this.disposed) return;
    this.deps.hub.publish(LIMITS_TOPIC, { event: 'limits', limits: this.snapshot() });
  }

  private schedule(): void {
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    if (!this.started || this.disposed || this.waits.size === 0) return;
    let earliest = Infinity;
    for (const w of this.waits.values()) earliest = Math.min(earliest, w.resetsAt + RESET_GRACE_MS);
    const delay = Math.max(0, Math.min(earliest - this.now(), WAIT_CHECK_INTERVAL_MS));
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null;
      void this.fireDue();
    }, delay);
    (this.waitTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * One wait firing (spec § Firing): it ends first — so a send that hits the
   * limit again can make a new one — then sends what `whatFiringSends` says,
   * and leaves the divider on the session's topic.
   */
  private async fire(w: StoredWait): Promise<void> {
    this.remove(w.sessionId);
    const row = this.deps.db.select({ endedAt: sessions.endedAt }).from(sessions)
      .where(eq(sessions.id, w.sessionId)).get();
    if (!row || row.endedAt !== null) {
      this.changed(w.sessionId);
      return;
    }
    const send = whatFiringSends(w, {
      autoContinue: autoContinueOf(this.deps.settings.get(AUTO_CONTINUE_KEY)),
      continueText: continueTextOf(this.deps.settings.get(CONTINUE_TEXT_KEY)),
    });
    const topic = `session:${w.sessionId}`;
    const resetsAt = new Date(w.resetsAt).toISOString();
    const notice: ChatMessage = {
      id: `${w.sessionId}:limit-reset:${++this.seq}`,
      role: 'notice',
      timestamp: new Date(this.now()).toISOString(),
      text: send ? 'Limit reset · continued' : 'Limit reset',
      notice: {
        level: 'info',
        kind: 'limit_reset',
        limitReset: { resetsAt, windowLabel: w.windowLabel, continued: send !== null, sent: send?.text ?? null },
      },
    };
    this.deps.hub.publish(topic, { event: 'message', message: notice });
    if (send && this.deliver) {
      try {
        const delivery = await this.deliver(w.sessionId, send.text, send.attachments);
        // Orbital's own sends are not replayed by the SDK; the composer holds
        // its copy, but nobody typed this one now, so the turn is published.
        if (delivery.outcome === 'sent' || delivery.outcome === 'revived') {
          const turn: ChatMessage = {
            id: `${w.sessionId}:limit-sent:${this.seq}`,
            role: 'user',
            text: send.text,
            timestamp: new Date(this.now()).toISOString(),
            ...(delivery.uuid ? { uuid: delivery.uuid } : {}),
          };
          this.deps.hub.publish(topic, { event: 'message', message: turn });
        }
      } catch (err) {
        this.deps.onError?.(err, 'continuing after a usage limit reset', w.sessionId);
      }
    }
    this.changed(w.sessionId);
  }

  private async probe(claudeDirId: number): Promise<unknown> {
    // Never yields, so the CLI parks on stdin and no turn is ever billed —
    // the model catalogue's probe (adr models-come-from-the-sdk).
    async function* silent(): AsyncGenerator<never> {
      await new Promise<never>(() => {});
    }
    const options: Record<string, unknown> = {
      cwd: this.deps.cwd ?? process.cwd(),
      permissionMode: 'plan',
      persistSession: false,
    };
    if (this.deps.claudeExecutablePath) options.pathToClaudeCodeExecutable = this.deps.claudeExecutablePath;
    const env = this.dirs.envFor(claudeDirId);
    if (env) options.env = env;
    const q = this.deps.queryFn({ prompt: silent(), options });
    try {
      const ask = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (!ask) throw new Error('this Claude Code cannot report usage');
      return await withTimeout(ask.call(q, { skipBehaviors: true }), LIMITS_PROBE_TIMEOUT_MS);
    } finally {
      try {
        await q.return?.(undefined);
      } catch {
        // The probe process is done with either way.
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`limits probe timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}
