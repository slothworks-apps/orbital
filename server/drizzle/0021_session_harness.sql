CREATE TABLE `harness_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_harness_events_session` ON `harness_events` (`session_id`,`at`);--> statement-breakpoint
CREATE TABLE `harness_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`inputs` text DEFAULT '[]' NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_harnesses` (
	`session_id` text PRIMARY KEY NOT NULL,
	`template_id` integer,
	`name` text NOT NULL,
	`steps` text NOT NULL,
	`inputs` text NOT NULL,
	`state` text NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`paused` integer DEFAULT 0 NOT NULL,
	`pause_reason` text,
	`auto_rounds` integer DEFAULT 0 NOT NULL,
	`idle_nudges` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
