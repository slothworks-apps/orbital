ALTER TABLE `sessions` ADD `model` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `resolved_model` text;
--> statement-breakpoint
UPDATE `sessions` SET `indexed_mtime` = 0;
