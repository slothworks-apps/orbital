import type { TranscriptEntry } from './parser.js';
import type { ChatMessage } from '../types.js';

export interface SubagentInfo {
  id: string;
  name: string;
  state: 'working' | 'ended';
  /**
   * The `Agent` tool_use this agent was launched from, when it is known —
   * only the SDK's task events carry it. Kept so a live agent can be joined
   * back to the tool block in the transcript, and so a notification that
   * names a task the tracker never saw can still find its agent.
   */
  toolUseId?: string;
  /**
   * Epoch ms when this agent was first seen. Stamped once, at creation — a
   * resumed `task_started` (see below) does not restart the clock, because
   * the moon it draws is the same moon that has been on the map since it
   * first launched (task-3 brief § "SubagentInfo gains two fields").
   */
  startedAt: number;
  /**
   * How the agent ended, read off `task_notification`'s own `status` field.
   * Absent while it runs, and — this is the case worth pausing on — still
   * absent once `state` has already become `'ended'`, when a
   * `background_tasks_changed` retirement closed the agent out because its
   * notification never arrived. `state` answers "is it still going";
   * `status` answers "how did it go", and the retirement path can only
   * honestly answer the first (spec § "SubagentInfo gains two fields").
   */
  status?: 'completed' | 'failed' | 'stopped';
  /**
   * The user dismissed this agent's MOON. Set (and only ever set to `true`)
   * by `SubagentStore.all()` as it reads the dismissal set beside the
   * tracker — never by `SubagentTracker`, which stays a pure record of what
   * the SDK said happened.
   *
   * A marker, not a subtraction, because dismissal is a fact about the MAP
   * and nothing else (spec § 4: "a set of subagent ids held beside the
   * buffer"). `all()` used to filter these agents out, which also took the
   * parent transcript's `OPEN →` control away and 404'd the messages route
   * — both of which the spec says the opposite of, twice (§ 5 "still
   * reachable … after the moon has been dismissed", § 8 "Moon dismissed |
   * That moon leaves the map; the row's `OPEN →` still works"). The buffer
   * was never gone; it was only walled off. `web/src/map/sceneModel.ts` is
   * now the one place that reads this flag.
   */
  dismissed?: boolean;
}

/**
 * The tool names that spawn a subagent. Claude Code 2.1.236 calls it `Agent`;
 * `Task` is what earlier versions called the same thing, and transcripts
 * written by them are still on disk. Both are accepted, because a version bump
 * renaming this silently is exactly how this detection broke the first time.
 */
export const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/** `task_type` of a spawned subagent; background shells and workflows wear other values. */
const SUBAGENT_TASK_TYPE = 'local_agent';

export interface TaskStartedEvent {
  type: 'system';
  subtype: 'task_started';
  task_id: string;
  tool_use_id?: string;
  description: string;
  subagent_type?: string;
  task_type?: string;
  is_backgrounded?: boolean;
  spawn_depth?: number;
  ambient?: boolean;
  session_id: string;
}

export interface TaskNotificationEvent {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  summary: string;
  session_id: string;
}

export interface BackgroundTasksChangedEvent {
  type: 'system';
  subtype: 'background_tasks_changed';
  tasks: Array<{ task_id: string; task_type: string; description: string; ambient?: boolean }>;
  session_id: string;
}

/**
 * The three `system` messages that describe a task's life on the SDK stream.
 *
 * Restated structurally instead of imported from
 * `@anthropic-ai/claude-agent-sdk`: the SDK's own types require fields this
 * code never reads (`uuid`, `output_file`), which every fake stream in the
 * tests would then have to invent. The field names are the SDK's exactly, so
 * a real message satisfies these without translation.
 */
export type TaskEvent = TaskStartedEvent | TaskNotificationEvent | BackgroundTasksChangedEvent;

/** The subtypes `Runner.pump()` forwards; anything else on `system` is not about a task. */
export const TASK_EVENT_SUBTYPES: ReadonlySet<string> = new Set([
  'task_started',
  'task_notification',
  'background_tasks_changed',
]);

/**
 * True for a `task_started` that is a subagent someone should see a moon for.
 *
 * `local_bash` (a background shell) and `local_workflow` arrive as the same
 * message and are not agents; `ambient` marks the CLI's own housekeeping,
 * which the SDK asks hosts to keep out of activity indicators. A stream that
 * omits `task_type` altogether leaves `subagent_type` as the only tell.
 */
function isSubagentTask(msg: TaskStartedEvent): boolean {
  if (msg.ambient) return false;
  if (msg.task_type === undefined) return msg.subagent_type !== undefined;
  return msg.task_type === SUBAGENT_TASK_TYPE;
}

/**
 * Tracks subagents across multiple batches, from two independent inputs.
 *
 * `feedTask()` is the live one and the only one that can be trusted while an
 * agent works: Claude Code runs `Agent` in the background by default, so the
 * `tool_result` for the launch comes back in milliseconds and says only that
 * the agent started. The SDK's `task_started` / `task_notification` pair
 * brackets the real work instead (adr: subagent-liveness-from-sdk-task-events).
 *
 * `feed()` is the after-the-fact record read out of a transcript, which is all
 * a terminal session can offer. It is kept on its own keyspace — tool_use ids,
 * where the task events use task ids — so the launch result of an agent known
 * from `feedTask()` cannot retire it.
 *
 * Either way state must persist across calls rather than being recomputed per
 * batch: the two edges of an agent's life arrive minutes apart, in separate
 * batches, so a tracker rebuilt per call would never see a transition at all.
 */
export class SubagentTracker {
  private agents = new Map<string, SubagentInfo>();
  /**
   * Task ids that registered as background work. Remembered rather than
   * re-derived, because `background_tasks_changed` lists only background
   * tasks: a foreground agent is absent from every one of those payloads and
   * retiring on absence would kill it the moment any other task changed.
   */
  private backgrounded = new Set<string>();

  /** Feed one batch of entries; returns only the agents whose state changed (or was newly created) in this call. */
  feed(entries: TranscriptEntry[]): SubagentInfo[] {
    const touched = new Set<string>();
    for (const e of entries) {
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_use' && SUBAGENT_TOOLS.has(String(block.name))) {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const name =
            (typeof input.description === 'string' && input.description) ||
            (typeof input.subagent_type === 'string' && input.subagent_type) ||
            'subagent';
          const id = String(block.id);
          // `feed()` is the after-the-fact transcript path (see the class
          // comment) but `SubagentInfo.startedAt` holds everywhere, so it
          // gets stamped here too — `Date.now()` at read time is the closest
          // this path can get to when the agent actually started.
          this.agents.set(id, { id, name, state: 'working', startedAt: Date.now() });
          touched.add(id);
        } else if (block.type === 'tool_result') {
          const id = String(block.tool_use_id);
          const existing = this.agents.get(id);
          if (existing) {
            existing.state = 'ended';
            touched.add(id);
          }
        }
      }
    }
    return [...touched].map((id) => this.agents.get(id)!);
  }

  /** Feed one task lifecycle message; returns only the agents whose state changed (or was newly created) in this call. */
  feedTask(msg: TaskEvent): SubagentInfo[] {
    if (msg.subtype === 'task_started') {
      if (!isSubagentTask(msg)) return [];
      // A second `task_started` for a known task is a resume, and putting it
      // straight back to `working` is most of the handling that needs — but
      // `startedAt` is carried over rather than restamped, because a resume
      // is the same agent's clock still running, not a new one starting.
      // Building a fresh object (rather than mutating the old one) is also
      // what drops a stale `status`: an agent going back to work has, by
      // definition, not ended the way its last notification said it did.
      const existing = this.agents.get(msg.task_id);
      const agent: SubagentInfo = {
        id: msg.task_id,
        name: msg.description || msg.subagent_type || 'subagent',
        state: 'working',
        startedAt: existing?.startedAt ?? Date.now(),
      };
      if (msg.tool_use_id) agent.toolUseId = msg.tool_use_id;
      this.agents.set(agent.id, agent);
      if (msg.is_backgrounded) this.backgrounded.add(agent.id);
      else this.backgrounded.delete(agent.id);
      return [agent];
    }

    if (msg.subtype === 'task_notification') {
      // Any status ends the moon: failed and stopped are just as finished as
      // completed, and `state` folds all three into the same `'ended'` — but
      // `status` keeps the distinction the notification actually reported,
      // because that is exactly what a dismissed-vs-still-there moon needs
      // to show once ended agents stop vanishing from `all()` (task-3 brief
      // §§1, 3).
      const agent = this.agents.get(msg.task_id) ?? this.byToolUseId(msg.tool_use_id);
      if (!agent) return [];
      agent.state = 'ended';
      agent.status = msg.status;
      return [agent];
    }

    // The safety net for a `task_notification` that never arrives. Only
    // agents last seen as backgrounded can be judged by this payload, and an
    // id in it that we do not know is ignored: the SDK does not order it
    // against `task_started`, so an unknown id may simply be one step ahead.
    const live = new Set(msg.tasks.map((t) => t.task_id));
    const retired: SubagentInfo[] = [];
    for (const agent of this.agents.values()) {
      if (agent.state !== 'working') continue;
      if (!this.backgrounded.has(agent.id) || live.has(agent.id)) continue;
      agent.state = 'ended';
      // Deliberately no `status` write here. This branch exists because a
      // `task_notification` never arrived — that message is the only source
      // `status` has — so leaving it unset is the honest answer; writing a
      // guessed 'completed' would claim knowledge this path does not have
      // (task-3 brief §1).
      retired.push(agent);
    }
    return retired;
  }

  /** Every agent this tracker has seen that has not reported a result yet. */
  running(): SubagentInfo[] {
    return [...this.agents.values()].filter((a) => a.state === 'working');
  }

  /** Every agent this tracker has ever seen, running and ended alike. */
  all(): SubagentInfo[] {
    return [...this.agents.values()];
  }

  private byToolUseId(toolUseId: string | undefined): SubagentInfo | undefined {
    if (!toolUseId) return undefined;
    return [...this.agents.values()].find((a) => a.toolUseId === toolUseId);
  }
}

/** One-shot convenience wrapper over `SubagentTracker` for callers with a single, complete batch of entries. */
export function trackSubagents(entries: TranscriptEntry[]): SubagentInfo[] {
  return new SubagentTracker().feed(entries);
}

/**
 * The server's single source of truth for what to say about a session's
 * subagents, keyed by session. The SDK runner feeds it the task events of
 * the sessions orbital owns, and everything that reports subagents
 * (`toApiSession`, and through it both the REST shape and the `sessions`
 * topic) reads it. `feed` stays for the transcript record a terminal session
 * leaves behind, which no live surface can use.
 *
 * Two read methods answer two different questions (task-3 brief §2):
 * `running()` is "is this session still waiting on an agent" —
 * `hasLiveSubagents` in index.ts is built on it, and ended agents must never
 * leak into it, or a session whose agents all finished would hang at
 * `working` forever. `all()` is "every agent this session has ever had" — a
 * moon outlives its agent until the user dismisses it (spec § "Moons
 * outlive their agents"), so it includes ended agents, and it includes
 * DISMISSED ones too, MARKED rather than removed: dismissal is a fact about
 * the map alone, and the map is the only reader entitled to act on it (adr:
 * dismissal-marks-the-agent-only-the-map-reads-it).
 *
 * Every mutator — the two feeders and `dismiss()` — returns whether `all()`
 * changed rather than which agents were touched: callers turn that into
 * "republish this session", and a message that moves nothing must not cause
 * a publish.
 */
export class SubagentStore {
  private trackers = new Map<string, SubagentTracker>();
  /**
   * Ids the user has dismissed, per session. Kept as its own map rather than
   * inside `SubagentTracker` because dismissal is a fact about what the UI
   * has already shown, not about the agent's own lifecycle — the tracker
   * stays a pure record of what the SDK said happened.
   */
  private dismissed = new Map<string, Set<string>>();

  /** Feed one batch of entries for a session; true if `all()` would now answer differently. */
  feed(sessionId: string, entries: TranscriptEntry[]): boolean {
    return this.apply(sessionId, (tracker) => tracker.feed(entries));
  }

  /** Feed one task lifecycle message for a session; true if `all()` would now answer differently. */
  feedTask(sessionId: string, msg: TaskEvent): boolean {
    return this.apply(sessionId, (tracker) => tracker.feedTask(msg));
  }

  /** The session's still-running subagents — what `hasLiveSubagents` answers off. Ended agents are never here. */
  running(sessionId: string): SubagentInfo[] {
    return this.trackers.get(sessionId)?.running() ?? [];
  }

  /**
   * Every agent the session has ever seen, ended included — dismissed ones
   * among them, MARKED with `dismissed: true` rather than subtracted.
   *
   * The subtraction was the bug: this list is what `toApiSession` puts on
   * the wire, and the client reads it for three different things — the map's
   * moons, the parent transcript's `OPEN →` control, and (server-side, via
   * the messages route's `known` check) whether a buffer may be served at
   * all. Dismissal is only ever about the first of the three. Filtering here
   * took all three away at once, so a dismissed agent's transcript became
   * unreachable and the route answered 404 — "the server lost this agent's
   * buffer", about a buffer still sitting in memory.
   *
   * `SubagentTranscripts` is untouched by dismissal and always was; this
   * method is now the only thing that ever stood between it and a reader.
   */
  all(sessionId: string): SubagentInfo[] {
    const agents = this.trackers.get(sessionId)?.all() ?? [];
    const dismissed = this.dismissed.get(sessionId);
    if (!dismissed || dismissed.size === 0) return agents;
    return agents.map((a) => (dismissed.has(a.id) ? { ...a, dismissed: true } : a));
  }

  /**
   * Marks one agent dismissed for the rest of the session's life — the user
   * dismissed its moon. Keyed by `SubagentInfo.id` (the task id), not
   * `toolUseId`: the SDK makes `toolUseId` optional (only task events carry
   * it at all), while `id` always exists (task-3 brief §4). Goes through the
   * same before/after diff as the feeders so the caller learns to republish
   * and the moon actually leaves the map.
   *
   * Dismissing an id the session has never seen is a no-op — not an error,
   * and not recorded, so it cannot pre-emptively swallow some future agent
   * that happens to reuse the id.
   */
  dismiss(sessionId: string, agentId: string): boolean {
    const tracker = this.trackers.get(sessionId);
    if (!tracker || !tracker.all().some((a) => a.id === agentId)) return false;
    const before = this.all(sessionId);
    let ids = this.dismissed.get(sessionId);
    if (!ids) {
      ids = new Set();
      this.dismissed.set(sessionId, ids);
    }
    ids.add(agentId);
    return !sameAgents(before, this.all(sessionId));
  }

  /** Forget a session entirely — it ended, so nothing of it, running or dismissed, still applies. */
  drop(sessionId: string): void {
    this.trackers.delete(sessionId);
    this.dismissed.delete(sessionId);
  }

  private apply(sessionId: string, mutate: (tracker: SubagentTracker) => unknown): boolean {
    let tracker = this.trackers.get(sessionId);
    if (!tracker) {
      tracker = new SubagentTracker();
      this.trackers.set(sessionId, tracker);
    }
    // Snapshotted with `{ ...a }`, not just `this.all(sessionId)`: the
    // tracker mutates each `SubagentInfo` IN PLACE (a `task_notification`
    // flips `state`/`status` on the very object already sitting in its Map),
    // so an unspread `before` would hold the same references `mutate` is
    // about to change — `sameAgents` would then be comparing every agent to
    // itself and never see a difference, no matter how widened the fields it
    // checks are. This is the aliasing half of the task-3 §3 bug: fixing
    // only which fields `sameAgents` compares is not enough on its own.
    const before = this.all(sessionId).map((a) => ({ ...a }));
    mutate(tracker);
    return !sameAgents(before, this.all(sessionId));
  }
}

/**
 * Equality for republish decisions, over whatever `all()` returns. Widened
 * past id-only membership — which was correct back when this only ever
 * compared `running()` — because ended agents now live in `all()` too: an
 * agent finishing changes no member of the set (same id, same length), so an
 * id-only compare would call that "no change" and the map would never learn
 * the moon went grey. Comparing `state` and `status` as well means that
 * exact transition — id present before and after, only its state and status
 * moved — IS a change (task-3 brief §3, the republish-detection bug this
 * exists to catch).
 *
 * `dismissed` is compared for the same reason one step later: now that
 * `all()` MARKS a dismissed agent instead of dropping it, dismissal no
 * longer changes the list's length either, and an id+state+status compare
 * would call it "no change" — the map would keep drawing a moon the user
 * just dismissed.
 */
function sameAgents(a: SubagentInfo[], b: SubagentInfo[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (agent, i) =>
        agent.id === b[i].id &&
        agent.state === b[i].state &&
        agent.status === b[i].status &&
        Boolean(agent.dismissed) === Boolean(b[i].dismissed),
    )
  );
}

/**
 * Per-agent slice `SubagentTranscripts` hands back: the buffered messages in
 * publish order, and how many earlier ones were evicted to make room. Both
 * numbers ride together because canvas 11c states them together — "the first
 * 1 184 steps of this run were dropped" beside "buffer 2 000 steps" — and a
 * caller that only wanted one would still have to compute the other from the
 * same object.
 */
export interface SubagentTranscript {
  messages: ChatMessage[];
  droppedCount: number;
}

/**
 * Cap on how many `ChatMessage`s `SubagentTranscripts` keeps per agent.
 *
 * Comfortably above anything measured so far — the largest subagent
 * transcript found on disk while writing this spec was ~100 kB across a few
 * hundred entries — and low enough that one runaway agent, forwarding its
 * whole conversation because `forwardSubagentText` is on, cannot grow the
 * server without bound. Exported so the eviction test can assert the exact
 * number rather than a value copied by hand into two places.
 */
export const MAX_SUBAGENT_MESSAGES = 2000;

/**
 * Buffers each subagent's own transcript — the messages `pump()` routes off
 * `parent_tool_use_id` instead of onto `session:<id>` (spec
 * `2026-09-22-subagent-transcript-panel-design.md` §§ "The bug this
 * uncovers" and 3). Keyed by `sessionId` then by the `Agent` `tool_use` id
 * that started the agent — the same id `SubagentInfo.toolUseId` carries, so
 * a moon or an `OPEN →` row joins straight to a buffer with no translation.
 *
 * **Lifetime is the session's, not the agent's — this is the whole reason
 * the class exists rather than living inside `SubagentTracker`.** A
 * `SubagentTracker` forgets nothing either, but `SubagentStore.get()` only
 * ever surfaces `running()`, so nothing here may key off `working`/`ended`:
 * an agent that reported back keeps its buffer, because the panel stays
 * open on the finished agent's last transcript, and because a panel opened
 * mid-run needs whatever already streamed before it was opened, not just
 * what streams from then on. `drop(sessionId)` is the only way a buffer
 * dies, called wherever `SubagentStore.drop` already is (the session
 * ended, so nothing can join a new buffer to it again).
 *
 * A ring buffer per agent, not an unbounded array: eviction happens from
 * the FRONT (the oldest steps, least useful once a run is long) and
 * `droppedCount` is a running total rather than a boolean, because the UI
 * states an exact count, not just "something was cut".
 */
export class SubagentTranscripts {
  private bySession = new Map<string, Map<string, SubagentTranscript>>();

  /**
   * Appends one frame's worth of messages to an agent's buffer, evicting
   * from the front if the cap is exceeded.
   *
   * Takes the whole batch `sdkToChatMessages` returns for one SDK frame
   * rather than one `ChatMessage` at a time: a single frame can carry
   * several blocks (text plus a tool_use, say), and splitting the eviction
   * check across them would let a mid-frame boundary sit between two
   * messages that were published in the same instant.
   */
  append(sessionId: string, toolUseId: string, messages: ChatMessage[]): void {
    if (messages.length === 0) return;
    let agents = this.bySession.get(sessionId);
    if (!agents) {
      agents = new Map();
      this.bySession.set(sessionId, agents);
    }
    let entry = agents.get(toolUseId);
    if (!entry) {
      entry = { messages: [], droppedCount: 0 };
      agents.set(toolUseId, entry);
    }
    entry.messages.push(...messages);
    const over = entry.messages.length - MAX_SUBAGENT_MESSAGES;
    if (over > 0) {
      entry.messages.splice(0, over);
      entry.droppedCount += over;
    }
  }

  /** The buffer for one agent, or `undefined` when that session/toolUseId pair has never been appended to. */
  get(sessionId: string, toolUseId: string): SubagentTranscript | undefined {
    return this.bySession.get(sessionId)?.get(toolUseId);
  }

  /** Forgets every agent of a session — the session ended, so no frame can ever join a new buffer to it. */
  drop(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
