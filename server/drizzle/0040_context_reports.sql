-- A new table, empty: every existing session starts with no kept report until
-- its transcript is next indexed or a report is taken from the read-out.
CREATE TABLE `context_reports` (
	`session_id` text PRIMARY KEY NOT NULL,
	`taken_at` integer NOT NULL,
	`report` text NOT NULL
);
