-- Every roster write names its signer's epoch, and a removal carries its remover's endorsements of
-- what the removed device signed (ADR roster-entries-are-signed). An entry written before names no
-- epoch and no member would take it; only development builds ever held one, so the table starts
-- over and every member sends its roster again.
DROP TABLE `group_members`;--> statement-breakpoint
CREATE TABLE `group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`os` text NOT NULL,
	`links` integer NOT NULL,
	`epoch` integer NOT NULL,
	`added_by` text NOT NULL,
	`added_epoch` integer NOT NULL,
	`added_at` integer NOT NULL,
	`added_sig` text NOT NULL,
	`endorsed_by` text,
	`endorsed_epoch` integer,
	`endorsed_sig` text,
	`described_at` integer NOT NULL,
	`described_by` text NOT NULL,
	`described_sig` text NOT NULL,
	`removed_by` text,
	`remover_epoch` integer,
	`removed_at` integer,
	`removed_sig` text,
	`removal_endorsed_by` text,
	`removal_endorsed_epoch` integer,
	`removal_endorsed_sig` text
);
