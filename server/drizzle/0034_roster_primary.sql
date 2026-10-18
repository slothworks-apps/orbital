-- The group has one primary device, which alone signs the roster (ADR
-- the-group-has-one-primary-device): one document with its members, the descriptions beside it
-- and the notices of members that left. Entries signed by many members mean nothing to it; only
-- development builds ever held one, so the roster starts over, and a Mac with paired phones signs
-- its first version at its next start.
DROP TABLE `group_members`;--> statement-breakpoint
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
	`left_version` integer
);
--> statement-breakpoint
CREATE TABLE `group_exits` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE `group_left` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`founding` text NOT NULL,
	`version` integer NOT NULL,
	`at` integer NOT NULL,
	`sig` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `group_roster` (
	`group_id` text PRIMARY KEY NOT NULL,
	`founding` text NOT NULL,
	`version` integer NOT NULL,
	`dissolved` integer NOT NULL,
	`sig` text NOT NULL
);
