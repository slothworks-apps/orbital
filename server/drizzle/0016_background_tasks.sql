CREATE TABLE `background_tasks` (
	`session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`command` text,
	`state` text NOT NULL,
	`status` text,
	`exit_code` integer,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`tool_use_id` text,
	`output_path` text,
	PRIMARY KEY(`session_id`, `task_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
