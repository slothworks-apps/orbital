CREATE TABLE `member_snapshots` (
	`member_id` text PRIMARY KEY NOT NULL,
	`sessions` text NOT NULL,
	`tags` text NOT NULL,
	`seen_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
