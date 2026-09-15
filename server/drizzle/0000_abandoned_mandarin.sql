-- Migration baseline (Task 12): pre-Drizzle databases were created by a
-- hand-rolled `CREATE TABLE IF NOT EXISTS` schema string in database.ts and
-- already have `PRAGMA user_version = 1` stamped. Drizzle's migration
-- journal has no record of that history, so the first time `migrate()` runs
-- against such a database it will try to (re)apply this initial migration.
-- Every CREATE TABLE / CREATE INDEX below is therefore written as
-- `IF NOT EXISTS` so this migration is a safe no-op against a database that
-- already has the schema, while still being a normal "create everything"
-- migration against a brand new database. Do not remove IF NOT EXISTS from
-- this file, and do not add IF NOT EXISTS by default to *future* migrations
-- without the same reasoning.
CREATE TABLE IF NOT EXISTS `session_tags` (
	`session_id` text NOT NULL,
	`tag_id` integer NOT NULL,
	`origin` text NOT NULL,
	PRIMARY KEY(`session_id`, `tag_id`, `origin`),
	CONSTRAINT "origin_check" CHECK("session_tags"."origin" IN ('rule','manual','manual_removed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_dir` text NOT NULL,
	`cwd` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`first_at` integer,
	`last_at` integer,
	`message_count` integer DEFAULT 0 NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'terminal' NOT NULL,
	`permission_mode` text,
	`parent_id` text,
	`indexed_mtime` integer DEFAULT 0 NOT NULL,
	`indexed_size` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_last_at` ON `sessions` ("last_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tag_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tag_id` integer NOT NULL,
	`position` integer NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`condition` text NOT NULL,
	`pattern` text NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "condition_check" CHECK("tag_rules"."condition" IN ('path_matches','title_contains','permission_is'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`hue` integer NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tags_name_unique` ON `tags` (`name`);
