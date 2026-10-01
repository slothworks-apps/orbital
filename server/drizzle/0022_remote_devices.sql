CREATE TABLE `remote_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`paired_at` integer NOT NULL,
	`last_seen_at` integer,
	`notifications` text NOT NULL
);
