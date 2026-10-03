import { eq } from 'drizzle-orm';
import type { OrbitalDb } from '../db/database.js';
import { limitWaits, sessions } from '../db/schema.js';
import type { QueryFn } from '../runner/runner.js';
import type { ChatMessage } from '../types.js';
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
  private windows: LimitWindow[] = [];
  private extraUsage: ExtraUsage | null = null;
  private serverTracked = true;
  private readAt: number | null = null;
  private stale = false;
  private refreshing: Promise<void> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private firing: Promise<void> | null = null;
  private started = false;
  private disposed = false;
  private seq = 0;

  constructor(deps: LimitsServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
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

  snapshot(): LimitsSnapshot {
    const tracked = this.deps.tracked && this.serverTracked;
    return {
      tracked,
      readAt: this.readAt === null ? null : new Date(this.readAt).toISOString(),
      stale: this.stale,
      windows: tracked ? this.windows : [],
      extraUsage: tracked ? this.extraUsage : null,
      waits: [...this.waits.values()]
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

  /** The cached answer at once; a read behind it when the answer is older than the interval. */
  get(): LimitsSnapshot {
    if (this.readAt === null || this.now() - this.readAt >= LIMITS_REFRESH_INTERVAL_MS) void this.refresh();
    return this.snapshot();
  }

  /** Reads the probe again. Concurrent callers share one read; never rejects. */
  refresh(): Promise<void> {
    if (!this.deps.tracked) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const wasStale = this.stale;
    this.refreshing = this.probe()
      .then((answer) => {
        const reading = readUsageAnswer(answer);
        this.serverTracked = reading.tracked;
        this.windows = reading.windows;
        this.extraUsage = reading.extraUsage;
        this.readAt = this.now();
        this.stale = false;
      })
      .catch((err) => {
        this.stale = true;
        // One line per outage, not one per read.
        if (!wasStale) this.deps.onError?.(err, 'reading the plan limits');
      })
      .finally(() => {
        this.refreshing = null;
        this.publishLimits();
      });
    return this.refreshing;
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

  /** A running session heard a `rate_limit_event`. */
  rateLimitEvent(): void {
    void this.refresh();
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
    if (rejected.resetsAt === null) await this.refresh();
    const made = waitFromLimitHit(rejected, turnError, (type) => probeResetFor(type, this.windows));
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
   * The auto-continue switch changed. It applies to sessions already
   * waiting, so each one is republished with its new `willContinue`.
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

  private async probe(): Promise<unknown> {
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
