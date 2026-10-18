CREATE TABLE `group_descriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`os` text NOT NULL,
	`links` integer NOT NULL,
	`described_at` integer NOT NULL,
	`described_by` text NOT NULL,
	`sig` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `group_exits` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`since` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `group_left` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`founding` text NOT NULL,
	`version` integer NOT NULL,
	`at` integer NOT NULL,
	`sig` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`added_at` integer NOT NULL,
	`added_version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `group_membership` (
	`group_id` text PRIMARY KEY NOT NULL,
	`founding` text,
	`version` integer NOT NULL,
	`member` integer NOT NULL,
	`left_founding` text,
	`left_version` integer,
	`ended_why` text,
	`ended_by` text,
	`ended_by_name` text,
	`join_expires` integer
);
--> statement-breakpoint
CREATE TABLE `group_roster` (
	`group_id` text PRIMARY KEY NOT NULL,
	`founding` text NOT NULL,
	`version` integer NOT NULL,
	`dissolved` integer NOT NULL,
	`sig` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `member_snapshots` (
	`member_id` text PRIMARY KEY NOT NULL,
	`sessions` text NOT NULL,
	`tags` text NOT NULL,
	`seen_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pending_revokes` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE `remote_devices` ADD `kind` text;--> statement-breakpoint
-- Every device paired before kinds is a phone: a Mac could not pair with
-- another until this release (spec 2026-10-16-device-group-design § 1).
UPDATE `remote_devices` SET `kind` = 'phone';
