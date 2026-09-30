import { sql, getTableColumns } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/sqlite-core';
import type {
  ErrorKind,
  ErrorSource,
  PermissionMode,
  SessionSource,
  SessionStatus,
  TagRule,
  TitleSource,
} from '../types.js';
import type { Finding, PermissionOutcome, SubagentModelUsage, ToolStat } from '../stats/compute.js';

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectDir: text('project_dir').notNull(),
    cwd: text('cwd').notNull().default(''),
    title: text('title').notNull().default(''),
    /** Who named this session — only `manual` is a person's word, and nothing overwrites it. */
    titleSource: text('title_source').$type<TitleSource>().notNull().default('derived'),
    firstAt: integer('first_at'),
    lastAt: integer('last_at'),
    messageCount: integer('message_count').notNull().default(0),
    fileSize: integer('file_size').notNull().default(0),
    source: text('source').$type<SessionSource>().notNull().default('terminal'),
    permissionMode: text('permission_mode').$type<PermissionMode>(),
    /** The model Orbital ASKED for — an SDK `value` such as `opus[1m]`. Null for terminal sessions. */
    model: text('model'),
    /** The model that actually ran, as the transcript/SDK reports it (`claude-opus-5`). */
    resolvedModel: text('resolved_model'),
    indexedMtime: integer('indexed_mtime').notNull().default(0),
    indexedSize: integer('indexed_size').notNull().default(0),
    /**
     * How many tokens the session's context held at the end of its last turn
     * — the numerator of the map's context arc (spec `context-fill-arc`).
     * Written by the Runner at the end of each turn — from the CLI's own
     * `get_context_usage` answer, or the turn's last main-loop API call when
     * it cannot answer — and re-set at a `compact_boundary`. Never from a
     * `result`'s usage, which totals the turn's requests rather than
     * measuring the window (fix: context-arc-summed-the-whole-turn). Null means "not measured": every terminal session
     * (the indexer extracts no usage at all) and every web session before its
     * first turn ends. Declared last so it sits where `ALTER TABLE ... ADD
     * COLUMN` actually puts it, keeping `sessionColumns` in physical order.
     */
    contextUsedTokens: integer('context_used_tokens'),
    /**
     * The manual exemption from the map's release timer (spec
     * 2026-09-20-pinned-sessions-design): epoch ms of the moment the user
     * pinned the session, null when it is not pinned. The stamp is a time
     * rather than a flag because the sidebar's PINNED section keeps pin
     * order, and `GET /api/sessions` sorts on it.
     *
     * Declared last for the same reason as `contextUsedTokens`: `ALTER TABLE
     * ... ADD COLUMN` appends, and `sessionColumns` has to stay in physical
     * order.
     */
    pinnedAt: integer('pinned_at'),
    /**
     * The status the Runner last held for this session, and null when it does
     * not own it (spec 2026-09-21-session-autoheal-design). The asymmetry is
     * the point: a stopped process clears it and a killed one cannot, so a
     * non-null value at boot means the server that wrote it never got to
     * finish. Boot clears every one it finds, and a `working` one marks the
     * session interrupted (spec 2026-09-24-sessions-end-only-by-hand-design
     * § 5). Only Orbital's own sessions ever carry it; a terminal session is
     * read, never owned.
     *
     * Declared last for the same reason as `contextUsedTokens` and
     * `pinnedAt`: `ALTER TABLE ... ADD COLUMN` appends, and `sessionColumns`
     * has to stay in physical order.
     */
    runnerStatus: text('runner_status').$type<SessionStatus>(),
    /**
     * When a restart cut this session off mid-turn (epoch ms), null
     * otherwise. Set by the boot reconciliation for the sessions it finds at
     * `working`, and cleared the next time the session actually runs a turn.
     * On the row rather than only on the wire so the mark survives a reload.
     */
    interruptedAt: integer('interrupted_at'),
    /**
     * When the user ended this session (epoch ms), null while it has not been
     * ended (spec 2026-09-24-sessions-end-only-by-hand-design § 1). Only the
     * user's gestures write it — End, Clear on the old session, the trash —
     * and only a delivered message or Reopen clears it; a process that exits,
     * crashes or dies with the server leaves it alone. It means something
     * only for Orbital's own sessions: a terminal session nobody is running
     * is over whatever this says.
     */
    endedAt: integer('ended_at'),
  },
  (table) => [index('idx_sessions_last_at').on(sql`${table.lastAt} DESC`)],
);

/**
 * One rolled-up row per session, written by the indexer and the watcher tail
 * from `computeStats` (spec `2026-09-20-session-stats-design` § Data model).
 *
 * Money is deliberately absent: cost is derived at read time from these token
 * columns and the pricing table that ships with the build, so a price change
 * reprices history without a reindex. `statsVersion` records which definition
 * of these columns produced the row — the indexer recomputes when it is stale,
 * even for a file whose mtime and size have not moved.
 */
export const sessionStats = sqliteTable('session_stats', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  apiMs: integer('api_ms').notNull().default(0),
  localToolMs: integer('local_tool_ms').notNull().default(0),
  mcpMs: integer('mcp_ms').notNull().default(0),
  subagentMs: integer('subagent_ms').notNull().default(0),
  turns: integer('turns').notNull().default(0),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
  cacheCreation5mTokens: integer('cache_creation_5m_tokens').notNull().default(0),
  cacheCreation1hTokens: integer('cache_creation_1h_tokens').notNull().default(0),
  thinkingTokens: integer('thinking_tokens').notNull().default(0),
  /** The flat display sum of sidechain usage; `subagentUsage` is its priceable form. */
  subagentTokens: integer('subagent_tokens').notNull().default(0),
  /** Sidechain usage per the subagent's own model id — subagents often run a cheaper one. */
  subagentUsage: text('subagent_usage', { mode: 'json' })
    .$type<Record<string, SubagentModelUsage>>()
    .notNull()
    .default({}),
  toolCalls: integer('tool_calls').notNull().default(0),
  toolErrors: integer('tool_errors').notNull().default(0),
  toolBreakdown: text('tool_breakdown', { mode: 'json' })
    .$type<Record<string, ToolStat>>()
    .notNull()
    .default({}),
  /** Per-session rules only; `slow-mcp` and RESOLVED are derived per window at query time. */
  findings: text('findings', { mode: 'json' }).$type<Finding[]>().notNull().default([]),
  statsVersion: integer('stats_version').notNull().default(0),
  /** Waiting on the user inside tool calls — never part of the four work columns above. */
  humanWaitMs: integer('human_wait_ms').notNull().default(0),
  /** `AskUserQuestion` and `ExitPlanMode` runs, kept out of `toolBreakdown`. */
  humanBreakdown: text('human_breakdown', { mode: 'json' })
    .$type<Record<string, ToolStat>>()
    .notNull()
    .default({}),
  /** Permission waits by the prompted tool's name; `ms` and `buckets` are the wait. */
  permissionBreakdown: text('permission_breakdown', { mode: 'json' })
    .$type<Record<string, ToolStat>>()
    .notNull()
    .default({}),
});

/**
 * Every permission prompt the Runner parked and then settled — shown and
 * answered — for the sessions Orbital runs (ADR
 * `permission-waits-are-measured-by-the-runner-only`). `computeStats` reads a
 * session's rows beside its transcript to cut the wait out of the prompted
 * tool. Question and plan decisions are not here: the transcript times them.
 */
export const permissionWaits = sqliteTable(
  'permission_waits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    /** The prompted tool's `tool_use` id — a sidechain one for a subagent's prompt. */
    toolUseId: text('tool_use_id').notNull(),
    /** What the runner was asked about; the transcript's own name wins when it has one. */
    toolName: text('tool_name').notNull(),
    /** The main-chain `Agent` call a subagent's prompt came from; null for the main loop's own. */
    agentToolUseId: text('agent_tool_use_id'),
    /** Epoch ms. */
    shownAt: integer('shown_at').notNull(),
    /** Epoch ms. */
    answeredAt: integer('answered_at').notNull(),
    outcome: text('outcome').$type<PermissionOutcome>().notNull(),
  },
  (table) => [
    index('idx_permission_waits_session').on(table.sessionId),
    check('permission_wait_outcome_check', sql`${table.outcome} IN ('allowed','denied','aborted')`),
  ],
);

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  hue: integer('hue').notNull(),
  isDefault: integer('is_default').notNull().default(0),
  /**
   * The tag clump's home spot on the space map, in world units — written
   * when the user drops a dragged body somewhere new (tag clusters, agreed
   * 2026-09-18). Null = the automatic circle layout places it. Both set or
   * both null; the client is what maintains that.
   */
  anchorX: real('anchor_x'),
  anchorY: real('anchor_y'),
}, (table) => [
  // Exactly one default tag: untagged sessions fall back to it, and a second
  // one would be undeletable dead weight (the delete route refuses defaults).
  uniqueIndex('tags_one_default').on(table.isDefault).where(sql`${table.isDefault} = 1`),
]);

export const sessionTags = sqliteTable(
  'session_tags',
  {
    sessionId: text('session_id').notNull(),
    tagId: integer('tag_id').notNull(),
    origin: text('origin').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.tagId, table.origin] }),
    check('origin_check', sql`${table.origin} IN ('rule','manual','manual_removed')`),
  ],
);

export const tagRules = sqliteTable(
  'tag_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    enabled: integer('enabled').$type<0 | 1>().notNull().default(1),
    condition: text('condition').$type<TagRule['condition']>().notNull(),
    pattern: text('pattern').notNull(),
  },
  (table) => [
    check(
      'condition_check',
      sql`${table.condition} IN ('path_matches','title_contains','permission_is')`,
    ),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * Sessions the retention sweep removed, so the indexer does not put them
 * straight back (spec 2026-09-21-settings-sections-design § 4).
 *
 * This table exists because deleting the row is not enough: `indexProjects`
 * walks every `.jsonl` under `<claudeDir>/projects` and inserts anything the
 * database lacks, at boot and on every file event, so a swept session whose
 * transcript is still on disk would reappear within seconds. Orbital only
 * ever reads `~/.claude` — deleting the transcript is not on the table — so
 * the alternative is remembering the decision here.
 *
 * `sweptAt` is what keeps this from becoming a permanent blocklist. A
 * transcript whose mtime is NEWER than its tombstone has been written to
 * since the sweep, which means the session was resumed — the user is using
 * it again, and it has to come back. The indexer drops the tombstone and
 * indexes it normally. Only a file that has not moved since the sweep stays
 * hidden.
 */
export const sweptSessions = sqliteTable('swept_sessions', {
  /** The session id, which is also its transcript's filename stem. */
  id: text('id').primaryKey(),
  /** Epoch ms of the sweep that removed it. Compared against file mtime. */
  sweptAt: integer('swept_at').notNull(),
});

/**
 * Context compactions the CLI reported as failed (spec
 * 2026-09-28-context-compaction-design § Failure). The CLI writes nothing
 * about a failure into the transcript, so without this table the mark would
 * disappear on reload.
 *
 * `id` is the transcript row's own id, so the live mark and the reloaded one
 * are the same row to the client. `preTokens` is the session's context
 * reading when the compaction started. `clearedAt` is when the failure
 * stopped being the session's current state — the next turn started, or a
 * compaction succeeded — which is how `lastCompactionFailed` survives a
 * restart without a second source of truth. The mark itself stays.
 */
export const compactionFailures = sqliteTable(
  'compaction_failures',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    /** Epoch ms. */
    at: integer('at').notNull(),
    error: text('error'),
    preTokens: integer('pre_tokens'),
    trigger: text('trigger').$type<'manual' | 'auto'>().notNull(),
    durationMs: integer('duration_ms'),
    clearedAt: integer('cleared_at'),
  },
  (table) => [index('idx_compaction_failures_session').on(table.sessionId, table.at)],
);

/**
 * Every background task an Orbital session has had — shells, monitors,
 * workflows, MCP tasks — so ended tasks, their exit codes and the path to
 * their output survive a restart of the server (spec
 * 2026-09-28-background-tasks-design § 2 Persistence). One row per task,
 * written through by `BackgroundTaskStore` on every change; the columns are
 * the wire's `BackgroundTaskInfo` plus `outputPath`, which never leaves the
 * server. A row still `running` at boot is ended without a status: its CLI
 * died with the previous server.
 *
 * The foreign key documents the ownership; SQLite does not enforce it here
 * (`foreign_keys` is off), so the retention sweep deletes these rows itself.
 */
export const backgroundTasks = sqliteTable(
  'background_tasks',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    kind: text('kind').$type<'shell' | 'monitor' | 'workflow' | 'mcp'>().notNull(),
    label: text('label').notNull(),
    command: text('command'),
    state: text('state').$type<'running' | 'ended'>().notNull(),
    status: text('status').$type<'completed' | 'failed' | 'stopped'>(),
    exitCode: integer('exit_code'),
    /** Epoch ms. */
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    toolUseId: text('tool_use_id'),
    /** Where the CLI writes the task's output, as the CLI named it — never built by Orbital. */
    outputPath: text('output_path'),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.taskId] })],
);

/**
 * A rewind the user picked and has not sent yet, one per session at most
 * (spec 2026-09-29-rewind-design § Pending rewind). Nothing about the
 * transcript file changes until the next send, so this row is what makes the
 * cut stick: while it exists the messages API ends the live branch before
 * `targetUuid`, and every revive path resumes at `forkUuid` instead of the
 * file's newest leaf. It survives a restart for the same reason.
 */
export const pendingRewinds = sqliteTable('pending_rewinds', {
  sessionId: text('session_id').primaryKey(),
  /** The picked user entry — the start of the turn being dropped. */
  targetUuid: text('target_uuid').notNull(),
  /** The target's `parentUuid`: what `resumeSessionAt` receives. */
  forkUuid: text('fork_uuid').notNull(),
  /**
   * What `resumeDropsTurn` receives: the target, but only when it was the
   * newest human prompt of the live branch. The CLI's guard refuses a range
   * holding a second prompt, so a deeper rewind goes unguarded (null).
   */
  dropsTurn: text('drops_turn'),
  /** N, as the client counted it at pick time. */
  hiddenCount: integer('hidden_count').notNull(),
  /** The picked message's text, for the composer. */
  text: text('text').notNull(),
  /** What the composer held before the pick, handed back on Cancel. */
  priorDraft: text('prior_draft').notNull(),
  /** Epoch ms. */
  createdAt: integer('created_at').notNull(),
});

/**
 * Rewinds that were sent — what gives the divider at a fork its count
 * (spec § Pending rewind). A fork on the live branch with no row here was
 * rewound in the terminal. `targetUuid` is kept beyond the spec's columns:
 * until the new prompt lands in the file the target is still on the live
 * branch, and the messages API keeps cutting there meanwhile.
 */
export const rewinds = sqliteTable(
  'rewinds',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    forkUuid: text('fork_uuid').notNull(),
    targetUuid: text('target_uuid').notNull(),
    hiddenCount: integer('hidden_count').notNull(),
    /** Epoch ms. */
    at: integer('at').notNull(),
  },
  (table) => [index('idx_rewinds_session').on(table.sessionId, table.at)],
);

/**
 * The walkthrough narration, one row per session, replaced on each run (spec
 * 2026-09-30-narrate-out-of-band-design § Storage and state). Written only
 * by `NarrationStore`. `intents` is the last `done` run's answer: a new run
 * leaves it standing while `running`, so the page keeps its grouping until
 * the new answer lands, and a `failed` run clears it. A row still
 * `running` at boot is `failed` / `error`: its query died with the previous
 * server.
 */
export const narrations = sqliteTable(
  'narrations',
  {
    sessionId: text('session_id').primaryKey(),
    status: text('status').$type<'running' | 'done' | 'failed'>().notNull(),
    /** The model the query was asked on, as the setting named it. */
    model: text('model').notNull(),
    /** `NarrationIntent[]` as JSON text. Read it through `NarrationStore`, never raw. */
    intents: text('intents'),
    failure: text('failure').$type<'refused' | 'unparsable' | 'error'>(),
    /** Epoch ms. */
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [
    check('narration_status_check', sql`${table.status} IN ('running','done','failed')`),
  ],
);

/**
 * Every failure Orbital caught, from either side of the wire. See
 * `docs/superpowers/specs/2026-09-17-error-surface-design.md`.
 *
 * Nothing here is trimmed or redacted on the way in — a local tool has no one
 * to hide a stack trace from, and the whole point is that the real text
 * arrives. Retention is a cap, not a clock: `ErrorLog.record` prunes to the
 * newest 1000 rows, which is only a runaway guard.
 *
 * `context` is JSON *text* on disk and a parsed object on the wire; the
 * parsing (and the tolerance for a row whose JSON is corrupt) lives in
 * `src/errors/log.ts`, so nothing else has to remember which side it is on.
 */
export const errors = sqliteTable(
  'errors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Epoch ms. */
    at: integer('at').notNull(),
    source: text('source').$type<ErrorSource>().notNull(),
    kind: text('kind').$type<ErrorKind>().notNull(),
    sessionId: text('session_id'),
    message: text('message').notNull(),
    detail: text('detail'),
    /** JSON object as text. Read it through `ErrorLog`, never raw. */
    context: text('context'),
    /** When the user marked this row read. Null while it still sits in the
     * unread inbox; a stamped row leaves the list but stays in the table. */
    seenAt: integer('seen_at'),
  },
  (table) => [
    index('idx_errors_at').on(sql`${table.at} DESC`),
    check('error_source_check', sql`${table.source} IN ('server','web')`),
  ],
);

/**
 * Projects a table's columns keyed by their actual DB column name
 * (snake_case) rather than the JS-side camelCase accessor used elsewhere in
 * this file. Passed straight into `db.select(...)`, this keeps the JSON
 * wire format of the raw-passthrough endpoints (e.g. `is_default`,
 * `tag_id`) identical to what the pre-Drizzle `SELECT *` queries produced,
 * without hand-maintaining a parallel column list per table. Key order
 * follows declaration order (`Object.values` over `getTableColumns`
 * preserves insertion order), matching what `SELECT *` would have produced.
 */
type ColumnsByDbName<T extends SQLiteTable> = {
  [C in T['_']['columns'][keyof T['_']['columns']] as C['_']['name']]: C;
};

function snakeColumns<T extends SQLiteTable>(table: T): ColumnsByDbName<T> {
  return Object.fromEntries(
    Object.values(getTableColumns(table)).map((c) => [c.name, c]),
  ) as ColumnsByDbName<T>;
}

export const sessionColumns = snakeColumns(sessions);
export const tagColumns = snakeColumns(tags);
export const tagRuleColumns = snakeColumns(tagRules);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type SessionTag = typeof sessionTags.$inferSelect;
export type NewSessionTag = typeof sessionTags.$inferInsert;
export type TagRuleRow = typeof tagRules.$inferSelect;
export type NewTagRule = typeof tagRules.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;
export type ErrorRow = typeof errors.$inferSelect;
export type NewErrorRow = typeof errors.$inferInsert;
export type SessionStatsRow = typeof sessionStats.$inferSelect;
export type NewSessionStats = typeof sessionStats.$inferInsert;
