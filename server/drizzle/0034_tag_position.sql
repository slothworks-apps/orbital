ALTER TABLE `tags` ADD `position` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Tags in the order they were listed before they had one: the default tag
-- first, the rest by id. Nothing moves after the update.
UPDATE `tags` SET `position` = (
  SELECT `ordered`.`rn` FROM (
    SELECT `id`, ROW_NUMBER() OVER (ORDER BY `is_default` DESC, `id`) - 1 AS `rn` FROM `tags`
  ) AS `ordered`
  WHERE `ordered`.`id` = `tags`.`id`
);
