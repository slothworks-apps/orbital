-- Every stored reading predates the fix for `contextUsedFromAssistantUsage`
-- and is a turn's billing total, not a window measurement: a turn with N tool
-- round-trips counted the whole conversation N times, so a 222k session read
-- 1513.6k (docs/fixes/context-arc-summed-the-whole-turn.md).
--
-- The right number cannot be recovered from the row, so the rows say "not
-- measured" instead. A live session rewrites its own at the end of its next
-- turn; an ended one shows no gauge, which is honest, where the old value was
-- confidently wrong.
UPDATE `sessions` SET `context_used_tokens` = NULL;
