---
id: 2026-10-06-session-timeline-design
title: Session timeline — the thread of a long session, next to its transcript
status: draft
type: spec
domain: sessions
related:
  - why-orbital
  - the-timeline-is-built-on-the-server
  - narration-is-written-by-a-separate-reader
  - 2026-09-28-context-compaction-design
  - 2026-10-02-harness-redesign-design
  - 2026-10-06-harness-in-the-timeline-design
  - the-phone-tunnels-the-api-behind-an-allowlist
tags:
  - timeline
  - transcript
  - web
  - mobile
---
# Session timeline

## Problem

Some sessions run for hours. They spawn subagents and background tasks,
branch into side work, get compacted, and pick the main line up again.
The transcript holds all of it, but as one long scroll, and the user
loses the thread in three moments:

- **In the middle of long work:** where is the main line, which side
  branches are still open?
- **After a compaction:** what does the agent still know verbatim, and
  what only through the summary?
- **Looking for one moment:** "we decided that somewhere" — where?

A harness gives a session a skeleton of steps with recorded decisions.
Most sessions do not run one, and they need a skeleton too.

## Decisions taken while brainstorming

| question | decision |
|---|---|
| what the timeline is built from | the transcript, deterministically, by default; no model |
| model-written phases and decisions | an optional **reader**, switched on per session; it annotates from that moment on and its notes layer into the same timeline |
| where it lives | a docked panel in the side slot next to the session, like the harness and subagent panels |
| which sessions | every session, terminal ones included; the reader only for sessions Orbital started |
| the phone | everything, the reader's switch included |
| where it is computed | on the server, from the whole transcript ([[the-timeline-is-built-on-the-server]]) |
| the harness | v1 lays harness steps in as sections; the harness panel stays. Folding the panel into the timeline is its own spec ([[2026-10-06-harness-in-the-timeline-design]]) |

Ruled out: computing it in the client (the transcript pages older
history in on scroll, so a long session's beginning is missing exactly
where the timeline is needed most); extending the stats per-turn
timeline (`TurnWaterfall`, built for metrics and re-parsed per request
behind the stats switch — its turn segmentation is reused as code, not
as a place); a reader that runs on every session automatically (spends
tokens on sessions nobody opens).

Out of scope: a timeline across sessions; editing or deleting events;
the reader writing back into the session.

## 1. What the timeline holds

A list of events in transcript order. Each has a time, a kind and an
anchor: the `uuid` of the transcript entry it points at. Only the
user's side and what branches off the main line are events; the
agent's text and tool calls stay in the transcript.

| kind | from | shows |
|---|---|---|
| `prompt` | a user message that is not Orbital's own (harness rows, walkthrough tag), not a slash-command echo, not a tool result | its first line, clipped; images as a count |
| `decision` | an `AskUserQuestion` tool_use and its answer; an `ExitPlanMode` approved or declined; with a harness, a step's `decisions` | question → chosen option(s); "plan approved" / "plan declined" + the plan's first heading |
| `branch` | an `Agent` tool_use (subagent) or a background Bash task | its description, running / done / failed; pressing it opens the subagent or task panel |
| `compaction` | a `compaction` row | manual or auto, tokens before → after; expands to the summary the agent carried over |
| `commit` | a Bash tool_use running `git commit` with a successful result | the subject line and short hash from the result's `[branch hash] subject` line |
| `pr` | a Bash tool_use running `gh pr create` with a successful result | the PR URL's number, opens the URL |
| `rewind` | a `rewind` row | "history taken back here", with how many messages were hidden |
| `note` | the reader (§ 3) | a phase title or an inferred decision |

A `prompt` immediately answered by a `decision` the same turn is not
merged: they are two lines, because the decision is what one looks for.

### Chapters

Compactions cut the session into **chapters**. Everything before the
latest compaction is what the agent knows only through a summary; the
timeline draws it **dimmed, with a quiet label** ("before compaction —
the agent has the summary, not the messages"). Earlier chapters fold to
one line each (its first prompt, its event count) and expand on press;
the current chapter is open.

With a harness running, its steps are sections inside the chapters: a
step's header (number, title, status) sits at its `startMessageUuid`,
and its recorded `decisions` appear as `decision` events at the step's
tick. Nothing else of the harness is drawn in v1.

With the reader on, its **phases** are sections too (§ 3). Where a
harness step and a phase both start, the step wins; phases are not drawn
inside a harness run.

### Filter

A row of four toggles under the panel's head: **Prompts · Decisions ·
Branches · Compactions** (commits, PRs and rewinds ride with Branches).
All on by default. A search field filters by text over every event's
label. Both are panel state, not persisted.

## 2. The panel

Entry: a button in the session's utility strip (desktop) toggles the
panel in the side slot. It shares the slot like the other side-slot
panels; opening it closes whichever held the slot.

```
┌ Timeline ─────────────────── ⟳ reader  ✕ ┐
│ [Prompts][Decisions][Branches][Compact.]  │
│ ⌕ filter…                                 │
│                                           │
│ ▸ Chapter 1 · "set up the relay" · 23     │  ← folded, dimmed
│ ▸ Chapter 2 · "pairing flow" · 41         │  ← folded, dimmed
│ ─── compacted 14:02 · auto · 182k → 9k ── │  ← expands to summary
│                                           │
│ 14:05  ● fix the reconnect loop when…     │  prompt
│ 14:07  ◆ Retry strategy? → backoff 1–30s  │  decision
│ 14:09  ⑂ Explore: map socket lifecycle ✓  │  branch (done)
│ 14:21  ⑂ Bash: npm test --watch  ·running │  branch (running)
│ 14:30  ● now the phone side               │
│ 14:31  ◆ plan approved: "Phone reconnect" │
│ 14:58  ⎇ fix(mobile): reconnect… a1b2c3d  │  commit
│ 15:03  ● ▶ you are here                   │  ← the transcript's viewport
└───────────────────────────────────────────┘
```

- **Press an event** → the transcript scrolls to its anchor and the row
  is marked for a moment (the same quiet mark the compaction reveal
  uses). If the anchor is older than what the client has paged in, the
  transcript pages older history in until it is there (§ 4).
- **Where you are:** the events whose anchors are inside the
  transcript's viewport are marked in the timeline, so scrolling the
  transcript moves the mark. The timeline follows only while the user
  is not scrolling it.
- **Live:** new events append while the session runs. A running branch
  shows its state as text and a steady dot, never a blink
  ([[why-orbital]] § Nothing blinks).
- The panel has no counters, no unread marks, and does not open itself.

## 3. The reader

An optional, per-session annotator, off by default. It is a separate
reader of the visible record, outside the session, shaped like the
walkthrough's narrator ([[narration-is-written-by-a-separate-reader]]):
nothing it does is ever seen by the session, and its failures are not
the session's failures.

- **Switch:** the `⟳ reader` toggle in the panel's head, on Orbital
  sessions only (terminal sessions show no toggle). Turning it on
  records `readerFrom` = the newest message's uuid; the reader never
  reads before that. Turning it off stops it; notes it wrote stay.
- **When it runs:** when a turn ends (the session goes idle or waits for
  input), and after a compaction, if at least one new user prompt
  arrived since its last run. One run at a time per session; a run that
  is due while one is going is folded into the next.
- **What it reads:** a digest of the messages since its last mark: the
  user's prompts in full, the agent's text clipped, tool calls as name +
  target (file, command, agent description) without outputs, plus the
  titles of the phases it wrote so far, for continuity.
- **What it writes:** JSON validated on arrival —
  `phases: [{ title, fromUuid }]` (a new phase only where the work
  turned) and `decisions: [{ what, why, uuid }]` for choices made in free
  text that no structured event covers. Unknown uuids are dropped.
- **Model:** a `timeline_reader_model` setting, Haiku by default; the
  reader's cost is one small one-shot query per turn. Billed like the
  titler and the narrator.
- **Storage:** a `timeline_notes` table (session id, kind, uuid, title,
  why, run id, created at) and the session's `readerFrom` / last mark in
  a `timeline_readers` row. Survives restarts; removed with the session.
- **Failure:** recorded in the error log, never announced
  ([[errors-are-recorded-not-announced]]). The head's toggle shows
  "reader paused — last run failed" in its tooltip; the next turn
  retries.

**How notes look:** a phase is a section header in the reader's own
style, distinct from a harness step and from a chapter. An inferred
decision is a `decision` row marked as inferred (outline glyph instead
of filled, "noted by reader" on hover), because it is an
interpretation, not something the user picked. A thin rule at
`readerFrom` says "reader on from here".

## 4. Server and web

**Server** — `server/src/timeline/`:

- `build.ts`: pure; the session's full parsed message list
  (`presentTranscript`, already cached per file stamp), its subagents,
  its background tasks, its harness and its reader notes in → `Timeline`
  out (`{ events, chapters, reader: { on, from, failing } }`). The
  turn and tool segmentation is lifted from `stats/compute.ts`, not
  duplicated.
- `reader.ts`: the reader's scheduling, digest, query and parse; the
  narrator's `NarrateQueryFn` shape.
- Routes: `GET /api/sessions/:id/timeline` and
  `PUT /api/sessions/:id/timeline/reader` (`{ on: boolean }`; 409 for a
  terminal session).
- Live: a `timeline` event on the session's WS topic whenever the
  timeline of a watched session changed (new message, subagent or task
  state, notes written); the client re-fetches. Republished only for
  watched sessions ([[ambient-changes-republish-only-watched-sessions]]).

**Web:**

- `web/src/panels/TimelinePanel.tsx` in the side slot; its rows in
  `web/src/panels/timeline/`.
- A store action `revealMessage(sessionId, uuid)` that pages older
  history in until the uuid is present, then scrolls `TranscriptView`
  to it. The compaction reveal (`TranscriptView.tsx` around 790) moves
  onto it. Transcript rows carry `data-uuid` for the reveal and for the
  "where you are" observer.

## 5. The phone

Built for the phone too, in full.

- `SessionScreen` gets a timeline button in its header; it opens the
  timeline as a full-height sheet over the transcript. Pressing an event
  closes the sheet and reveals the anchor in the transcript.
- Same routes; both added to `server/src/remote/allowlist.ts`. The
  reader's toggle works from the phone (an Orbital session only, as on
  the Mac).
- Chapters fold the same way; the filter toggles sit in the sheet's
  head; search is left out on the phone (the sheet is short enough to
  scroll once chapters fold).
- Offline (Mac asleep): the sheet shows the last timeline fetched,
  cached next to the transcript cache, with the same "as of" line.

## 6. Testing

- `build.ts`: every event kind out of real transcript shapes (fixtures
  from `server/src/transcript` tests); `AskUserQuestion` with single and
  multi select; a declined plan; commits that failed; chapters across
  two compactions; harness sections at `startMessageUuid`; reader notes
  whose uuid is gone.
- `reader.ts`: scheduling (nothing new → no run; a due run during a run
  folds), `readerFrom` honoured, invalid JSON and unknown uuids dropped.
- Routes: 404, 409 for the reader on a terminal session, the allowlist
  entries.
- `revealMessage`: an anchor three pages back is reached; a missing
  anchor stops at the beginning without looping.

No tests for the panel's rendering.

## 7. Canvas

Claude Design draws it in `Feature - Timeline.dc.html`, artboards 31a–31h
(the prompt below). This spec is reconciled against the artboards before
the build.

### Prompt for Claude Design

> New canvas **Feature - Timeline**, artboards 31a–31h, in Orbital's
> existing language (`Orbital.dc.html`: dark space background, docked
> opaque panels, hairlines, mono for times, the side-slot panel frame of
> 30b and 22b). Orbital's principles hold: nothing blinks, waiting is
> calm, no counters or badges.
>
> The feature: a **timeline panel** in the side slot next to a session's
> transcript, so the user does not lose the thread of a long session. It
> lists, in order, the user's own prompts, decisions (answers to the
> agent's questions, approved/declined plans), branches (subagents,
> background tasks, with running/done/failed), commits and PRs, rewinds
> and compactions. Compactions divide the session into **chapters**;
> everything before the latest compaction is what the agent knows only
> from a summary and should read as quieter. Pressing a row scrolls the
> transcript to it; the rows currently in the transcript's viewport are
> marked as "you are here".
>
> An optional **reader** (a small model, switched on per session) adds
> **phases** (named sections) and **inferred decisions** from free text.
> Its notes must read as interpretation — related to, but visibly
> different from, the decisions the user picked, and from harness steps.
>
> Artboards:
> - **31a** desktop, session panel + timeline panel in the side slot,
>   long session, two folded earlier chapters, current chapter open, one
>   branch running, "you are here" mark mid-list.
> - **31b** the row vocabulary on its own: prompt, decision, inferred
>   decision, branch running/done/failed, commit, PR, rewind, compaction
>   (collapsed and expanded to its summary), chapter folded/open.
> - **31c** the panel's head: title, reader toggle (off / on / last run
>   failed), close; the four filter toggles; the search field; filtered
>   state with no results.
> - **31d** reader on: phases as section headers, the "reader on from
>   here" rule, an inferred decision next to a picked one.
> - **31e** with a harness running: harness steps as sections (number,
>   title, status) with the step's recorded decisions; how a step section
>   and a reader phase differ.
> - **31f** the transcript side of a jump: the target row marked after a
>   press from the timeline; the transcript paging older history in.
> - **31g** phone: the timeline button in the session screen header and
>   the full-height sheet, chapters folded, the reader toggle in the
>   sheet's head.
> - **31h** phone: the sheet offline (Mac asleep) with the "as of" line,
>   and an empty timeline of a session that just started.
