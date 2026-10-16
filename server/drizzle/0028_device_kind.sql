ALTER TABLE `remote_devices` ADD `kind` text;
--> statement-breakpoint
-- Every device paired before kinds is a phone: a Mac could not pair with
-- another until this release (spec 2026-10-16-device-group-design § 1).
UPDATE `remote_devices` SET `kind` = 'phone';
