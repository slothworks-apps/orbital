-- WHAT'S NEW (spec 2026-10-19-whats-new-design): the web remembers the last
-- version this Mac ran in `whats_new_seen`, and takes a missing row for a
-- fresh install, which shows nothing. An install from before WHAT'S NEW has
-- no row either, yet it was updated: it gets the sentinel
-- 'before-whats-new', which shows the message for the running version once.
--
-- An install is existing when its settings table already holds rows. On a
-- fresh database this runs before the boot seed has written anything, so the
-- condition is false and nothing is inserted. A row that exists is never touched.
INSERT OR IGNORE INTO `settings` (`key`, `value`) SELECT 'whats_new_seen', 'before-whats-new' WHERE EXISTS (SELECT 1 FROM `settings`);
