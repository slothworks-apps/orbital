ALTER TABLE `sessions` ADD `ended_at` integer;--> statement-breakpoint
-- A session now ends only when the user ends it, and an Orbital session with
-- no `ended_at` reads idle. Every historical Orbital session the Runner does
-- not hold was ended under the old rule, so stamp it — at its last activity,
-- or now when it never had any — or the map would fill with them as idle.
-- Terminal rows need nothing: their status never reads `ended_at`.
UPDATE `sessions` SET `ended_at` = COALESCE(`last_at`, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) WHERE `source` = 'web' AND `runner_status` IS NULL;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `parent_id`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `map_dismissed_at`;
