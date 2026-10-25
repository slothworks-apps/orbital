-- The tag list the group shares (spec 2026-10-24-group-shared-settings-design
-- § Tags): every tag gets an id across the group and a stamp, and a deleted
-- tag leaves a tombstone. Every existing tag keeps its row, its sessions and
-- its rules, and starts at time 0 on this device (an empty origin), as an
-- untouched setting does.
CREATE TABLE `tag_tombstones` (
	`uuid` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`stamp_at` integer NOT NULL,
	`stamp_origin` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tags` ADD `uuid` text;--> statement-breakpoint
ALTER TABLE `tags` ADD `stamp_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tags` ADD `stamp_origin` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- A random version-4 uuid for every existing tag.
UPDATE `tags` SET `uuid` = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))) WHERE `uuid` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tags_uuid` ON `tags` (`uuid`);--> statement-breakpoint
-- A row inserted without one (raw SQL, such as the default tag's seed, which
-- must also run against older schemas) gets one at once.
CREATE TRIGGER `tags_uuid_on_insert` AFTER INSERT ON `tags` WHEN NEW.`uuid` IS NULL BEGIN
	UPDATE `tags` SET `uuid` = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))) WHERE `id` = NEW.`id`;
END;
