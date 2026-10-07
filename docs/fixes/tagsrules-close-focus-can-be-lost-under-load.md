---
id: tagsrules-close-focus-can-be-lost-under-load
title: Closing a Tags & rules row can permanently lose the focus handoff under load
type: fix
status: archived
domain: settings
related:
  - tags-rules-keyboard-test-is-flaky-under-the-full-suite
tags:
  - web
  - tests
  - focus
---

# Closing a Tags & rules row can permanently lose the focus handoff under load

Found 2026-09-24 while chasing
[[tags-rules-keyboard-test-is-flaky-under-the-full-suite]]. That doc's test
change (the dataset-mode and focus reads now go through `waitFor`) fixes the
common case — the assertion running one render ahead of React — but a rarer,
deeper failure surfaced under heavier contention than a single full-suite run
produces (three `npx vitest run` invocations going at once): the focus never
arrives at all, not even within `waitFor`'s default 1000ms.

## What is actually happening

`TagsRules.tsx`'s focus-follows-mode effect (around line 344) has no
dependency array, so React runs it after every commit:

```ts
useEffect(() => {
  const opened = focusOnOpen.current
  if (opened != null) {
    focusOnOpen.current = null
    // ...focus the pattern field...
  }
  const closed = focusOnClose.current
  if (closed != null) {
    focusOnClose.current = null
    document.querySelector<HTMLElement>(`[data-rule-open="${closed}"]`)?.focus()
  }
  // ...
})
```

`closeRule` writes `focusOnClose.current = editingRuleId` and calls
`setEditingRuleId(null)` in the same synchronous handler. Instrumented with a
temporary `console.error` (not committed) under three-way parallel full-suite
contention, the effect was observed running with `closed: 10` while the DOM
was still in the *editing* render — `document.querySelector('[data-rule-open="10"]')`
found nothing, `document.activeElement` was still the pattern `<input>` — and
the ref was cleared anyway, because the clear happens unconditionally,
**before** the query even runs. The next invocation of the same effect (from
the render that actually swapped to the resting row) has nothing left to act
on, so focus is never reclaimed — it eventually lands on `<body>` when the
input unmounts, and stays there.

Exactly how an effect with no deps ends up running once with the new ref
value against an old commit's DOM was not pinned down further (worth another
look: whether it is two commits from the same `setEditingRuleId` update, or
whether a second render was in flight from something else on the page and
its effect pass just happened to read the ref after `closeRule` mutated it
but before the render it triggered had committed).

## Why it is not fixed here

This task ([[tags-rules-keyboard-test-is-flaky-under-the-full-suite]]) is
scoped to a test-only change, and this is not a test problem — no amount of
`waitFor` patience helps when the target value the effect *would* set never
gets set.

How often it reproduces rests on two separate measurements, taken at
different stages, that do not agree:

- during the investigation, before the test change was final: not observed in
  ~35 consecutive single-process full runs, only under three concurrent
  full-suite processes (the only runs where the instrumentation caught it);
- during verification of the final test change: the keyboard test failed
  twice in 20 single-process full runs. The five green runs quoted in the
  commit message are separate from these 20.

Whether the verification failures were this race or another cause was not
confirmed, so do not assume it needs contention to show up.

## What to try

Do not clear `focusOnClose.current` (and the `opened`/`moved` refs beside it)
until the query actually finds its target — or better, drop the "clear
unconditionally" shape for a small state machine / re-check on the next
commit if the target was not there yet. Reproduce with the same three
concurrent `npx vitest run -w web` (or `npx vitest run` inside `web/`)
processes; the isolated single-file test alone did not reproduce it even
under that load, so the repro needs the surrounding suite.

## Archived 2026-10-07

Keyboard-only operation is not a requirement (`web/CLAUDE.md`), and the test
that exposed this race is gone. The race is still in `TagsRules.tsx`; reopen
this if focus handling becomes a goal.
