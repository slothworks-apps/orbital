---
id: 2026-10-06-harness-in-the-timeline-design
title: The harness lives in the timeline — one panel for a session's thread
status: draft
type: spec
domain: sessions
related:
  - 2026-10-06-session-timeline-design
  - 2026-10-02-harness-redesign-design
  - the-harness-lives-in-the-timeline
  - the-phone-tunnels-the-api-behind-an-allowlist
tags:
  - harness
  - timeline
  - experimental
  - web
  - mobile
---
# The harness lives in the timeline

Builds on [[2026-10-06-session-timeline-design]], which must land first:
there the timeline lays a harness's steps in as sections and leaves the
harness panel alone. This spec folds the harness panel into the
timeline, so a session has one panel for its thread, with or without a
harness.

## Problem

A session running a harness has two panels that tell the same story
from two sides: the harness panel (the checklist, a step's record and
its diff, the controls) and the timeline (prompts, decisions, branches,
compactions). They compete for the one side slot, and the step that the
checklist shows is the same span of transcript that the timeline shows
as a section. The user has to flip between them to see what a step
decided and what happened inside it.

## Decisions taken while brainstorming

| question | decision |
|---|---|
| one panel or two | one: the timeline is the harness's home; `HarnessPanel` as a separate side-slot panel goes ([[the-harness-lives-in-the-timeline]]) |
| what stays its own surface | the full window (30h) and the step diff (30e right): too wide for a section |
| the harness switch | still experimental; with `harness_enabled` off, the timeline has no harness |
| the phone | follow and steer a harness: steps, records, gates, pause/resume. Starting one and templates stay on the Mac |

Ruled out: keeping both panels and linking them (two places to look is
the problem); moving the timeline into the harness panel (most sessions
have no harness).

## 1. What moves where

| today (harness panel, 30a–30h) | in the timeline |
|---|---|
| pill on the session panel's edge, ⌘⇧H | opens the timeline, scrolled to the active step; ⌥-click still opens the full window |
| start view (30c) | "Start a harness" in the timeline's head while the session has none; the start view opens in the slot in the timeline's place, back returns |
| checklist with markers (30d) | the step sections; each header carries the 30d marker, number, title, status |
| the active step's instructions / done when / verify | inside the active step's section, above its events, folded after the first view |
| controls and Remove (30f) | a **harness bar** under the timeline's head: template name, progress segments (`pillReading`), pause/resume, ⋯ (remove, go back, full window, copy record) |
| the record (30e left) | pressing a done step's header expands its record in place: summary, decisions, open questions, reviews, earlier runs |
| the diff (30e right) | "diff" in a record opens `StepDiffView` in the slot in the timeline's place; back returns to the same scroll position |
| the log folded into the steps (30g) | quiet rows inside their step: nudged, reviewer verdict, went back, reopened |
| a waiting gate (NEEDS YOUR OK) | the gate's section opens itself only when the user opens the timeline; approve / reopen / decide myself sit in it |
| full window (30h) | unchanged, opened from the bar's ⋯ |

The step's recorded `decisions` are `decision` events of the timeline
(as in the timeline spec); expanding the record shows their `why` and
`alternatives`.

A step section contains the timeline's ordinary events between its
`startMessageUuid` and the next step's start. Orbital's own harness
messages (kickoff, sent on, nudge) are not `prompt` events; they are the
section's header and the log rows.

The transcript is untouched: `withHarnessRows` keeps drawing the dashed
◆ rows.

## 2. Code

- `HarnessSlot` and the `HarnessPanel` side-slot entry go. `HarnessBody`,
  `RunningView`'s step parts, `RecordView`, `StepDiffView`,
  `FullWindow`, `StartView` and `dialogs.tsx` are reused by the timeline
  panel; the slot's nav (`HarnessNav`) becomes the timeline panel's nav
  (`timeline | start | diff(index)`), records expand inline instead of
  being a nav state.
- `openHarness` / `harnessPanel` in the store become
  `openTimeline({ focus: 'harness' })`; the Session menu's ⌘⇧H entry
  keeps its key.
- Session stats → Harness keeps mounting `HarnessRecordView` for a
  removed harness.
- No server change on the Mac beyond the allowlist (§ 3); the timeline's
  build already joins the harness.

## 3. The phone

Built for the phone, partly, on purpose:

- **In:** the timeline sheet shows step sections with markers and
  status, the harness bar (name, progress, pause/resume), each done
  step's record expanded in place, and a waiting gate's approve /
  reopen / decide myself. A waiting gate is already NEEDS INPUT on the
  phone's list; opening the session now lets the user answer it there.
- **Out, on purpose:** starting a harness, templates, go back, remove,
  the diff and the full window. Starting needs the template list and
  inputs, and go back and remove are rare and destructive; the diff
  needs width the phone does not have. Written up as
  [[start-a-harness-from-the-phone]].
- Allowlist (`server/src/remote/allowlist.ts`): `GET
  /api/sessions/:id/harness`, `PATCH /api/sessions/:id/harness`,
  `POST …/steps/:index/approve`, `…/reopen`, `…/decide-myself`. The
  allowlist checks method and path only; `PATCH` also takes `options`,
  which the phone's client never sends. Letting it through is no new
  power: a paired phone can already send the session any message.

## 4. Testing

- The allowlist: the five entries pass; the template, start, go-back,
  delete and diff routes stay refused.
- The timeline panel's nav: diff → back restores the timeline; start →
  started harness lands on the timeline with the first step active.

No tests for which parts render where.

## 5. Canvas

Claude Design draws it in `Feature - Timeline.dc.html`, artboards
32a–32f, next to the timeline's 31a–31h, reusing the harness parts of
`Feature - Harness.dc.html` (30a–30h).

### Prompt for Claude Design

> Extend **Feature - Timeline** with artboards **32a–32f**: the harness
> moves into the timeline panel (31a–31h), and the separate harness panel
> (Feature - Harness, 30b/30d/30e/30f/30g) goes away. Reuse the harness's
> existing parts — the 30d step markers, the pill's progress segments,
> the record's layout from 30e, the dashed ◆ language for Orbital's own
> messages — so it reads as the same feature in a new home. Orbital's
> principles hold: a waiting gate is calm (NEEDS YOUR OK, steady, no
> alarm colour), nothing blinks, no counters.
>
> Artboards:
> - **32a** desktop, a running harness: the timeline's head, a
>   **harness bar** under it (template name, progress segments,
>   pause/resume, ⋯), step sections each holding the timeline's ordinary
>   events (prompts, decisions, branches, commits), the active step's
>   instructions / done when / verify folded at its top.
> - **32b** a done step's header pressed: its record expanded in place
>   (summary, decisions with why and alternatives, open questions,
>   reviewer verdicts, earlier runs) and the "diff" link; the harness log
>   rows (nudged, verdict, went back) as quiet rows inside the step.
> - **32c** a gate waiting: NEEDS YOUR OK in its section with approve /
>   reopen / decide myself, the reviewer reading state, and the pill on
>   the session panel's edge that opens this view.
> - **32d** no harness yet: "Start a harness" in the timeline's head, and
>   the start view (30c) occupying the slot in the timeline's place with
>   a back affordance; the same for the diff (30e right).
> - **32e** the bar's ⋯ menu (remove, go back, full window, copy record),
>   and a paused harness with each pause reason's wording (30f).
> - **32f** phone: the timeline sheet with step sections, the harness bar
>   with pause/resume, a waiting gate answered from the phone, and a done
>   step's record expanded; no start, diff or full window.
