CREATE TABLE `permission_waits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`tool_use_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`agent_tool_use_id` text,
	`shown_at` integer NOT NULL,
	`answered_at` integer NOT NULL,
	`outcome` text NOT NULL,
	CONSTRAINT "permission_wait_outcome_check" CHECK("permission_waits"."outcome" IN ('allowed','denied','aborted'))
);
--> statement-breakpoint
CREATE INDEX `idx_permission_waits_session` ON `permission_waits` (`session_id`);--> statement-breakpoint
ALTER TABLE `session_stats` ADD `human_wait_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_stats` ADD `human_breakdown` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_stats` ADD `permission_breakdown` text DEFAULT '{}' NOT NULL;