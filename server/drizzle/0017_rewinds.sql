CREATE TABLE `pending_rewinds` (
	`session_id` text PRIMARY KEY NOT NULL,
	`target_uuid` text NOT NULL,
	`fork_uuid` text NOT NULL,
	`drops_turn` text,
	`hidden_count` integer NOT NULL,
	`text` text NOT NULL,
	`prior_draft` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rewinds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`fork_uuid` text NOT NULL,
	`target_uuid` text NOT NULL,
	`hidden_count` integer NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rewinds_session` ON `rewinds` (`session_id`,`at`);