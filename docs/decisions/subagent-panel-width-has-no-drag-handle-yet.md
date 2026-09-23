---
id: subagent-panel-width-has-no-drag-handle-yet
title: The subagent panel's width is a fixed default, not a stored preference
type: adr
status: in-force
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
tags:
  - web
  - store
  - subagents
  - layout
---

# The subagent panel's width is a fixed default, not a stored preference

## The problem

Task 8's brief (`.superpowers/sdd/2026-09-22-subagent-transcript-panel-design/task-8-brief.md`)
gives the pairing resolution order in terms of "the user's stored detail
width `D` and stored subagent width `S`", and its step 2 is "Clamp `S` to at
least 320" — wording that reads as if a persisted, user-adjustable subagent
panel width already exists, the same way `detail_panel_width` does.

It does not. `SubagentPanel` (task 7) takes a `widthPx` prop and draws
whatever it is told; nothing in the codebase persists a subagent panel
width, and there is no drag handle on it the way `DetailPanel`'s own
`role="separator"` element resizes the detail panel. The brief's own
out-of-scope list also rules out changing `SubagentPanel` beyond "what
placing it requires", and its test list (§ "Tests you must write") only
ever asks for a drag test on the DETAIL panel ("dragging the detail panel
wider ... cannot push the pair past the ceiling") — never one on the
subagent panel's own edge.

## What was decided

`S` is always `SUBAGENT_PANEL_DEFAULT_PX` (380, `web/src/store/store.ts`)
for now. Every call site that resolves the pair
(`DetailPanel.tsx`, `SpaceMap.tsx`, `App.tsx`) feeds this same constant into
`resolvePanelPairWidths(detailWidthPx, subagentWidthPx, viewportWidth)` as
its `subagentWidthPx` argument, rather than reading a stored setting that
does not exist.

`resolvePanelPairWidths` itself still takes `subagentWidthPx` as a
parameter — and step 2's floor (`Math.max(SUBAGENT_PANEL_MIN_PX,
subagentWidthPx)`) is still real code, not deleted — even though every
caller today passes the same constant. This is deliberate: the pairing math
is exactly what a future resizable subagent panel would need unchanged, and
the floor clamp is exercised in `store.test.ts` ("floors a subagent width
under 320 before checking the ceiling") against synthetic values below 320,
so it is not dead code today — it is just never fed anything but the
default by a live caller yet.

## What was rejected

**A `subagent_panel_width` setting, with no drag handle to ever write it.**
Rejected as dead weight: a persisted value nothing in the UI can change is
worse than no persistence at all — it invites a future reader to assume a
control exists somewhere and go looking for it.

**Adding a resize handle to `SubagentPanel` in this task.** Rejected as
out of scope per the brief's own "Do not change `SubagentPanel`'s internals
beyond what placing it requires" — this task places the panel; giving it a
new interactive affordance is the next task's, or nobody's yet.

**Hardcoding `380` directly at each call site instead of naming the
constant.** Rejected because the three call sites (`DetailPanel.tsx`,
`SpaceMap.tsx`, `App.tsx`) all need to agree on the exact same number for
the pairing math to stay consistent across the app; a shared exported
constant makes that agreement structural rather than a matter of three
places happening to type the same literal.

## Consequences

- If a subagent panel drag handle is ever built, its live width only needs
  to replace the `SUBAGENT_PANEL_DEFAULT_PX` argument at each of the three
  call sites — `resolvePanelPairWidths` and its tests need no change.
- Until then, `resolvePanelPairWidths(D, S, V)` is only ever exercised by
  live callers with `S = SUBAGENT_PANEL_DEFAULT_PX`; the store-level tests
  that vary `S` (`store.test.ts`'s `resolvePanelPairWidths` suite) are the
  only place the function's behaviour for a different `S` is checked.
