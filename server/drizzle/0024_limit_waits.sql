CREATE TABLE `limit_waits` (
	`session_id` text PRIMARY KEY NOT NULL,
	`resets_at` integer NOT NULL,
	`window_kind` text NOT NULL,
	`window_label` text NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL,
	`queued` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
