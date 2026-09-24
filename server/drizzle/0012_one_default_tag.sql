-- The boot seed used to re-create the default tag by name, so every rename of
-- it left one more default behind. Keep the lowest id: it is the one the
-- untagged fallback already resolves to, so no session changes colour.
UPDATE `tags` SET `is_default` = 0 WHERE `is_default` = 1 AND `id` <> (SELECT MIN(`id`) FROM `tags` WHERE `is_default` = 1);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_one_default` ON `tags` (`is_default`) WHERE "tags"."is_default" = 1;
