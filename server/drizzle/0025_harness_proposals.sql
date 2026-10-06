CREATE TABLE `session_harness_proposals` (
	`session_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL
);
