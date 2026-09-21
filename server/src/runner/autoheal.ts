import type { SessionStatus } from '../types.js';

/**
 * How many sessions one boot may bring back. A restart during a busy
 * afternoon can leave a dozen rows flagged, and every heal forks a `claude`
 * process; beyond a handful the boot costs more than it saves. The overflow
 * is not silently dropped — it expires and is named in the log.
 */
export const AUTOHEAL_CAP = 10;

/**
 * The window to use when `ended_after_idle_minutes` is `IDLE_NEVER` and there
 * is none to borrow. Without a ceiling, the first boot after a week away
 * would resurrect every session Orbital has ever run.
 */
export const AUTOHEAL_NEVER_CEILING_MS = 6 * 60 * 60_000;

/** What the plan needs to know about one session row. */
export interface AutohealRow {
  id: string;
  /**
   * The status the Runner last held for this session, or null when it does
   * not own it. A graceful end clears it and a kill cannot, which is the
   * whole signal — see the spec `2026-09-21-session-autoheal-design`.
   */
  runnerStatus: SessionStatus | null;
  lastAt: number | null;
}

export interface AutohealPlan {
  /** Resume these, newest first. */
  heal: string[];
  /** The subset of `heal` that was cut off mid-turn. */
  interrupted: string[];
  /** Clear the flag and leave these ended. */
  expired: string[];
}

/** Statuses a session the Runner owns can actually be in. */
const OWNED: ReadonlySet<string> = new Set<SessionStatus>(['working', 'needs_input', 'idle']);

/**
 * Decides what a booting server does with the sessions its predecessor was
 * still running.
 *
 * A candidate heals when it is young enough that the idle timer would not
 * have ended it yet: the restart is made not to have happened, using the
 * window the user already chose rather than a second setting asking the same
 * question. Everything else expires — its flag is cleared and it reads
 * `ended`, which is where the idle timer was taking it anyway.
 *
 * Deliberately total. A row whose `runnerStatus` is not a status a live
 * session can hold is not a candidate at all, and one with no `lastAt`
 * expires rather than being guessed fresh: no recorded activity is no
 * evidence of recent activity, and the cost of being wrong that way is a
 * message away (the send path revives it), where the other way spawns a CLI
 * for a session nobody is coming back to.
 */
export function planAutoheal(opts: {
  rows: AutohealRow[];
  now: number;
  /** `null` is `IDLE_NEVER`, which borrows `AUTOHEAL_NEVER_CEILING_MS`. */
  idleTimeoutMs: number | null;
  cap?: number;
}): AutohealPlan {
  const { rows, now, idleTimeoutMs } = opts;
  const cap = opts.cap ?? AUTOHEAL_CAP;
  const window = idleTimeoutMs ?? AUTOHEAL_NEVER_CEILING_MS;

  const candidates = rows.filter((r) => r.runnerStatus !== null && OWNED.has(r.runnerStatus));
  const fresh: AutohealRow[] = [];
  const expired: string[] = [];
  for (const r of candidates) {
    if (r.lastAt !== null && now - r.lastAt < window) fresh.push(r);
    else expired.push(r.id);
  }

  fresh.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  const healed = fresh.slice(0, cap);
  for (const r of fresh.slice(cap)) expired.push(r.id);

  return {
    heal: healed.map((r) => r.id),
    interrupted: healed.filter((r) => r.runnerStatus === 'working').map((r) => r.id),
    expired,
  };
}

/**
 * Carries out the plan at boot: resumes what should come back, marks what was
 * cut off mid-turn, and clears the flag on everything else so a later boot
 * cannot resurrect it.
 *
 * Resuming costs a `claude` process and nothing else. The prompt is empty, so
 * `Runner.start` enqueues no user message, the CLI parks on stdin, and the
 * session lands in `needs_input` — no turn runs and no tokens are spent until
 * someone types. The interrupted turn is deliberately not re-sent: its tool
 * calls have already had their effects, and replaying the prompt would spend
 * tokens nobody asked for to maybe repeat them.
 */
export async function runAutoheal(deps: {
  rows: AutohealRowToHeal[];
  now: number;
  idleTimeoutMs: number | null;
  /** Ids the terminal registry holds — live in a terminal, not ours to take over. */
  isLiveInTerminal: (sessionId: string) => boolean;
  /** A session whose working directory is gone cannot be resumed anywhere. */
  cwdExists: (cwd: string) => boolean;
  resume: (row: AutohealRowToHeal) => Promise<void>;
  /** Drops the Runner's claim on these rows. */
  clearClaim: (sessionIds: string[]) => void;
  /** Stamps the mid-turn mark. */
  markInterrupted: (sessionIds: string[], at: number) => void;
  report: (summary: AutohealSummary) => void;
}): Promise<void> {
  const plan = planAutoheal({ rows: deps.rows, now: deps.now, idleTimeoutMs: deps.idleTimeoutMs });
  deps.clearClaim(plan.expired);
  // Before the resume, not after: a heal that fails still happened to a
  // session whose turn was cut short, and the mark is about the turn.
  if (plan.interrupted.length) deps.markInterrupted(plan.interrupted, deps.now);

  const byId = new Map(deps.rows.map((r) => [r.id, r]));
  const skipped: string[] = [];
  const failed: string[] = [];
  const healed: string[] = [];

  const queue = plan.heal.slice();
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const row = byId.get(id);
      if (!row) continue;
      if (deps.isLiveInTerminal(id) || !deps.cwdExists(row.cwd)) {
        skipped.push(id);
        continue;
      }
      try {
        await deps.resume(row);
        healed.push(id);
      } catch {
        failed.push(id);
      }
    }
  };
  // Three at a time: a boot with ten healable sessions should not fork ten
  // CLIs at once, and nothing downstream is waiting on this to finish.
  await Promise.all([worker(), worker(), worker()]);

  // A session nobody could bring back must not keep its claim, or every
  // future boot would try again.
  deps.clearClaim([...skipped, ...failed]);

  if (healed.length || plan.interrupted.length) {
    deps.report({
      healed, interrupted: plan.interrupted, skipped, failed,
      droppedByCap: plan.expired.length,
    });
  }
}

/** One row, with everything `Runner.start` needs to resume it. */
export interface AutohealRowToHeal extends AutohealRow {
  cwd: string;
  permissionMode: string | null;
  model: string | null;
}

/** What one boot's autoheal did, for the log. */
export interface AutohealSummary {
  healed: string[];
  interrupted: string[];
  /** Live in a terminal, or their cwd is gone. */
  skipped: string[];
  failed: string[];
  /** How many candidates the window and the cap turned away. */
  droppedByCap: number;
}
