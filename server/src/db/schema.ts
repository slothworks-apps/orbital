import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  check,
} from 'drizzle-orm/sqlite-core';

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
    source: text('source').notNull().default('terminal'),
    permissionMode: text('permission_mode'),
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
    enabled: integer('enabled').notNull().default(1),
    condition: text('condition').notNull(),
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
