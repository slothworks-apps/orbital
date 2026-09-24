---
id: 2026-09-24-subagent-list-design
title: Subagent list — every subagent of the session, one click from the header
type: spec
status: done
domain: web
related:
  - 2026-09-22-subagent-transcript-panel-design
  - 2026-09-23-detached-session-windows-design
  - 2026-09-24-state-colours-design
  - the-detail-panel-does-not-list-subagents
  - dismissal-marks-the-agent-only-the-map-reads-it
  - subagents-only-for-orbital-sessions
tags:
  - detail-panel
  - subagents
  - map
  - desktop
---

# Subagent list

Source: Claude Design, `Feature - Subagent list.dc.html`, artboards 25a–25c.
Read it through DesignSync; this spec records what was agreed, not the
pixels. Decided with Tomin, 2026-09-24. Implemented straight from this spec,
on `main`, without a plan document.

## Why

Today a subagent opens from its moon on the map, or from the `OPEN →` row in
the parent transcript — if that row can still be found in a long transcript.
A detached window has no map at all. The detail panel gets its own list of
the session's subagents, running and finished, each one click from its
transcript, for zero pixels of header height.

With the list in place, finished moons no longer need to orbit the planet:
the map shows what is running, the list holds the record.

## 1. The chip

A chip joins the detail header's **state row** (row 4), right after the state
badge. The row already exists, so the chip adds no height: it is 22 px tall,
the same as the state badge.

- **No subagents, no chip.** A session that never had one shows nothing and
  leaves no empty slot. Terminal sessions never have subagents
  ([[subagents-only-for-orbital-sessions]]), so they never show it.
- **Text** is the counts, joined by `·`, then the `▾` caret:
  `2 running · 5 done · 1 failed ▾`. A zero segment is dropped: only running
  reads `1 running ▾`, all finished reads `7 done ▾`. *Done* counts completed
  **and stopped** agents; *failed* is counted separately, in coral. Stopped
  is a choice, not a failure, so it does not get its own segment.
- **Ink**: only the running count and the glyph's dot use the active cyan
  (`--state-active`); failed uses coral (`--state-interrupted`); everything
  else is muted. When nothing runs, the glyph loses its dot.
- **Glyph**: a small moon, one size down from the sidebar rail's orbit mark.
- **Open** state is the standard active chip (stronger border and fill),
  caret flips to `▴`.
- Hover and focus title: “Subagents in this session”.
- The chip stays for the session's life, including after the session ends.

## 2. The dropdown

Clicking the chip opens the standard dropdown shell — `ui/Menu`'s
`MenuButton`, which already owns the portal, positioning, escape layer,
outside-press dismissal and the keyboard (arrows, Home/End, ↵, ⎋, type-ahead).
It is a menu, not a value picker: picking a row *does* something. `Menu`
gains what the list needs and nothing more:

- **group headings** — non-focusable rows (`RUNNING · 2`, `DONE · 5`), skipped
  by the arrows;
- **a selected mark** — the row of the agent currently open in the panel
  shows `✓` and `aria-current`;
- **a scroll ceiling** — at most 8 rows visible, then the list scrolls inside
  the shell;
- **row content** — an item can carry its own body instead of `label` +
  `detail`, so the 44 px agent row can be drawn without teaching `Menu` what
  an agent is.

The popup is 372 px wide and hangs under the chip, dropping over the
transcript. It stays inside the header row: in a row too narrow for that (the
450 px main-window panel 25a draws) it slides left until its right edge sits
on the row's right edge. Only in that narrow row does "right-aligned to the
header" hold; in a wide detached window the list must stay under the chip
that opened it, not drift to the far side of the header. A hint strip closes it:
`↑↓ move · ↵ open · ⎋ close`. Picking a row closes the list and opens the
panel; the transcript does not move.

### Rows

A row is a subagent: a state dot, its task as the title, its type, its state
word and elapsed time.

| field | source |
|---|---|
| title | `Subagent.name` (the `Agent` call's `description`, or its type as a fallback) — one line, ellipsis |
| type | `subagentTypeFrom(parentMessages, toolUseId)` — omitted when the parent transcript does not hold the launching `Agent` block |
| state word | running: none · completed: `done` · failed: `failed` · stopped: `stopped` |
| elapsed | running: `now − startedAt`, ticking every second while the list is open · finished: `endedAt − startedAt`, frozen |

The dot's shape carries the state, colour backs it up (25c, [[2026-09-24-state-colours-design]]):
a solid breathing dot for running (cyan), a ring for completed (mint) and
failed (coral), a 1 px-radius square for stopped (grey). The inks are the
`TASK_TONE` table `ui/Badge` already draws for the panel's own badge.

**Order**: `RUNNING` first, by `startedAt` newest first; then `DONE` — every
finished state — by `endedAt` newest first. An agent that finishes while the
list is open moves from `RUNNING` to `DONE` in place; rows are keyed by agent
id, so keyboard focus stays where it was and the list does not jump.

**No transcript**: an agent whose `SubagentInfo` has no `toolUseId` cannot be
joined to a buffer (subagent panel spec § 5). Its row stays in the list so the
chip's count still matches, dimmed, with the word `no transcript`, and is
disabled: focusable, does nothing. Nothing probes the server per row.

**Depth-2 agents** are not listed; they appear in their parent's transcript
only, as today.

### Picking a row

`openSubagent(sessionId, subagent)` — the same call the moon and the `OPEN →`
row make. The list, the moon and the row fill the same single slot: another
pick switches the panel's content. From an open subagent the chip is still in
reach (in the session header, or on row 1 in a swapped detached window, § 4),
so jumping to another agent never requires going back first.

## 3. `endedAt` on the wire

The list needs a frozen duration for finished rows without opening their
buffers, so `SubagentInfo` (`server/src/transcript/subagents.ts`) and its
mirror `Subagent` (`web/src/lib/types.ts`) gain `endedAt?: number` — epoch ms,
stamped by the tracker on **both** paths that end an agent: the
`task_notification` with a status and the `background_tasks_changed`
retirement. A resume that puts an agent back to work drops `endedAt` the same
way it drops `status`. `sameAgents` compares it, so the republish fires.

The panel's own `elapsedMsFor` prefers `endedAt` when present and falls back
to the last message's timestamp as today, so the panel and the list read the
same duration for the same agent.

## 4. Detached window

Canvas 25b. A detached window has no map and no room to the right. Today it
grows to the right to make room for the subagent panel
([[2026-09-23-detached-session-windows-design]] § "The subagent panel in the
window"). That stays. What is new is what happens when growing is not enough.

**Layout follows the window's width.** One threshold,
`WINDOW_PANEL_PAIR_MIN_PX` (= `DETAIL_PANEL_MIN_PX` + `SUBAGENT_PANEL_MIN_PX`,
the number main already uses to decide whether a window “already fits”):

- **at or above it — pane.** The subagent panel opens beside the session, as
  today. Nothing about this mode changes.
- **below it — swap.** The subagent replaces the session inside the window.

The canvas derives 760 from a 380 px subagent panel plus chrome; the code's
pair minimum uses the panel's 320 px minimum instead, and one constant is
better than two that can drift.

### The grow, and knowing about it

Opening a subagent still asks main to grow the window. Main answers: the
`session-window-subagent` IPC becomes an `invoke` that returns the width the
window will have — the grown width, or the current one when it did not grow
(full screen, no room, already wide enough). The renderer chooses pane when
`max(windowWidth, answeredWidth)` clears the threshold, so a window that is
about to grow shows the pane from the first frame, clipped on the right while
the animation runs (as the detached-window spec already allows), instead of
flashing the swap. The answered width is forgotten once the window has
reached it, so a later hand resize across the threshold switches the layout
in place, without animation, in either direction. In a browser there is no
bridge, no grow, and the width alone decides.

### Swap

- **Row 1** keeps the traffic lights and the drag region. `← session` sits
  where the session's path used to be; its dot shows the **parent's** state
  (cyan working, amber breathing when the parent needs input, per
  [[2026-09-24-state-colours-design]]), so the session can be seen working
  without going back. The chip (§ 1) moves to row 1's right end, so another
  subagent is one click away.
- The session's header, stats and composer are hidden, and the subagent's
  transcript gets all the height they used.
- The subagent panel's footer reads `read-only · the composer is one step
  back` and `⎋ back to session`; there is no `✕`.
- `⎋` or `← session` closes the subagent (the store's `closeSubagent`, as the
  pane's `✕` does) and the session comes back **with its scroll position and
  composer draft**: `DetailPanel` stays mounted underneath, hidden with
  `visibility: hidden` and `inert`, never unmounted.
- The window never resizes itself for the swap; if the user widens it past
  the threshold, the pane appears in place.

### Out of scope here

The canvas's “the main window's moon shows brackets for the subagent open in
the window”: with § 5 only running moons exist, and the main window would
need a new IPC to learn what a detached window has open. Not built.

## 5. Finished moons leave the map

Decided with Tomin, 2026-09-24: **a moon disappears when its agent ends.**
The map shows what is running; the list and the transcript's `OPEN →` row
hold the record. `buildSceneModel` filters `state !== 'ended'` again, and the
planet's footprint and orbit spacing follow the running count.

This supersedes subagent panel spec § 4 “moons outlive their agents” on the
map side only. Everything else in § 4 holds: `SubagentStore.all()` still
returns every agent the session ever had (the list and the `OPEN →` row need
exactly that), `running()` still drives `hasLiveSubagents`, and the buffer
still outlives the agent ([[subagent-buffer-outlives-the-agent]]).

**Dismissal goes.** With no ended moon there is nothing to dismiss. Removed
in full rather than left dead: the dismissal set and `dismissed` flag on the
server, the `dismissed` field on both `SubagentInfo` and `Subagent`, the
`dismissed` compare in `sameAgents`, `POST
/api/sessions/:id/subagents/:agentId/dismiss`, the client's
`api.dismissSubagent` and `dismissSubagent` store action, the panel's
`dismiss moon` control, and their tests. ADR
[[dismissal-marks-the-agent-only-the-map-reads-it]] is superseded by this
spec, and so is [[the-detail-panel-does-not-list-subagents]], whose own “if
it comes back” asked for exactly this: a single collapsed count, designed on
the canvas first.

`MOON_STATES` keeps its `ended` entry; it costs nothing and the drawing code
is not the subject here.

## 6. Scope

In: the chip, the dropdown and its row states, `endedAt`, the detached
window's swap layout and the grow answer, finished moons leaving the map,
dismissal removed.

Out: stopping or messaging a subagent from the list — it navigates and does
nothing else. Subagents from earlier sessions. Depth-2 agents. Brackets on the
main window's moon for a subagent open in a detached window.

## 7. Acceptance

- The transcript is exactly as tall as it is today: 0 px added to the header.
- A session with no subagents shows no chip and no empty slot.
- From an open subagent you can jump to another one without going back first.
- In a 500 px detached window you can reach any subagent and get back to the
  composer in two clicks.
- Elapsed time ticks on running rows and is frozen on every other row.
- An agent that ends leaves the map at once; its row moves to `DONE` and its
  transcript still opens.

## 8. Units and tests

Tests only where they can catch a regression that is not “someone changed
the value” (root `CLAUDE.md`).

- `web/src/lib/subagentList.ts` (new, pure): chip segments from a subagent
  list; grouping and ordering of rows; a row's elapsed ms; `isOpenable`.
  **Tested.**
- `web/src/lib/sessionWindowLayout.ts` (new, pure): pane-or-swap from the
  window width, the answered width and the threshold; when the answered
  width is dropped. **Tested.**
- `web/src/ui/Menu.tsx`: headings, `selected`, scroll ceiling, custom row
  body. **Tested**: arrows skip headings; `selected` is reflected in
  `aria-current`. (Existing `menu.test.tsx`.)
- `web/src/panels/SubagentChip.tsx` (new): the chip and its `MenuButton`.
  Not tested beyond the pure logic above.
- `web/src/panels/DetailPanel.tsx`: chip in row 4.
- `web/src/SessionWindow.tsx`, `web/src/panels/SubagentPanel.tsx`: swap
  layout, row 1 with `← session` and the chip, footer wording, hidden-not-
  unmounted detail panel.
- `web/src/lib/desktop.ts`, `desktop/src/preload.ts`, `desktop/src/main.ts`:
  `setSubagentPanel` returns the window's resulting width. `desktop/src/lib/
  sessionWindows.ts`'s decisions are unchanged and keep their tests.
- `web/src/lib/subagentPanel.ts`: `elapsedMsFor` prefers `endedAt`.
  **Tested** (existing suite).
- `server/src/transcript/subagents.ts`: `endedAt` on both ending paths,
  dropped on resume, compared by `sameAgents`; dismissal removed.
  **Tested** (existing suites updated).
- `server/src/api/routes.ts`, `shape.ts`, `index.ts`: dismiss route and set
  removed. The route test that pinned “200 after dismiss” goes with it.
- `web/src/map/sceneModel.ts`: ended moons filtered. **Tested** (existing
  scene model suite).
- `web/src/store/store.ts`, `web/src/lib/api.ts`, `web/src/lib/types.ts`:
  `dismissSubagent` removed, `endedAt` added.
- Docs: the two ADRs set to `superseded` with a pointer here; subagent panel
  spec § 4 gets a note; the detached-window spec's subagent section gets a
  pointer to § 4 here.
