---
id: tags-rules-keyboard-test-is-flaky-under-the-full-suite
title: The Tags & rules keyboard test is flaky under the full suite
type: fix
status: backlog
domain: settings
tags:
  - web
  - tests
---

# The Tags & rules keyboard test is flaky under the full suite

Seen 2026-09-23, twice in six full runs of `npx vitest run` in `web/`, on
merges that did not touch settings, tags or rules:

```
FAIL  src/test/tagsrules.test.tsx > Settings › Tags & rules >
      opens a row from the keyboard and Escape closes the row before the panel
```

Run alone (`npx vitest run src/test/tagsrules.test.tsx`) it passes every
time, and the file takes about 3 s in the full run — it is a load-sensitive
timing failure, not a regression. The test drives `user.keyboard` through
Enter → edit → Escape → resting → Escape → `onClose`, and one of the
in-between assertions reads the row's `data-rule-mode` synchronously right
after the keypress.

## What to do

Find the synchronous read after a keypress and make it `await
waitFor(...)`/`findBy...` like the assertions around it, or give the
`userEvent` setup an explicit `delay: null`. Confirm with a few full-suite
runs, not the file alone — alone it never fails.

## Why not now

It was found while merging unrelated map and transcript work, and the fix is
a test change with its own verification loop. Nothing it guards is broken.
