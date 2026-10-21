-- Sessions named after the line the CLI writes when a turn is interrupted,
-- from before extractMeta skipped it. In a harness session that line replaced
-- the harness's stand-in name as if the user had written it. Blanking the
-- title and the mtime short-circuit makes the next index pass re-derive it.
-- A title someone typed or the titler wrote is left alone.
UPDATE `sessions` SET `title` = '', `indexed_mtime` = 0
WHERE `title_source` = 'derived'
  AND `title` IN ('[Request interrupted by user]', '[Request interrupted by user for tool use]');
