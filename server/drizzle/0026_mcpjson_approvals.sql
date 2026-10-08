CREATE TABLE `mcpjson_approvals` (
	`project` text NOT NULL,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`approved_at` integer NOT NULL,
	PRIMARY KEY(`project`, `name`)
);
