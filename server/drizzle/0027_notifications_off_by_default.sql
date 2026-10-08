-- Notifications start off (spec 2026-10-08-notifications-off-by-default-design
-- § 1, § 2). The boot seed now writes 'false' for the events and the sound,
-- and an absent row reads as off, so an install from before this change would
-- go silent behind its user's back. It keeps what it had instead: every
-- notify_* row it lacks is written out at the value it read as until now
-- ('true', the old seed and the old reading of an absent row), and the tip
-- is marked as ended, since an existing user never sees it.
--
-- An install is existing when its settings table already holds rows. On a
-- fresh database this runs before the boot seed has written anything, so the
-- condition is false and nothing is inserted; the seed then writes the new
-- defaults and `notify_tip` = 'pending'. A row that exists is never touched.
INSERT OR IGNORE INTO `settings` (`key`, `value`) SELECT 'notify_tip', 'ended' WHERE EXISTS (SELECT 1 FROM `settings`);--> statement-breakpoint
INSERT OR IGNORE INTO `settings` (`key`, `value`) SELECT 'notify_needs_input', 'true' WHERE EXISTS (SELECT 1 FROM `settings`);--> statement-breakpoint
INSERT OR IGNORE INTO `settings` (`key`, `value`) SELECT 'notify_session_ended', 'true' WHERE EXISTS (SELECT 1 FROM `settings`);--> statement-breakpoint
INSERT OR IGNORE INTO `settings` (`key`, `value`) SELECT 'notify_session_failed', 'true' WHERE EXISTS (SELECT 1 FROM `settings`);--> statement-breakpoint
INSERT OR IGNORE INTO `settings` (`key`, `value`) SELECT 'notify_sound', 'true' WHERE EXISTS (SELECT 1 FROM `settings`);
