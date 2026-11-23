CREATE TABLE `view_domain_approvals` (
	`session_id` text NOT NULL,
	`domain` text NOT NULL,
	`approved_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `domain`)
);
