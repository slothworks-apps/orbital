---
id: subagent-panel-close-watches-selectedid
title: The subagent panel closes on a store subscription, not inside select()
type: adr
status: in-force
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
tags:
  - web
  - store
  - subagents
---

# The subagent panel closes on a store subscription, not inside select()

## The problem

Task 7's brief (`.superpowers/sdd/2026-09-22-subagent-transcript-panel-design/task-7-brief.md`)
asked for one behaviour: *"The panel must close when its parent session is
deselected or another planet is selected. Wire that to the existing selection
action rather than adding a watcher effect."*

"The existing selection action" reads as `select()` in `web/src/store/store.ts`
— it is the only exported action that changes `ui.selectedId`. But `select()`
is only ever called to move TO a session; nothing calls it to move away from
one. Deselecting `ui.selectedId` is done by four separate call sites, each
writing it directly with a raw `useOrbital.setState`, none of them going
through `select()`:

- `web/src/App.tsx` — the outermost `useEscapeLayer` handler (Escape with
  nothing more specific open):
  ```ts
  useOrbital.setState((s) => (s.ui.selectedId ? { ui: { ...s.ui, selectedId: null } } : s))
  ```
- `web/src/panels/DetailPanel.tsx` — the header's own × button.
- `web/src/map/SpaceMap.tsx` — `handlePointerMissed`, a click on empty map
  space.
- `web/src/lib/sessionUrl.ts` — the `popstate` handler's cleanup when the URL
  no longer names a valid session.

Wiring the close only into `select()` would have covered "another planet
selected" and silently missed all four of these — every real way to
deselect. The brief's own out-of-scope list rules out reaching into any of
them ("no moon click handling... all the next-but-one task's"), and the four
have nothing else in common that a shared helper could wrap without touching
every one of them anyway.

## What was decided

A **zustand store subscription**, registered once at module scope
immediately after `create(...)` in `store.ts`, rather than inside any one
action:

```ts
useOrbital.subscribe((state, prevState) => {
  if (state.ui.selectedId === prevState.ui.selectedId) return
  const panel = state.subagentPanel
  if (panel && panel.sessionId !== state.ui.selectedId) useOrbital.getState().closeSubagent()
})
```

This watches the FIELD `ui.selectedId`, not any one writer of it. Every one
of the five call sites above — the four raw `setState`s and `select()`
itself — ends in the same zustand `set`, so this one subscription observes
all of them without being taught about any of them individually. Reselecting
the SAME session (a no-op write, or one that leaves `selectedId` unchanged)
does not trip it; only an actual change away from the panel's own
`sessionId` does.

It is deliberately NOT a React effect: it is registered once, for the whole
module's lifetime, the moment `store.ts` is imported — not once per mount of
whatever component happens to render the panel or the map. That is the
distinction the brief's "rather than adding a watcher effect" phrase is read
to be drawing here: the objection was to tying this behaviour to a
component's lifecycle, not to reacting to a state change as such.

This is the first `useOrbital.subscribe(...)` in `store.ts` — every other
piece of derived-from-state behaviour in this file lives inside an action
(`applySessionEvent`, `setSessionDismissed`, …), never as its own top-level
subscription. It is a new pattern for this codebase, worth naming here so
the next person does not have to rediscover why it exists before adding a
second one.

## What was rejected

**Wiring the close into `select()` alone, and accepting that the four
raw-`setState` deselect sites are an open gap.** Rejected outright: three of
those four are the ordinary ways a user closes a panel (Escape, the ×, a
background click), so a subagent panel that closes on reselect but not on
deselect would be a panel that stays open pointing at nothing behind it far
more often than it closes correctly.

**Touching the four call sites to also call `closeSubagent()`.** Rejected as
out of scope for this task and as the more fragile shape regardless: it
would need remembering at a FIFTH call site the next time `ui.selectedId` is
cleared somewhere new, where the subscription needs nothing added at all.

**A `useEffect` in `SubagentPanel` (or a shared layout component) watching
`ui.selectedId`.** This is the literal "watcher effect" the brief asked to
avoid — it ties the close to whichever component happens to be mounted and
subscribed, rather than to the store itself, and duplicates itself the
moment a second surface ever needs the same panel-follows-selection rule.

## What the subscription cannot do, and what covers it instead

Two gaps the whole-branch review found, both of them the same shape: the
guard fires on `ui.selectedId` **changing**, so it is blind to anything that
is already wrong when the panel opens, and to anything that goes wrong
without the selection moving.

**Opening from a moon did not select the parent.** `SpaceMap` called
`openSubagent` alone, so a moon click could dock an agent panel with nothing
selected at all — `mapInsets.right` and `overlayRightPx` are both gated on
`selectedId` and would have ignored it — or beside a *different* session's
detail panel, and in either case mis-sized, since the pair-width math is fed
the nominal detail width whether or not the detail panel is mounted. The
guard cannot repair an inconsistency that exists at open time. Fixed at the
source: `openSubagent` now calls `select(sessionId)` itself before seating
the panel, not awaited (`select` writes `ui.selectedId` synchronously and
only then awaits its history fetch) and skipped when it is already the
selected session. The `OPEN →` path satisfied this trivially all along; now
the two ways in cannot drift apart on which of them remembered.

**A removed session left its panel behind.** `applySessionsEvent`'s `remove`
branch deletes `sessions[id]` and need not move `selectedId` — a session
removed while another planet is selected does not touch it at all. The panel
kept rendering: no parent name (the session is gone from `sessions`), a
transcript belonging to nothing, and no way to refetch, because the server
drops both subagent stores at the same moment. That branch now calls
`closeSubagent()` when the removed id is the panel's own.

The server-side comment beside those drops used to assert the opposite —
"no panel can still be open on a session the map no longer shows" — which
was a claim about client behaviour made in a server file, and wrong. It now
says what the drop actually knows, and names the client path that does the
closing.

## Consequences

- Any future call site that clears or changes `ui.selectedId` gets the
  correct close behaviour automatically — there is nothing to remember to
  wire up.
- But only for a CHANGE. Anything that makes the pair inconsistent without
  moving `ui.selectedId` — opening, removing a session, some future
  wholesale `sessions` replacement — needs its own handling, and two of the
  three already did.
- The subscription is easy to miss when reading `store.ts` top-to-bottom,
  since every other cross-cutting rule in the file lives inside an action.
  It sits directly after the `create(...)` call with the comment above,
  which is the one place in the file a reader scanning for "what happens
  after the store exists" would look.
- Covered by `web/src/test/subagentstore.test.ts` ("selecting a different
  planet closes the panel", "deselecting (clearing ui.selectedId directly)
  closes the panel too", "reselecting the SAME session leaves the panel
  open") — the middle case exercises the raw-`setState` path directly, not
  `select()`, so it would fail if this were ever narrowed back down to an
  in-action check. The same file covers the two gaps above
  ("openSubagent selects the parent session", "the parent session going away
  closes the panel").
