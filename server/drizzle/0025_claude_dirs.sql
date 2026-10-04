CREATE TABLE `claude_dirs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_dirs_path_unique` ON `claude_dirs` (`path`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `claude_dir_id` integer DEFAULT 1 NOT NULL;