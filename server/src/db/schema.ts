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
import type { Finding, SubagentModelUsage, ToolStat } from '../stats/compute.js';

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
    parentId: text('parent_id'),
    /**
     * Map-only dismissal (tag clusters, spec 2026-09-18-tag-clusters-design):
     * when set, the session was dragged into the hole and stays off the map.
     * Epoch ms. Cleared by the undo endpoint and by any new activity (the
     * indexer, a sent message) — the sidebar and search never read it.
     */
    mapDismissedAt: integer('map_dismissed_at'),
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
     * Never set at the same time as `mapDismissedAt` — the two are mutually
     * exclusive, each route clearing the other. Declared last for the same
     * reason as `contextUsedTokens`: `ALTER TABLE ... ADD COLUMN` appends,
     * and `sessionColumns` has to stay in physical order.
     */
    pinnedAt: integer('pinned_at'),
    /**
     * The status the Runner last held for this session, and null when it does
     * not own it (spec 2026-09-21-session-autoheal-design). The asymmetry is
     * the point: a graceful end clears it and a killed process cannot, so a
     * non-null value at boot means the server that wrote it never got to
     * finish — which is how autoheal tells a session that ended from one that
     * was cut off. Only Orbital's own sessions ever carry it; a terminal
     * session is read, never owned.
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
});

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
