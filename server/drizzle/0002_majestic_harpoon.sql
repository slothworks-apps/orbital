CREATE TABLE `errors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`session_id` text,
	`message` text NOT NULL,
	`detail` text,
	`context` text,
	`seen_at` integer,
	CONSTRAINT "error_source_check" CHECK("errors"."source" IN ('server','web'))
);
--> statement-breakpoint
CREATE INDEX `idx_errors_at` ON `errors` ("at" DESC);