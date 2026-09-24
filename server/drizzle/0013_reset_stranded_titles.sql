-- Titles indexed before the title cleanup existed: CLI wrapper noise
-- (<local-command-caveat>…, <command-message>…), a bare slash command
-- ("/clear") from before extractMeta learned to skip past one, or a skill's
-- body from before it skipped `isMeta` entries. Blanking the title and the
-- mtime short-circuit makes the next index pass re-derive each from its
-- transcript. A command with arguments ("/foo bar", hence the space test) is
-- a legitimate title and is left alone.
--
-- This ran at the top of every index pass until 2026-09-24. There it looped:
-- extractMeta still falls back to a bare command when a transcript has
-- nothing else, so those sessions were blanked and re-parsed on every pass,
-- forever (docs/audits/resource-usage-pass-2026-09-24.md, finding 2). Once
-- is all the cleanup ever needed.
UPDATE `sessions` SET `title` = '', `indexed_mtime` = 0
WHERE `title` LIKE '<local-command-%'
   OR `title` LIKE '<command-%'
   OR `title` LIKE '<system-reminder%'
   OR (`title` LIKE '/%' AND `title` NOT LIKE '% %')
   OR `title` LIKE 'Base directory for this skill:%'
   OR `title` LIKE '(Re-invocation of /%'
   OR `title` LIKE '[Image:%';
