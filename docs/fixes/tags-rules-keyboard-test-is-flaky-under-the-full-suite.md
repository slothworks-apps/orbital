---
id: tags-rules-keyboard-test-is-flaky-under-the-full-suite
title: The Tags & rules keyboard test is flaky under the full suite
type: fix
status: archived
domain: settings
related:
  - tagsrules-close-focus-can-be-lost-under-load
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

## Partially fixed 2026-09-24

`web/src/test/tagsrules.test.tsx`, "opens a row from the keyboard and Escape
closes the row before the panel": the synchronous `row(10).dataset.ruleMode`
/ focus / `onClose` reads that followed a keypress now go through `await
waitFor(...)`, matching the pattern already used elsewhere in the file. The
component (`TagsRules.tsx`) is unchanged, and five full `npx vitest run`
passes in `web/` came back green (see the commit message for the counts).

That is not the whole story, though: instrumenting the component (temporary
`console.error`s, not committed) under heavier contention than a normal full
run showed a genuine race in `TagsRules.tsx`'s close-focus effect, where the
ref that carries "focus this row on close" can be cleared before its target
is confirmed to exist, permanently losing the handoff — not a read-too-early
problem `waitFor` can wait out. Documented separately as
[[tagsrules-close-focus-can-be-lost-under-load]], since fixing it needs a
component change and this task's brief is test-only. Left `blocked` on that
document rather than `done`: the test is markedly less flaky, but the
underlying race is still there.

How often it reproduces rests on two separate measurements, taken at
different stages, that do not agree:

- during the investigation, before the test change was final: not observed in
  ~35 consecutive single-process full runs, only under three concurrent
  full-suite processes;
- during verification of the final test change: the keyboard test failed
  twice in 20 single-process full runs. The five green runs quoted in the
  commit message are separate from these 20.

Whether the verification failures were this race or another cause was not
confirmed; treat the single-process rate as unknown until the component fix
lands.

## Archived 2026-10-07

The test is gone: `1828c546` dropped the keyboard-only tests from
`tagsrules.test.tsx`, and `web/CLAUDE.md` now says keyboard-only operation
is not tested. The component race it exposed is still tracked in
[[tagsrules-close-focus-can-be-lost-under-load]].
