CREATE TABLE `compaction_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`at` integer NOT NULL,
	`error` text,
	`pre_tokens` integer,
	`trigger` text NOT NULL,
	`duration_ms` integer,
	`cleared_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_compaction_failures_session` ON `compaction_failures` (`session_id`,`at`);