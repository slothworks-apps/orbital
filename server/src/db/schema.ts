import { sql, getTableColumns } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  check,
} from 'drizzle-orm/sqlite-core';
import type { PermissionMode, SessionSource, TagRule } from '../types.js';

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectDir: text('project_dir').notNull(),
    cwd: text('cwd').notNull().default(''),
    title: text('title').notNull().default(''),
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
    indexedMtime: integer('indexed_mtime').notNull().default(0),
    indexedSize: integer('indexed_size').notNull().default(0),
  },
  (table) => [index('idx_sessions_last_at').on(sql`${table.lastAt} DESC`)],
);

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  hue: integer('hue').notNull(),
  isDefault: integer('is_default').notNull().default(0),
});

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
