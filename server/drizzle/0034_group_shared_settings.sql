-- Settings the group shares (spec 2026-10-24-group-shared-settings-design): each
-- row gets a stamp, when its value was set and on which device. Every existing
-- row keeps its value and starts at time 0 on this device (an empty origin), as a
-- seeded default does, so in a group the primary's untouched values win.
ALTER TABLE `settings` ADD `stamp_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `stamp_origin` text DEFAULT '' NOT NULL;