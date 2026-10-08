import { asc } from 'drizzle-orm';
import { backgroundTasks as backgroundTasksTable } from '../db/schema.js';
import type { OrbitalDb } from '../db/database.js';
import { readExitCode as readExitCodeFromFile } from '../files/taskOutput.js';
import type { TaskEvent, TaskStartedEvent } from './subagents.js';

export type BackgroundTaskKind = 'shell' | 'monitor' | 'workflow' | 'mcp';

/**
 * One background task on the wire — `ApiSession.backgroundTasks` (spec
 * 2026-09-28-background-tasks-design § 2, the table under "The tracker").
 */
export interface BackgroundTaskInfo {
  /** The SDK `task_id`. */
  id: string;
  kind: BackgroundTaskKind;
  label: string;
  /** Shells and `Monitor` only: the launching call's `command` input. */
  command?: string;
  /**
   * Shells only, and only when the launching call's `description` opened
   * with a marker (`ShellIntent`). Absent is read as `wait`. Not stored: it
   * matters only while the task runs, and a task read back is ended.
   */
  intent?: ShellIntent;
  state: 'running' | 'ended';
  /** How it ended, from `task_notification` or a terminal `task_updated`; absent when it was retired without one. */
  status?: 'completed' | 'failed' | 'stopped';
  /** Shells and monitors only: the output file's `[exited with code N]`, absent without that line. */
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  toolUseId?: string;
  /** The server knows an output file for it, so the output view can open it. */
  hasOutput: boolean;
}

/**
 * The `Bash` or `Monitor` call that started a task, as the Runner saw it on
 * the stream: its tool name tells a shell from a monitor (both arrive as
 * `local_bash`), its `command` input is the task's command, and the path in
 * its `tool_result`, when that has arrived, is where the output goes.
 */
export interface LaunchingCall {
  name: string;
  input: Record<string, unknown>;
  outputPath?: string;
}

/** The tool names whose calls the Runner keeps for the tracker. */
export const TASK_LAUNCHING_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Monitor']);

/**
 * What the agent said a background shell is for, by the marker that opens its
 * `Bash` call's `description` (spec 2026-10-08-kept-shells-design § 1):
 * `wait` when it waits for the shell to end, `keep` when it leaves it running.
 */
export type ShellIntent = 'wait' | 'keep';

/** The marker, only at the start: the same text further in is the description's own. */
const INTENT_MARKER = /^\s*\[(wait|keep)\]\s*/i;

/** The intent a description opens with, or undefined when it opens with neither marker. */
export function shellIntentOf(description: unknown): ShellIntent | undefined {
  if (typeof description !== 'string') return undefined;
  const marker = INTENT_MARKER.exec(description)?.[1]?.toLowerCase();
  return marker === 'wait' || marker === 'keep' ? marker : undefined;
}

/** The description as it is shown: the leading marker cut, and the space after it. */
export function withoutIntentMarker(description: string): string {
  return description.replace(INTENT_MARKER, '');
}

/**
 * The tracked `task_type`s and what each is on the wire (spec § 1). `local_bash`
 * is refined by the launching call; `local_agent` belongs to the subagent
 * tracker, and every other type is not tracked at all.
 */
const KIND_OF_TASK_TYPE: Record<string, BackgroundTaskKind> = {
  local_bash: 'shell',
  monitor_mcp: 'monitor',
  local_workflow: 'workflow',
  mcp_task: 'mcp',
};

/**
 * How long, and how often, the store looks again for an exit line that was
 * not in the file yet when the task ended — the notification can beat the
 * CLI's last write.
 */
export const EXIT_CODE_RETRY_MS = 500;
export const EXIT_CODE_RETRIES = 4;

/** A task as the tracker holds it: the wire fields plus what never leaves the server. */
interface TaskRecord extends Omit<BackgroundTaskInfo, 'hasOutput'> {
  outputPath?: string;
  /**
   * A foreground `Bash`: the CLI reports it as a task too, blocking its call.
   * Held so a later move to the background can show it, but neither shown,
   * counted nor stored until then; one that ends first is dropped.
   */
  hidden: boolean;
}

function toInfo(r: TaskRecord): BackgroundTaskInfo {
  const info: BackgroundTaskInfo = {
    id: r.id, kind: r.kind, label: r.label, state: r.state, startedAt: r.startedAt,
    hasOutput: r.outputPath !== undefined,
  };
  if (r.command !== undefined) info.command = r.command;
  if (r.intent !== undefined) info.intent = r.intent;
  if (r.status !== undefined) info.status = r.status;
  if (r.exitCode !== undefined) info.exitCode = r.exitCode;
  if (r.endedAt !== undefined) info.endedAt = r.endedAt;
  if (r.toolUseId !== undefined) info.toolUseId = r.toolUseId;
  return info;
}

/** Only an absolute path is taken as an output file: anything else is not one the CLI wrote. */
function outputPathOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('/') ? value : undefined;
}

/** What one message did to a session's tasks, for the store to persist and act on. */
interface TrackerResult {
  /** Records whose wire shape or stored row changed. */
  changed: TaskRecord[];
  /** Records removed outright — a hidden foreground task that ended. Never stored, so nothing to delete. */
  dropped: TaskRecord[];
}

/**
 * One session's background tasks, from the SDK's task events. Pure state:
 * persistence and the output file are the store's business.
 *
 * Mirrors `SubagentTracker` in how it reads the stream (adr
 * subagent-liveness-from-sdk-task-events): `task_started` opens a task,
 * `task_notification` ends it with a status, and `background_tasks_changed`
 * is the level signal that retires one whose notification never came. It
 * adds `task_updated`, which the SDK uses for a foreground `Bash` moving to
 * the background and for a terminal status ahead of the notification.
 */
export class BackgroundTaskTracker {
  private tasks = new Map<string, TaskRecord>();

  constructor(private now: () => number = Date.now) {}

  /** Puts back a task read from the database, as it was stored. */
  restore(record: Omit<TaskRecord, 'hidden'>): void {
    this.tasks.set(record.id, { ...record, hidden: false });
  }

  feedTask(msg: TaskEvent, launchingCall: (toolUseId: string) => LaunchingCall | undefined): TrackerResult {
    const none: TrackerResult = { changed: [], dropped: [] };
    switch (msg.subtype) {
      case 'task_started':
        return this.started(msg, launchingCall);
      case 'task_updated': {
        const task = this.tasks.get(msg.task_id);
        if (!task) return none;
        const patch = msg.patch ?? {};
        let changed = false;
        if (patch.is_backgrounded === true && task.hidden) {
          task.hidden = false;
          changed = true;
        }
        const status =
          patch.status === 'completed' ? 'completed'
          : patch.status === 'failed' ? 'failed'
          : patch.status === 'killed' ? 'stopped'
          : undefined;
        if (status) return this.end(task, status);
        return changed ? { changed: [task], dropped: [] } : none;
      }
      case 'task_notification': {
        const task = this.tasks.get(msg.task_id);
        if (!task) return none;
        // The notification names the output file a second time; it is the
        // only source for a task whose launch result carried none.
        const path = outputPathOf(msg.output_file);
        const learnedPath = path !== undefined && task.outputPath === undefined && !task.hidden;
        if (learnedPath) task.outputPath = path;
        const result = this.end(task, msg.status);
        if (learnedPath && result.changed.length === 0) result.changed.push(task);
        return result;
      }
      case 'background_tasks_changed': {
        // Replace semantics: a running task missing from the payload is over,
        // whatever became of its notification. A hidden task is foreground
        // work and never in these payloads, so it is not judged by them.
        const live = new Set(msg.tasks.map((t) => t.task_id));
        const result: TrackerResult = { changed: [], dropped: [] };
        for (const task of this.tasks.values()) {
          if (task.state !== 'running' || task.hidden || live.has(task.id)) continue;
          task.state = 'ended';
          task.endedAt ??= this.now();
          // No status: this path exists because none arrived.
          result.changed.push(task);
        }
        return result;
      }
    }
  }

  /** Ends every running task without a status — the session's CLI process is gone, and its tasks with it. */
  endAll(): TrackerResult {
    const result: TrackerResult = { changed: [], dropped: [] };
    for (const task of [...this.tasks.values()]) {
      if (task.state !== 'running') continue;
      if (task.hidden) {
        this.tasks.delete(task.id);
        result.dropped.push(task);
        continue;
      }
      task.state = 'ended';
      task.endedAt ??= this.now();
      result.changed.push(task);
    }
    return result;
  }

  /** The output path the Runner read off a launch's `tool_result`, for the task that call started. */
  setOutputPath(toolUseId: string, path: string): TaskRecord | undefined {
    const valid = outputPathOf(path);
    if (!valid) return undefined;
    for (const task of this.tasks.values()) {
      if (task.toolUseId !== toolUseId || task.outputPath !== undefined) continue;
      task.outputPath = valid;
      return task;
    }
    return undefined;
  }

  record(taskId: string): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    return task && !task.hidden ? task : undefined;
  }

  all(): BackgroundTaskInfo[] {
    return [...this.tasks.values()].filter((t) => !t.hidden).map(toInfo);
  }

  running(): BackgroundTaskInfo[] {
    return this.all().filter((t) => t.state === 'running');
  }

  /** The running tasks the session waits on: all of them but the kept shells. */
  awaited(): BackgroundTaskInfo[] {
    return this.running().filter((t) => t.intent !== 'keep');
  }

  /** The running shells the agent left running on purpose. */
  kept(): BackgroundTaskInfo[] {
    return this.running().filter((t) => t.intent === 'keep');
  }

  private started(
    msg: TaskStartedEvent,
    launchingCall: (toolUseId: string) => LaunchingCall | undefined,
  ): TrackerResult {
    // `ambient` is the CLI's own housekeeping, which the SDK asks hosts to
    // keep out of activity indicators.
    if (msg.ambient) return { changed: [], dropped: [] };
    let kind = msg.task_type !== undefined ? KIND_OF_TASK_TYPE[msg.task_type] : undefined;
    if (!kind) return { changed: [], dropped: [] };
    const call = msg.tool_use_id ? launchingCall(msg.tool_use_id) : undefined;
    // Both arrive as `local_bash`; only the launching call tells them apart,
    // and without one it is a shell (spec § 1 "Monitor vs Bash").
    if (msg.task_type === 'local_bash' && call?.name === 'Monitor') kind = 'monitor';
    const command =
      msg.task_type === 'local_bash' && typeof call?.input.command === 'string' ? call.input.command : undefined;
    // The call's own description first: it is what the hook checked. The
    // marker is the agent talking to Orbital, so the label goes without it.
    const intent = kind === 'shell' ? shellIntentOf(call?.input.description) ?? shellIntentOf(msg.description) : undefined;
    const description = msg.description ? withoutIntentMarker(msg.description) : undefined;
    const label =
      (kind === 'workflow' && msg.workflow_name) || description || command || kind;
    const existing = this.tasks.get(msg.task_id);
    // A second `task_started` for a known task is a resume: the same task
    // back at work, so its clock and output carry over and how it last ended
    // no longer applies.
    const task: TaskRecord = {
      id: msg.task_id,
      kind,
      label,
      state: 'running',
      startedAt: existing?.startedAt ?? this.now(),
      hidden: msg.task_type === 'local_bash' && msg.is_backgrounded === false,
    };
    if (command !== undefined) task.command = command;
    if (intent !== undefined) task.intent = intent;
    if (msg.tool_use_id) task.toolUseId = msg.tool_use_id;
    const path = outputPathOf(call?.outputPath) ?? existing?.outputPath;
    if (path) task.outputPath = path;
    this.tasks.set(task.id, task);
    return task.hidden ? { changed: [], dropped: [] } : { changed: [task], dropped: [] };
  }

  private end(task: TaskRecord, status: 'completed' | 'failed' | 'stopped'): TrackerResult {
    if (task.hidden) {
      // A foreground command that finished in the foreground: never
      // background work, so it never appears.
      this.tasks.delete(task.id);
      return { changed: [], dropped: [task] };
    }
    if (task.state === 'ended' && task.status === status) return { changed: [], dropped: [] };
    task.state = 'ended';
    // A repeated end (the `task_updated` and then the notification) may
    // correct the status, but the first end's time stands.
    task.status = status;
    task.endedAt ??= this.now();
    return { changed: [task], dropped: [] };
  }
}

export interface BackgroundTaskStoreDeps {
  /** Write-through persistence (spec § 2 Persistence). Absent in unit tests that do not care. */
  db?: OrbitalDb;
  /** A change that happened after the call that caused it returned — today, an exit code read on a retry. */
  onChange?: (sessionId: string) => void;
  /** Reads the exit line off an output file; the real file by default. */
  readExitCode?: (path: string) => number | undefined;
  now?: () => number;
  exitCodeRetryMs?: number;
}

/**
 * The server's record of every session's background tasks, keyed by session,
 * beside `SubagentStore` and fed by the same `onTaskEvent`. Unlike subagents
 * these are kept in SQLite (`background_tasks`): the list keeps ended tasks,
 * their exit codes and their output across a restart of Orbital.
 *
 * Two reads, as with subagents: `running()` never holds an ended task, and
 * its `awaited()` part is what keeps a session `working` once its turn is
 * over — a kept shell does not (spec 2026-10-08-kept-shells-design § 4);
 * `all()` is the wire list, ended included, in start order.
 *
 * The feeders answer whether `all()` changed, so the caller republishes only
 * then. A change found later — an exit line that was not written yet when
 * the task ended — is announced through `onChange`.
 */
export class BackgroundTaskStore {
  private trackers = new Map<string, BackgroundTaskTracker>();
  private retries = new Set<ReturnType<typeof setTimeout>>();
  private db?: OrbitalDb;
  private onChange?: (sessionId: string) => void;
  private readExitCode: (path: string) => number | undefined;
  private now: () => number;
  private exitCodeRetryMs: number;

  constructor(deps: BackgroundTaskStoreDeps = {}) {
    this.db = deps.db;
    this.onChange = deps.onChange;
    this.readExitCode = deps.readExitCode ?? readExitCodeFromFile;
    this.now = deps.now ?? Date.now;
    this.exitCodeRetryMs = deps.exitCodeRetryMs ?? EXIT_CODE_RETRY_MS;
  }

  /**
   * Reads every stored task back. One still `running` is ended here, without
   * a status: the previous server's exit took its CLI process, and the
   * process took the task (spec § 2 Persistence). A shell that outlived a
   * hard exit is beyond what the list can see.
   */
  load(): void {
    if (!this.db) return;
    const at = this.now();
    const rows = this.db
      .select()
      .from(backgroundTasksTable)
      .orderBy(asc(backgroundTasksTable.startedAt), asc(backgroundTasksTable.taskId))
      .all();
    for (const row of rows) {
      const ended = row.state === 'running';
      const record: Omit<TaskRecord, 'hidden'> = {
        id: row.taskId,
        kind: row.kind,
        label: row.label,
        state: 'ended',
        startedAt: row.startedAt,
      };
      if (row.command !== null) record.command = row.command;
      if (row.status !== null && !ended) record.status = row.status;
      if (row.exitCode !== null) record.exitCode = row.exitCode;
      const endedAt = ended ? at : row.endedAt;
      if (endedAt !== null) record.endedAt = endedAt;
      if (row.toolUseId !== null) record.toolUseId = row.toolUseId;
      if (row.outputPath !== null) record.outputPath = row.outputPath;
      this.tracker(row.sessionId).restore(record);
      if (ended) this.persist(row.sessionId, { ...record, hidden: false });
    }
  }

  feedTask(
    sessionId: string,
    msg: TaskEvent,
    launchingCall: (toolUseId: string) => LaunchingCall | undefined = () => undefined,
  ): boolean {
    return this.apply(sessionId, this.tracker(sessionId).feedTask(msg, launchingCall));
  }

  /** The session's CLI process exited: every task still running ends with it, unstated (spec § 2 Ending). */
  endAll(sessionId: string): boolean {
    const tracker = this.trackers.get(sessionId);
    return tracker ? this.apply(sessionId, tracker.endAll()) : false;
  }

  /** An output path learned after its task started; true when a task took it. */
  setOutputPath(sessionId: string, toolUseId: string, path: string): boolean {
    const task = this.trackers.get(sessionId)?.setOutputPath(toolUseId, path);
    if (!task) return false;
    if (!task.hidden) this.persist(sessionId, task);
    return !task.hidden;
  }

  all(sessionId: string): BackgroundTaskInfo[] {
    return this.trackers.get(sessionId)?.all() ?? [];
  }

  running(sessionId: string): BackgroundTaskInfo[] {
    return this.trackers.get(sessionId)?.running() ?? [];
  }

  /** What keeps the session `working` once its turn is over: every running task but a kept shell. */
  awaited(sessionId: string): BackgroundTaskInfo[] {
    return this.trackers.get(sessionId)?.awaited() ?? [];
  }

  /** The kept shells still running: they hold no `working`, but sleeping the session would stop them. */
  kept(sessionId: string): BackgroundTaskInfo[] {
    return this.trackers.get(sessionId)?.kept() ?? [];
  }

  get(sessionId: string, taskId: string): BackgroundTaskInfo | undefined {
    const task = this.trackers.get(sessionId)?.record(taskId);
    return task ? toInfo(task) : undefined;
  }

  /** The output file recorded for a task — the only path the output route and the follower ever open. */
  outputPath(sessionId: string, taskId: string): string | undefined {
    return this.trackers.get(sessionId)?.record(taskId)?.outputPath;
  }

  /** The task a launching call started, if the store knows one. */
  taskIdForToolUse(sessionId: string, toolUseId: string): string | undefined {
    return this.all(sessionId).find((t) => t.toolUseId === toolUseId)?.id;
  }

  /** Cancels pending exit-code retries (server shutdown). */
  dispose(): void {
    for (const timer of this.retries) clearTimeout(timer);
    this.retries.clear();
  }

  private tracker(sessionId: string): BackgroundTaskTracker {
    let tracker = this.trackers.get(sessionId);
    if (!tracker) {
      tracker = new BackgroundTaskTracker(this.now);
      this.trackers.set(sessionId, tracker);
    }
    return tracker;
  }

  private apply(sessionId: string, result: TrackerResult): boolean {
    for (const task of result.changed) {
      if (task.state === 'ended') this.takeExitCode(sessionId, task, 0);
      this.persist(sessionId, task);
    }
    return result.changed.length > 0;
  }

  /**
   * Reads a shell's or monitor's exit code once it has ended, and again a
   * few times if the closing line is not there yet. Absent after that is an
   * answer too: a killed command may never get the line.
   */
  private takeExitCode(sessionId: string, task: TaskRecord, attempt: number): void {
    if (task.exitCode !== undefined || !task.outputPath) return;
    if (task.kind !== 'shell' && task.kind !== 'monitor') return;
    const code = this.readExitCode(task.outputPath);
    if (code !== undefined) {
      task.exitCode = code;
      if (attempt > 0) {
        this.persist(sessionId, task);
        this.onChange?.(sessionId);
      }
      return;
    }
    if (attempt >= EXIT_CODE_RETRIES) return;
    const timer = setTimeout(() => {
      this.retries.delete(timer);
      // A resume may have put it back to work in the meantime.
      if (task.state === 'ended') this.takeExitCode(sessionId, task, attempt + 1);
    }, this.exitCodeRetryMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.retries.add(timer);
  }

  private persist(sessionId: string, task: TaskRecord): void {
    if (!this.db || task.hidden) return;
    const row = {
      sessionId,
      taskId: task.id,
      kind: task.kind,
      label: task.label,
      command: task.command ?? null,
      state: task.state,
      status: task.status ?? null,
      exitCode: task.exitCode ?? null,
      startedAt: task.startedAt,
      endedAt: task.endedAt ?? null,
      toolUseId: task.toolUseId ?? null,
      outputPath: task.outputPath ?? null,
    };
    const { sessionId: _s, taskId: _t, ...set } = row;
    this.db
      .insert(backgroundTasksTable)
      .values(row)
      .onConflictDoUpdate({ target: [backgroundTasksTable.sessionId, backgroundTasksTable.taskId], set })
      .run();
  }
}
