CREATE TABLE `harness_interviews` (
	`session_id` text PRIMARY KEY NOT NULL,
	`scope_root` text,
	`model` text NOT NULL,
	`template_id` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `harness_messages` (
	`uuid` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`step_index` integer NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_harness_messages_session` ON `harness_messages` (`session_id`);--> statement-breakpoint
ALTER TABLE `harness_templates` ADD `scope_root` text;--> statement-breakpoint
ALTER TABLE `harness_templates` ADD `draft` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_harnesses` ADD `pause_kind` text;--> statement-breakpoint
ALTER TABLE `session_harnesses` ADD `paused_at` integer;--> statement-breakpoint
ALTER TABLE `session_harnesses` ADD `removed_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `purpose` text;