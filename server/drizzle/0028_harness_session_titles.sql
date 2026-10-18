-- Sessions named after a harness's kickoff ("This session follows the Orbital
-- harness …") from before the indexer skipped what Orbital sends on a
-- harness's account. Blanking the title and the mtime short-circuit makes the
-- next index pass re-derive it: the user's first message, else the harness's
-- name. A title someone typed or the titler wrote is left alone.
UPDATE `sessions` SET `title` = '', `indexed_mtime` = 0
WHERE `title_source` = 'derived'
  AND `title` LIKE 'This session follows the Orbital harness%';
