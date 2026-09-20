import type { TranscriptEntry } from './parser.js';

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
}

/**
 * The tool names that spawn a subagent. Claude Code 2.1.236 calls it `Agent`;
 * `Task` is what earlier versions called the same thing, and transcripts
 * written by them are still on disk. Both are accepted, because a version bump
 * renaming this silently is exactly how this detection broke the first time.
 */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

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
          this.agents.set(id, { id, name, state: 'working' });
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
      // straight back to `working` is the whole handling that needs.
      const agent: SubagentInfo = {
        id: msg.task_id,
        name: msg.description || msg.subagent_type || 'subagent',
        state: 'working',
      };
      if (msg.tool_use_id) agent.toolUseId = msg.tool_use_id;
      this.agents.set(agent.id, agent);
      if (msg.is_backgrounded) this.backgrounded.add(agent.id);
      else this.backgrounded.delete(agent.id);
      return [agent];
    }

    if (msg.subtype === 'task_notification') {
      // Any status ends the moon: failed and stopped are just as finished as
      // completed, and nothing downstream draws the difference.
      const agent = this.agents.get(msg.task_id) ?? this.byToolUseId(msg.tool_use_id);
      if (!agent) return [];
      agent.state = 'ended';
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
      retired.push(agent);
    }
    return retired;
  }

  /** Every agent this tracker has seen that has not reported a result yet. */
  running(): SubagentInfo[] {
    return [...this.agents.values()].filter((a) => a.state === 'working');
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
 * The server's single source of truth for "which subagents are running right
 * now", keyed by session. The SDK runner feeds it the task events of the
 * sessions orbital owns, and everything that reports subagents
 * (`toApiSession`, and through it both the REST shape and the `sessions`
 * topic) reads it. `feed` stays for the transcript record a terminal session
 * leaves behind, which no live surface can use.
 *
 * Both feeders return whether the *running* set changed rather than which
 * agents were touched: callers turn that into "republish this session", and a
 * message that moves nothing must not cause a publish.
 */
export class SubagentStore {
  private trackers = new Map<string, SubagentTracker>();

  /** Feed one batch of entries for a session; true if `get()` would now answer differently. */
  feed(sessionId: string, entries: TranscriptEntry[]): boolean {
    return this.apply(sessionId, (tracker) => tracker.feed(entries));
  }

  /** Feed one task lifecycle message for a session; true if `get()` would now answer differently. */
  feedTask(sessionId: string, msg: TaskEvent): boolean {
    return this.apply(sessionId, (tracker) => tracker.feedTask(msg));
  }

  /** The session's still-running subagents; `ended` ones are never reported. */
  get(sessionId: string): SubagentInfo[] {
    return this.trackers.get(sessionId)?.running() ?? [];
  }

  /** Forget a session entirely — it ended, so nothing of it is still running. */
  drop(sessionId: string): void {
    this.trackers.delete(sessionId);
  }

  private apply(sessionId: string, mutate: (tracker: SubagentTracker) => unknown): boolean {
    let tracker = this.trackers.get(sessionId);
    if (!tracker) {
      tracker = new SubagentTracker();
      this.trackers.set(sessionId, tracker);
    }
    const before = this.get(sessionId);
    mutate(tracker);
    return !sameAgents(before, this.get(sessionId));
  }
}

function sameAgents(a: SubagentInfo[], b: SubagentInfo[]): boolean {
  return a.length === b.length && a.every((agent, i) => agent.id === b[i].id);
}
