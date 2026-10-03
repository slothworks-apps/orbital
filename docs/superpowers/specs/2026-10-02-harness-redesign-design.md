---
id: 2026-10-02-harness-redesign-design
title: Harness redesign — rebuilding the feature against "Feature - Harness"
status: done
type: spec
domain: sessions
related:
  - 2026-09-30-session-harness-design
  - 2026-09-30-assisted-harness-templates-design
  - 2026-09-30-harness-lucky-and-step-records-design
tags:
  - harness
  - experimental
---
# Harness redesign

The harness UI was built from existing panels without a design. Claude
Design now draws it in "Feature - Harness.dc.html", artboards 30a–30n
(30a-d is the chosen header variant; 30a, 30a-b, 30a-c are not chosen).
This spec holds what was agreed with the maintainer on top of the
artboards: where the design asks for behaviour that does not exist yet, and
where it was overruled.

## Agreed before the design

- **Template scope.** A template is global or belongs to one project. The
  project is the git repository root of the session's directory (worktrees
  of one repository share templates); outside git, the directory itself.
  The start view offers this project's templates first, then the global
  ones, never another project's (30c). Settings filters by scope (30j).
- **Drafting model.** Opus by default, Sonnet as the cheaper choice, for
  both "Fill this editor" and the conversation (30l). Today both are
  `model: 'sonnet'` (`server/src/index.ts`, `web/src/panels/HarnessTemplates.tsx`).
- **Example-session picker** rows carry project, tags and when the session
  last ran, with search (30l).
- **The entry toggles the panel**, like the other side-slot panels.

## New behaviour the design asks for

1. **Placement (30a-d).** No chip in the state row. A session with a
   harness gets a pill on the session panel's edge that toggles the
   harness panel and fades out while it is open; starting a harness is a
   strip button shown only while the session has none.
2. **A waiting gate is the session's state.** The state row and the map
   show NEEDS YOUR OK, counted under NEEDS INPUT, steady (30a-d, 30i).
   Today the session's status knows nothing of the harness.
3. **Orbital's own messages in the transcript** (sent on, nudged, stopped
   for you) render as dashed ◆ rows, not as the user's bubbles (30b). They
   have to be recognisable in the transcript after a restart.
4. **"Decide myself"** stops a running review and leaves the gate to the
   user (30d). Today a review cannot be aborted; the user's decision only
   wins over its result.
5. **Paused with lucky on**, the reviewer still decides gates; nothing is
   sent on (30f). Today a pause stops the review as well.
6. **Records outlive Remove and Go back.** Remove keeps the step records,
   readable from session stats → Harness (30b dialog); Go back keeps the
   later steps' records, marked "before going back" (30e). Today Remove
   deletes the row and reopen wipes the later steps' state.
7. **The reviewer's model** is the session's model unless the template
   names one (30 scope note). Today it is fixed to Opus.
8. **"Session ended" pause** (30f): when the session ends mid-run, the
   harness can be carried into a new session started from Clear.
9. **A conversation draft is a draft.** The interview session writes the
   template as a draft that is saved only by Save in Settings (30l). Today
   `harness_save_template` saves it outright.
10. **Smaller:** Copy record as Markdown; the full-window morning view with
    steps, record and diff side by side (30h); Duplicate and Move to on a
    template; the editor marks an unused input and an unknown `{{key}}`
    (30k); events `went back` and `removed` (30g); the log folds into each
    step's record (30g); Remove through Orbital's dialog, not
    `window.confirm`.

## Overruled or settled differently

- **The reviewer is not a moon.** 30i draws it orbiting like a subagent;
  it stays a background call shown only as the step's REVIEWER READING
  state and its verdict in the record.
- **Shortcut ⌘⇧H, not ⌥H.** ⌥ with a letter types a character on the Czech
  layout, and ⌘H is macOS's Hide, kept by the `appMenu` role.
- **Caps keep today's defaults** (`maxAutoRounds` 150, `maxIdleNudges` 5,
  `maxReviewerReopens` 5); the numbers in 30f and 30k are examples.
- **The drafting session is listed nowhere.** It lives on the map while it
  runs and appears in no history, sidebar list or example-session picker,
  during or after. Its CLI transcript stays on disk like any session's.

## As built (server)

The server side and the web's type/API mirror (`web/src/lib/types.ts`,
`web/src/lib/api.ts`). Migration `0023_harness_redesign`.

### Templates and scope

- A template carries `scope: { kind: 'global' } | { kind: 'project', root, name }`
  and `draft: boolean`. `root` comes from `projectRootOf(cwd)`
  (`server/src/harness/project.ts`): the git repository's root, a linked
  worktree mapped to its main working tree, a submodule its own project,
  outside git the directory itself; `name` is the basename.
- `GET /api/harness/templates` → `{ templates }`, every template, drafts
  included. `?scope=global` or `?project=<dir>` narrows to one scope.
  `?sessionId=` → `{ project, templates }`: that session's project's saved
  templates first, then the global ones; never a draft, never another
  project's (30c).
- `GET /api/harness/projects` → `{ projects: [{ root, name, lastAt, templates }] }`,
  newest first: every project a session ran in plus every project a
  template belongs to. `templates > 0` are Settings' filter chips (30j); the
  whole list is 30m's ONE PROJECT picker.
- `POST /api/harness/templates` takes `scope?` (absent: global) and `draft?`.
  `PUT /api/harness/templates/:id` keeps a scope it does not name — sending
  one is Move to — and clears `draft` unless the body says `draft: true`
  (Save clears it). `POST /api/harness/templates/:id/duplicate { scope? }`
  → 201, a saved copy named "<name> (copy)".
- Options gain `reviewerModel: string | null`: null runs the reviewer on the
  session's model (`model`, else `resolvedModel`, else `opus`).

### Drafting

- `POST /api/harness/templates/draft` takes `model: 'opus' | 'sonnet'`
  (default `opus`).
- `POST /api/harness/interview { scope?, model?, cwd?, permissionMode?, sessionId? }`
  → 201 `{ sessionId }` starts the conversation, `purpose: 'harness_draft'`.
  `cwd` defaults to the scope's project root (a global scope needs one);
  `sessionId` is an optional browser-minted v4 UUID, as for `POST /api/sessions`,
  so the client can subscribe before the launch. 403 while the feature is off.
- `harness_save_template` saves a draft: into the interview's scope, or for
  any other session into its own project. A second save from the same
  session updates that draft while it is still a draft.

### The run

- `SessionHarness` gains `pauseKind` (`user | nudge_cap | message_cap |
  review_failed | send_failed | session_ended`), `pausedAt`, `removedAt`.
  Pause reasons use 30f's wording.
- `StepState` gains `reviewing` (REVIEWER READING; persisted, cleared at
  startup with a `review_aborted { by: 'restart' }` event and the gate left
  to the user), `reviewerOff` (the user took the gate; no review until it
  leaves the gate or lucky is turned on anew), `unsentFindings`, and
  `previousRuns: [{ …the step's record, endedAt, reason: 'went_back' | 'reopened' }]`.
- `POST /api/sessions/:id/harness/steps/:index/decide-myself` → `{ harness }`:
  aborts the review (the SDK query's `AbortController`), marks `reviewerOff`.
  409 unless the step waits at its gate.
- Paused with lucky on, a gate is still reviewed. Approve: the step is done
  and the next one active, not sent. Send-back: the findings are held
  (`unsentFindings`). Lucky on while a gate waits starts a review, paused or
  not; lucky off during a review aborts it (`review_aborted { by: 'lucky_off' }`).
  Auto-continue back on continues from the current step: a waiting gate goes
  to the reviewer, held findings are sent, a step never sent is sent, and a
  session waiting for input is treated as a turn that just ended.
- Inputs are required unless the hint contains "optional": attach answers
  400 `{ error: '<label> is required' }`.

### Remove, go back, carry over

- `DELETE /api/sessions/:id/harness` keeps the row with `removedAt`.
  `GET /api/sessions/:id/harness` → `{ harness, removed, events }`: `harness`
  is the live one, `removed` the removed one (its records, for session stats
  → Harness). Attaching again replaces the removed row; its events stay in the
  log, so filter a harness's events by `at >= harness.createdAt`. `?limit=`
  (up to 2000) and `?before=<event id>` page the log, newest first.
- `POST /api/sessions/:id/harness/steps/:index/go-back` → `{ harness }`: the
  step becomes active, later steps pending, each one's record kept in
  `previousRuns`. The conversation's rewind stays the client's. `…/reopen`
  on a waiting gate keeps the record as a `reopened` run; on a finished step
  it is go-back.
- Ending a session (End, Clear, the trash) with steps left pauses its
  harness, `pauseKind: 'session_ended'`.
- `POST /api/sessions/:id/clear { startNew: true, carryHarness: true }` →
  `{ ok, sessionId, harnessCarried }`, and `POST /api/sessions/:newId/harness/carry
  { fromSessionId }` → `{ harness }`: the harness moves to the new session
  with its records and its log, unpaused; the step it stood at is sent as
  the kickoff (a waiting gate is named, not redone). The old session keeps
  it as removed.

### Events

New kinds `went_back`, `removed` (`{ done }` or `{ carriedTo }`),
`review_aborted` (`{ by: 'user' | 'lucky_off' | 'restart' }`) and
`carried_over` (`{ from }`). Every step event carries `step` (id) and
`index`. `ticked` carries `verify: 'passed' | null` and `gate`; `nudged`
carries `n` and `of`; `approved` carries `by`; `paused` carries `kind`.

### Session state and the transcript

- `ApiSession.harnessGate: 'waiting' | 'reviewing' | null`, and
  `ApiSession.purpose: 'harness_draft' | null`. A session Orbital runs whose
  harness gate is `waiting` reads `needs_input` even asleep (`statusOf`); a
  live one already does when its turn ends. The session is republished
  whenever its gate flips. Notifications are unchanged: a gate notifies as
  any `working → needs_input` turn end does.
- `GET /api/sessions` leaves out an ended `harness_draft` session; ending one
  publishes `remove` on `sessions`. An open one is listed with its `purpose`
  for the map; the client keeps it out of every list.
- Orbital's messages (`kickoff`, `advance`, `nudge`, `findings`) are recorded
  by the uuid of the user entry they became (`harness_messages`).
  `GET /api/sessions/:id/messages` marks those rows
  `harnessMessage: { kind, step }` (0-based), after any restart. Live, the
  hub sends `{ event: 'harness_message', message: { uuid, kind, step, text, at } }`
  on `session:<id>`.

## As built (web, session side)

- **The pill** (`web/src/panels/HarnessPill.tsx`, 30a-d): mounted by
  `DetailPanel` outside the panel's clipping shell, so it works in the main
  window and the detached window alike; in a detached window with nothing
  beside the panel it sits inside the window's edge instead of half over it.
  Its glyph, segments and flyout come from `pillReading`
  (`web/src/lib/harnessSession.ts`). A click and ⌘⇧H (`session.harness`,
  Session menu) call `openHarness`, which toggles; ⌥-click opens it straight
  into the full window (30h) through `harnessPanel.full`.
- **Start a harness** is a strip button after stats (`stripFold`), shown
  only while the session is known to have no live harness; it folds into
  the ⋯ menu with stats, clear and detach.
- **NEEDS YOUR OK**: `gateWaits` makes `asksForHuman` true, so a waiting
  gate is `needs_input` everywhere (state chip, sidebar row, map pill,
  summary count, the phone's NEEDS INPUT group); `stateDot(…, gate)` holds
  its dot steady and the planet goes without the needs-input ripple.
- **Transcript**: `withHarnessRows` turns Orbital's messages into
  `role: 'harness'` rows and lays the log's events in by time; the transcript
  pages the log (`loadOlderHarnessEvents`) back to its oldest held message.
  The kickoff, sent-on and nudge events have no row of their own — their
  messages are the row.
- **Clear** offers "Continue the harness in the new session", on by default,
  whenever the harness has steps left (running or paused, `session_ended`
  included); with "don't ask again" the default applies unasked.
- **Listed nowhere**: `isListable` / `listableSessions` (store) drop a
  `harness_draft` session from the sidebar, history, search and the phone's
  list; the map still draws it while it runs.
- **Session stats → Harness**: a section of the quick-stats dialog that
  mounts the panel's `HarnessRecordView`.

## As built (web, the panel and Settings)

- **The panel** (`web/src/panels/HarnessPanel.tsx`, `web/src/panels/harness/`):
  start view (30c), the checklist with the 30d markers, the record and its
  diff (30e), the controls and Remove dialog (30f), the log folded into the
  steps (30g), the full window (30h). Pure parts with tests: the diff parser
  (`patch.ts`), the marker and wording derivation (`model.ts`), Copy record
  as Markdown (`markdown.ts`).
- **Settings → Harness templates** (`web/src/panels/harnessTemplates/`): the
  list with the project filter (30j), the editor (30k), the Draft… popover
  with the example-session picker (30l), the empty state and the scope
  popover (30m). Opened pre-focused through `harnessTemplatesFocus`.
- **Settled during the canvas fidelity pass** (2026-10-03):
  - the full window's frame is opaque, and its three columns are shares
    (340 · 480 · 520) rather than fixed widths, because 30h assumes the
    56 px rail and an open sidebar left the record about 230 px;
  - a gate the reviewer approved unsure opens by default, as 30d A draws it;
  - the step diff route also returns `commits` and `pushed`, for "3 commits"
    and "local, not pushed";
  - a step's `verify` command gets its `{{key}}` inputs filled like the
    rest of the step, and the interview conversation starts from the
    description typed in the popover;
  - a project scope is stored as the resolved repository root, so a path
    through a symlink (`/tmp` → `/private/tmp`) still matches its sessions.
