-- Roster entries are signed (ADR roster-entries-are-signed). An entry written before carries no
-- signature and no member would take it; only development builds ever held one, so the table
-- starts over and every member sends its roster again.
DROP TABLE `group_members`;--> statement-breakpoint
CREATE TABLE `group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`os` text NOT NULL,
	`links` integer NOT NULL,
	`epoch` integer NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	`added_sig` text NOT NULL,
	`described_at` integer NOT NULL,
	`described_by` text NOT NULL,
	`described_sig` text NOT NULL,
	`removed_by` text,
	`removed_at` integer,
	`removed_sig` text
);
