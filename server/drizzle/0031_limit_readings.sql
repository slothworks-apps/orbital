CREATE TABLE `limit_readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reading_key` text NOT NULL,
	`window` text NOT NULL,
	`percent` real NOT NULL,
	`resets_at` integer NOT NULL,
	`read_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_limit_readings_window` ON `limit_readings` (`reading_key`,`window`,`read_at`);