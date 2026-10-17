CREATE TABLE `group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`os` text NOT NULL,
	`links` integer NOT NULL,
	`epoch` integer NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	`described_at` integer NOT NULL,
	`removed_by` text,
	`removed_at` integer
);
