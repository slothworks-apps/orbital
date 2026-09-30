CREATE TABLE `narrations` (
	`session_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`intents` text,
	`failure` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	CONSTRAINT "narration_status_check" CHECK("narrations"."status" IN ('running','done','failed'))
);
