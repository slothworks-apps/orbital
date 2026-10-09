---
id: 2026-10-05-mobile-next-design
title: Mobile, next — harness gates, files, subagents and tasks, the ⋯ sheet, limit waits and context on the phone
type: spec
status: done
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - desktop-vs-phone-feature-map
  - phone-opens-files-the-session-named
  - 2026-10-03-api-token-and-named-files-design
  - 2026-10-03-usage-limits-design
  - 2026-10-05-mobile-next
  - switch-model-and-mode-from-the-phone
  - the-phone-tunnels-the-api-behind-an-allowlist
  - 2026-10-02-harness-redesign-design
  - 2026-09-28-background-tasks-design
  - 2026-09-22-subagent-transcript-panel-design
  - why-orbital
tags:
  - mobile
  - relay
  - harness
  - file-viewer
  - limits
---
# Mobile, next

**Status: done** (open questions decided 2026-10-05, § 8; built in #23). The second batch of phone features, picked on
2026-10-05 in [[desktop-vs-phone-feature-map]] ("Decided next"). The phone
exists for oversight away from the desk; this batch lets it *see what an
agent made* and *move a stuck session along*.

**Canvas:** `Feature - Mobile next` in Claude Design, artboards 10a–10l
(a local copy sits in `.design/feature-mobile-next.dc.html`, git-excluded).
It builds on 9a–9p (`Feature - Mobile`) and keeps their frame, tokens,
glyphs and motion. The canvas is the source of truth for what the user sees
and for behaviour; where it asks for something the server cannot do, this
spec says so (§ 8, Decisions) instead of inventing it. Every literal
value — sizes, radii, inks, durations — is read from the canvas's inline
CSS, never from this document.

Parent texts that still bind: [[2026-10-02-mobile-app-design]] (the phone
as built, §§ 3–6), [[2026-09-30-mobile-remote-design]] § 3 (the allowlist
stance), [[2026-10-03-api-token-and-named-files-design]] § 2 (named files),
[[2026-10-03-usage-limits-design]] § 1 (waits).

## Decided before this spec

- **Harness gate answers are Approve · Reopen · Go back**, the desktop's
  vocabulary (`web/src/panels/harness/RunningView.tsx`, the record's "Go
  back here"). "Decide myself" appears only while the reviewer reads.
- **Queued messages during a limit wait are only listed** — no removing a
  single one (as on the desktop). The canvas's interactive "remove" in its
  demo state is not built.
- **Switching model or permission mode stays out**
  ([[switch-model-and-mode-from-the-phone]]). Model and mode remain labels.
- Out, per the canvas's SCOPE: the map, Mac settings, editing harness
  templates, editing files, starting tasks, sending input to a task,
  restarting a task, ANSI colour (stripped, as on the desktop).

## 0. Rules for all five

From the canvas header (BEHAVIOUR + RULES, ACCEPTANCE) and `why-orbital`:

- **Amber only for NEEDS INPUT and NEEDS YOUR OK.** A limit wait, a stopped
  task and a missing file are neutral. Coral only for a real failure (a
  task's exit code ≠ 0).
- **Motion as in 9p.** Working pulses, needs input breathes, a harness gate
  stays still. No spinner anywhere: loading is a reserved box plus a byte
  count. Any wait longer than five seconds becomes a sentence and a Retry.
- **Sheets move** (added 2026-10-09). Every bottom sheet rises from the
  bottom edge over a fading backdrop and sinks out the same way, however it
  was closed — backdrop, back button, swipe or an action inside it. Under
  reduced motion it appears and goes at once. A sheet is opened through
  `SheetPresence` in `web/src/mobile/ui.tsx`, which keeps it mounted while
  it leaves.
- **Mac asleep** (`isMacAsleep`): everything stays readable from the last
  sync, labelled with its age; every action that needs the Mac becomes one
  sentence saying it waits for the Mac. No control looks enabled that would
  need the Mac.
- **Terminal sessions** (`isReadOnly`): read, pin, rename, retag. Never
  end, clear, stop, cancel or answer.
- **Deliberate actions** (end, clear, go back, stop task) confirm in a
  bottom sheet with a cyan primary and an outlined Cancel, as the desktop's
  dialogs do. No red.
- **Targets.** Every new action is at least 44 px; primary and secondary
  buttons are 52 px.

## 1. Answer a harness gate (10a gate row, 10b, 10c)

### What the user sees

- **List (10a).** A session at a waiting gate joins NEEDS INPUT with the
  amber card; its reason line starts with ◆ ("◆ Harness · step 4 of 7 needs
  your OK"), the glyph's centre is a still diamond, and there is **no
  elapsed time**. Tapping it opens 10b scrolled to the gate card.
- **Session header (10b).** Row 2 reads NEEDS YOUR OK with a still diamond
  (no breathe, no timer), the step segments and "4/7 ▸". Tapping the
  segments or the count opens the **steps sheet**.
- **Gate card (10b, first phone).** The last row of the transcript, the 9c
  plan card's shell. Without expanding anything it answers "what did it do,
  what's open, what's next": GATE · NEEDS YOUR OK with "step N of M", the
  step title, WHAT IT DID (the step's summary), OPEN QUESTIONS · n (each
  question), the commit range with "✓ verify passed" when the last tick's
  verify passed, and NEXT n · <next step title>. Then **Approve → step n+1**
  (filled), **Reopen** and **Go back** (outlined), and the caption "Reopen
  sends nothing. You write what to change."
- **After an answer** the card folds into one line and the header state
  changes; nothing else on screen moves: "✓ Approved step 4 · on to step 5",
  "◆ Step 4 reopened · nothing was sent", "↺ Back at the start of step 4 ·
  the agent starts it again".
- **Go back** opens the confirm sheet (10b, second phone): GO BACK · STEP
  0N, "Go back to the start of step N?", the copy about the conversation
  returning to the message that sent the agent on to step N, the commit
  range line "… stay in git", "Orbital never resets files for you", then
  "Go back to step N" and Cancel.
- **Reopened (10b, third phone).** The card's fold line is replaced by the
  REOPENED BY YOU note; the composer opens with focus, placeholder "What
  should change in step N?", and the hint "to step N · stays a gate".
- **Steps sheet (10b, fourth phone).** HARNESS · <scope>, the harness name,
  "step n of m · <state> · started hh:mm", then the rail: ● auto, ◆ gate,
  mint done, amber waiting, hollow pending; each row with its meta line;
  done steps end in "record ›" and open the step's record. Footer legend
  "auto-continue · sent on when nothing needs you ● auto ◆ gate". Nothing
  in the sheet animates.
- **Reviewer reading (10c, first phone).** With feeling-lucky on, the gate
  is not waiting on the user: the session is not in NEEDS INPUT, the card
  is neutral and dashed (GATE · REVIEWER), says the reviewer is reading,
  names what it reads ("reading · diff <range> · <files>"), and offers one
  answer, **Decide myself**, with "the reviewer stops · the gate waits for
  you". Tapping it turns the card into 10b's waiting card.
- **Mac asleep (10c, second phone).** Header "NEEDS YOUR OK · as of …";
  the card (GATE · LAST KNOWN) stays readable at lower alpha with a short
  summary; thumbnails show when cached and are a dashed box when not; the
  three buttons collapse into one locked line, "Answer when <Mac> wakes".
  Below, the 9b divider NOTHING NEWER · MAC ASLEEP and the locked composer.
- **Harness rows in the transcript.** Orbital's own messages and the log's
  events as the desktop's dashed ◆ rows (`HarnessTranscriptRow`), so the
  phone's transcript reads the same as the desktop's.

### Behaviour and rules

- **Which session has a gate** comes from `ApiSession.harnessGate`
  (`'waiting'` → NEEDS INPUT, as today; `'reviewing'` → not). The list's
  "step n of m" comes from a new snapshot field (§ 1 Server).
- **The harness itself** is read with `GET /api/sessions/:id/harness`
  when the session opens (the store's `select` already calls `loadHarness`;
  today it is refused) and again on every `harness` event of the
  `session:<id>` topic the screen already subscribes to.
- **Approve** is one tap: `POST …/harness/steps/:index/approve`. The server
  sends the next step itself (unless the harness is paused).
- **Reopen** is one tap: `POST …/harness/steps/:index/reopen` sends
  nothing; the phone then focuses the composer. What the user writes is an
  ordinary message (`POST …/messages`).
- **Go back** always asks first. On confirm the phone does what the
  desktop's `goBackToStep` does — `POST …/harness/steps/:index/go-back`,
  then the rewind to the message that began the step (`POST
  /api/sessions/:id/rewind`, paging older transcript in to find it) — and
  then **sends the rewound message at once** (`POST …/messages`, which a
  pending rewind turns into the rewind's send). The desktop leaves that
  message in the composer for the user to send; the canvas's copy ("the
  agent starts the step again") asks for the send, so the phone sends. When
  something still runs in the session (`somethingRuns`), the sheet adds the
  desktop's line that the turn and anything running stop.
- **Decide myself**: `POST …/harness/steps/:index/decide-myself`.
- **Failure** of any answer: the card stays live and one neutral line under
  it says what failed, from the server's error (the phone's error-line
  rule, [[2026-10-02-mobile-app-design]] As built 2b).
- **Asleep**: nothing can be tapped; the card, the steps sheet and the
  records stay readable from a cached copy of the harness (`harness:<id>`
  next to `transcript:<id>`, with `asOf`, cleared with the pairing).
- **Terminal sessions** never have a harness (Orbital sends each step on
  and cannot type into a Terminal). Nothing to draw.
- **Record.** A done step's "record ›" opens a pushed sheet with the
  desktop's `RecordBody` (`wide: false`): summary, decisions, open
  questions, reviews, previous runs. Read-only; "Go back here" from the
  record is not on the phone (the gate's Go back covers the phone's case).

### Server

- **Allowlist** (`server/src/remote/allowlist.ts`), new entries:
  - `['GET', '/api/sessions/:id/harness']`
  - `['POST', '/api/sessions/:id/harness/steps/:index/approve']`
  - `['POST', '/api/sessions/:id/harness/steps/:index/reopen']`
  - `['POST', '/api/sessions/:id/harness/steps/:index/go-back']`
  - `['POST', '/api/sessions/:id/harness/steps/:index/decide-myself']`
  - `['POST', '/api/sessions/:id/rewind']` (go back only; `DELETE` stays
    off — the phone has no rewind UI and sends the rewind at once)

  Still denied on purpose: starting, removing, pausing or carrying a
  harness, its options (`PATCH`), the step diff (a whole patch, too large
  for one frame), templates and the interview.
- **New snapshot field** `harnessStep: { index: number; total: number } |
  null` on `ApiSession` (`server/src/api/shape.ts`, mirrored in
  `web/src/lib/types.ts`): the index of the first step not done and the
  step count, null without a live harness. It lets the list and the cached
  list say "step 4 of 7" without reading every gated session's harness.
- No new WS topic: `harness` and `harness_message` already ride
  `session:<id>`, which the phone may watch.

### Shared code reused

`HarnessTranscriptRow` and `withHarnessRows` (transcript rows),
`panels/harness/model.ts` (`stepKind`, `MARKER`, `railItems`,
`headerStatus`, `stepMeta`, `shortSha`, `clock`, `stepsGoingBack`),
`panels/harness/actions.ts` (`act`, `goBackToStep`, `somethingRuns`),
`RecordBody` from `panels/harness/RecordView.tsx`, `lib/harness.ts`
(`harnessProgress`, `rewindCountFor`). The card, the steps sheet and the
confirm sheet are phone components under `web/src/mobile/`; nothing in
`panels/` imports from `mobile/`.

### Acceptance (canvas, HARNESS GATE)

- A waiting gate appears in NEEDS INPUT, with ◆ and no elapsed time;
  tapping it lands on the card.
- The card shows what was done, open questions and next step without
  expanding anything.
- Approve is one tap; Go back always asks first and says that commits stay.
- The waiting gate offers Approve · Reopen · Go back. Reopen sends nothing;
  the composer opens with focus. Decide myself appears only while the
  reviewer reads.
- Asleep: the card is readable, no answer can be tapped.
- No part of the gate, card or steps sheet animates.

## 2. Images and paths (10d, 10e)

### What the user sees

- **Paths are links (10d)** — when the phone can show the file. An
  absolute or repo-relative path in agent text or a tool row whose
  extension is an image or a previewable text type (`isPressablePath`, the
  desktop's own rule) is cyan mono with a dotted underline and a 44 px hit
  area that does not change the line height — the desktop's `PathButton`
  sites (tool-row labels, input values, prose, inline code). Any other path
  (`out/lighthouse.pdf`) is **not a link**: plain mono text, as on the
  desktop. Long-press copies the path either way.
- **One viewer.** Tapping a path or a shown image opens the same
  full-screen viewer: black, chrome over the image (‹, file name, "w×h ·
  size · i of n", zoom label), pinch-zoom up to 8×, double-tap 2.5× ↔ fit,
  swipe between the images of the message the tap came from, ‹ or swipe
  down to go back. The foot reads the path and the session with the time.
- **By file type.** png / jpg / gif / webp / svg (and the other types the
  Mac's `IMAGE_FILE_CONTENT_TYPES` serves) → the viewer. Text (md, txt,
  json, log, source — `hasTextExtension`) up to 512 KB → a **read-only
  preview** with line numbers, "READ-ONLY PREVIEW · AS OF hh:mm", "Text
  files up to 512 KB preview here. Editing happens on the Mac.", Copy path
  and Wrap · on/off. A `:line` suffix scrolls the preview to that line.
- **Can't be shown.** A path that looked viewable but is not — text over
  512 KB, a file the Mac finds binary, an image over the Mac's size cap —
  opens the viewer on one plain line saying this file can't be shown on the
  phone, with the path and size, and **Copy path**. Nothing else: the phone
  never opens or runs anything on the Mac. **Deviation from canvas 10e:**
  its NOT AN IMAGE OR TEXT state ("No preview on the phone", **Open on
  <Mac>**) is not built — such a path is not a link at all, and the
  can't-be-shown line replaces it for the rest.
- **Viewer states (10e)**, all in the same image area, none red:
  - LOADING — the box reserved from w×h; a byte bar "116 of 186 KB from
    <Mac>", no spinner; bytes in → fade.
  - COULDN'T LOAD · RETRY — after a pause without a byte or a dropped
    transfer; the box stays; "The connection dropped at 40 KB." Retry.
  - THE FILE IS GONE — the Mac answered "no such file": "Not on <Mac> any
    more", no Retry; a cached copy, if any, still shows, labelled cached.
  - MAC ASLEEP · CACHED — opens at once, zooms as usual, one chip "cached ·
    as of …".
  - MAC ASLEEP · NOT CACHED — "Opens when <Mac> wakes. Not on this phone
    yet. Stay here and it loads on its own." The box from the last-known w×h
    if the phone has it, else none; nothing moves.
  - CAN'T BE SHOWN — as above (replaces 10e's NOT AN IMAGE OR TEXT).

### Behaviour and rules

- **What the phone may read** is exactly what the desktop's viewer may
  read for that session: inside the session's cwd, or an absolute path the
  session's transcripts name (`resolveForSession`,
  [[2026-10-03-api-token-and-named-files-design]] § 2). This is the bound
  [[phone-opens-files-the-session-named]] asked for. A refusal (`outside`)
  shows as "not on the phone" with the path, the same neutral line as the
  desktop's OUTSIDE SESSION FOLDER.
- **Bytes travel as blob frames**, never in an `http` answer: an image
  cannot ride `inject`'s string body, and a 512 KB text, JSON-escaped, does
  not fit one relay frame (`MAX_INNER_BYTES`, just under `MAX_FRAME_BYTES`).
  A new inner message does it (§ 2 Server).
- **Images inline in the transcript** (`ImageThumb`, content-addressed
  refs) keep their transport (`blob_get`) and now open the phone's viewer
  instead of the desktop `Lightbox`.
- **Loading.** The viewer shows the byte count as chunks arrive. When no
  chunk has arrived for `FILE_IDLE_TIMEOUT_MS` (the canvas's ten seconds)
  or the tunnel drops, it is COULDN'T LOAD with the bytes reached; Retry
  asks again from the start.
- **Cache.** Every image the phone has shown — transcript refs and path
  images alike — and every text preview is kept in the phone's cache
  directory, at most `FILE_CACHE_MAX_BYTES` (200 MB) in total, the least
  recently opened dropped first. Today's ref cache is unbounded; it moves
  under the same bound. A path entry is keyed by session and path and
  stores when it was read and its w×h: a file on disk can change under
  the same path, so online the phone always reads it again (and refreshes
  the entry); asleep it shows the entry with its age. A ref entry never
  goes stale (its name is its content hash). The cache is cleared with the
  pairing (`forget.ts`).
- **The phone only reads.** It never asks the Mac to open, launch or run a
  file; there is no route for it (Decision 8).
- **Copy path** copies the path as written (`copyToClipboard`).
- **Terminal sessions**: the same; reading is not driving.

### Server and shared

- **`file_get`**, a new phone → Mac inner message in
  `shared/src/remote/messages.ts`: `{ t: 'file_get', id, session, path, as:
  'image' | 'text' }`, `session` a session id, `path` a bounded string (no
  control characters, at most `FILE_PATH_MAX_CHARS`). The Mac
  (`PhoneSession`) looks the session up, confines the path with
  `resolveForSession` and the same `NamedPathCache` the routes use, and
  answers with the existing `blob_meta` + chunks:
  - `as: 'image'` → `readImageFile`; `as: 'text'` → the file's bytes when
    `readFilePreview` says it is text and it is at most
    `PHONE_TEXT_PREVIEW_MAX_BYTES` (512 KB).
  - `blob_meta.status`: 200; 403 outside; 404 no such session or file; 413
    too large (with `size`); 415 not an image / binary (with `mediaType`
    when the Mac knows it).
  - `blob_meta` gains optional `size`, `w`, `h` (the image store's
    `sniffDims`, exported) so the viewer can reserve the box and print
    "w×h · size" before the bytes arrive. Unknown keys are ignored by the
    current schema, so an older phone is unaffected.
  - `PROTOCOL_VERSION` does not change: the message is additive. A Mac
    without it drops the message as unparseable; `MIN_SERVER_VERSION`
    (§ 7) keeps a new phone off such a Mac.
- **`RemoteClient.getFile(session, path, as, { onProgress, idleTimeoutMs
  })`** in `shared/src/remote/client.ts`, beside `getBlob`, resolving `{
  status, bytes, mediaType, size, w, h }`; `onProgress(received, total)`
  per chunk; the idle timeout re-arms per chunk as `getBlob`'s does.
- No route opens a file on the Mac (Decision 8).
- `GET /api/files` and `/api/files/image` stay **off** the allowlist: the
  phone reads files only through `file_get`, so the allowlist still never
  reasons about a `path=` query.

### Shared code reused

`PathButton` and the prose/code-span path matching (`lib/pathLinks.ts`:
`findPathMatches`, `codeSpanPath`, `isImagePath`, `hasTextExtension`),
`ImageThumb` (box reservation from w×h), `lib/images.ts`, `copyToClipboard`.
Two seams in `web/`, defaulting to today's desktop behaviour:
`configureFileOpen({ open, longPress })` — what a press on a path or a
thumbnail does (the desktop: the file viewer / `Lightbox` as now; the
phone: its viewer screen), and what a long-press on a path does, linked or
not (the phone: copy; a path that is not pressable is then drawn as a plain
mono span that only carries the long-press, unconfigured it stays plain
text as today) — and a small message context so a press knows which
message it came from (for swiping). The viewer, the preview and the cache are phone
code. The desktop `Lightbox` (no zoom by design) and `FileViewer` are not
reused.

### Acceptance (canvas, IMAGES & PATHS)

Two canvas items are changed by Decision 8; the changed wording is marked.

- *(changed)* Every path the phone can show — an image or a previewable
  text type — is tappable; any other path is plain mono text that
  long-press copies. An inline image and its path open the same viewer.
- Viewer: pinch-zoom to 8×, double-tap 2.5× ↔ fit, back with ‹ or swipe
  down.
- Loading never shows a spinner; the box size never changes when bytes
  arrive.
- Couldn't load, gone, asleep and can't be shown each say what happened in
  one line, without red.
- A cached image opens offline with its age; an uncached one says it waits
  for the Mac.
- *(changed)* Text ≤ 512 KB previews read-only; a file that turns out not
  to be showable says so and offers Copy path. Nothing opens or runs on the
  Mac.

## 3. Subagent transcript and background task output (10a moons, 10f, 10g, 10h)

### What the user sees

- **Three ways in, one screen each.** The 9b moons chip (now "3 · ▣ 1")
  opens the SUBAGENTS & BACKGROUND TASKS sheet (10f, first phone):
  subagents, then tasks, each RUNNING before ended, every row 44 px ending
  in ›. A 10a moons row and a transcript chip skip the sheet and open the
  item directly.
- **10a moons row.** The expanded rows grow to 44 px and end in ›: a
  subagent opens its transcript, ▣ a task opens its output. Tasks join the
  collapsed summary after a · ("3 subagents · 2 running · ▣ 1 task").
- **Subagent screen (10f).** Header: moon dot in the tag hue · name ·
  "subagent of <parent> · <model>", then the state (RUNNING · 2m with the
  pulse, or mint DONE · 14s with "ended hh:mm" and no dot) and READ-ONLY.
  The body is 9b's rows, starting with TASK FROM <parent> (the prompt the
  parent gave it). While running it follows the tail and the cursor blinks;
  scrolling up pauses it and "following live ↓" returns. Done: the RESULT ·
  RETURNED TO <parent> block and an END OF SUBAGENT divider. No composer:
  "Subagents take no replies — its result goes back to <parent>." and
  **Open <parent>**.
- **Transcript chips (10g, first phone).** The tool row that started a
  task or a subagent carries a 44 px chip under it: glyph · name · live
  state · age · ›. It updates in place (running → exited code), so
  scrolling back still tells the truth.
- **Task output (10g).** Header ▣ <label>, "background task of <parent> ·
  <kind>", the state word (RUNNING · 3h 04m with the pulse) and **Stop**
  while it runs. The output: mono on a darker well, ANSI stripped, at most
  the last `PHONE_OUTPUT_LINES` (2,000) lines, following the tail; scrolled
  up, the pill reads "paused · N new lines · ↓ live" and new lines are
  counted, not drawn. Only new lines are drawn — no flashing, no reflow.
  Footer "following ↓ last 2,000 lines · read-only".
- **Stop, with a confirm (10g, sheet).** STOP TASK, "Stop <label>?", "It has
  run for … The process stops, its output stays readable here, and
  <parent> is told it was stopped. The session itself keeps going." —
  **Stop task** and **Keep running**. After the stop the elapsed time
  freezes and the end line reads "stopped by you after … · output frozen".
- **Ended tasks (10g, 10h).** EXITED · CODE 0 in mint, EXITED · CODE n ≠ 0
  in coral with "after … · hh:mm", "exited with code n · output frozen",
  "ended · nothing to stop". STOPPED is neutral. A path in the output
  ("refresh.ts:42") opens the text preview (§ 2) at that line.
- **10h other states.** FOLLOWING PAUSED (as above); MAC ASLEEP — "WAS
  RUNNING · AS OF …", last lines kept, no cursor, no Stop, "nothing newer ·
  Mac asleep"; OUTPUT GONE — "ENDED BEFORE THE RESTART", the header and its
  facts stay, "output no longer available"; SUBAGENT · MAC ASLEEP — the same
  as 9b offline.

### Behaviour and rules

- **Data.** Subagents and tasks ride the session snapshot
  (`ApiSession.subagents`, `backgroundTasks`), so the sheet, the rows and
  the chips update from the `sessions` topic. A subagent screen reads `GET
  …/subagents/:toolUseId/messages` and follows the `subagent:<id>:<toolUseId>`
  topic; a task screen reads `GET …/tasks/:taskId/output` and follows
  `task-output:<id>:<taskId>` — all already allowlisted and allowed. The
  store's `openSubagent` / `openTaskOutput` / `applyTaskOutputEvent` and the
  hole repair (`foldOutputDelta` → reread the tail) are reused as they are.
- **A moon without a `toolUseId` cannot be opened** (as on the desktop):
  its row has no › and does nothing.
- **The model** of a subagent is read from its own messages
  (`subagentModelFrom`) once its transcript has loaded; rows before that
  show none (Decision 2).
- **Frame bounds.** A busy subagent's buffer (`MAX_SUBAGENT_MESSAGES`) or a
  task's tail (`OUTPUT_TAIL_BYTES`) can exceed one relay frame and come back
  413. The phone asks for less (§ 3 Server): the newest
  `PHONE_SUBAGENT_PAGE` messages of a subagent, older ones counted in
  `droppedCount` as the desktop already shows them; a task tail of at most
  `PHONE_OUTPUT_TAIL_BYTES`. A hub delta too large for a frame arrives as
  `dropped`, and the next delta's offset gap makes the store reread the
  tail — the existing repair.
- **Stop** appears only on a running task, always asks once, and calls the
  store's `stopTask` (`POST …/tasks/:taskId/stop`). A 409 (it ended on its
  own meanwhile) is not an error.
- **Who stopped it.** The Mac records only `status: 'stopped'`. The phone
  says "stopped by you" for a stop it sent itself in this run and plain
  STOPPED otherwise (Decision 3).
- **Navigation.** Subagent, task and the moons sheet are pushed over the
  session; back returns to the session, not the list. While one is open the
  parent stays the store's selected session (today the session screen
  clears `ui.selectedId` on unmount, which would close the store's subagent
  and task views).
- **Asleep**: the last output and messages stay, the cursor stops, Stop is
  gone, the age is shown. **Terminal sessions** show subagents the same way,
  read-only either way; they never have tasks.

### Server

- `GET /api/sessions/:id/subagents/:toolUseId/messages` takes `?limit=n`:
  the newest n messages, with `droppedCount` raised by the number left out.
  Without it, unchanged.
- `GET /api/sessions/:id/tasks/:taskId/output` takes `?maxBytes=n`, at most
  `OUTPUT_TAIL_BYTES`: the tail is read with that bound. Without it,
  unchanged.
- `web/src/lib/api.ts`: `configureApi` gains `subagentPageSize` and
  `taskOutputMaxBytes`, which the two calls append when set; the phone sets
  both, the desktop neither.
- No allowlist change: both routes, the stop route and both topics are
  already the phone's.

### Shared code reused

`TranscriptView` (with `subagents`, `onOpenSubagent`, `backgroundTasks`,
`onOpenTaskOutput` passed from the session screen — the chips are its own),
`lib/subagentPanel.ts` (`taskStateFor`, `elapsedMsFor`,
`subagentModelFrom`, `withoutLeadingUserFrame`), `lib/backgroundTasks.ts`
(`appendOutput` with the phone's line limit, `displayLines`, `taskTone`,
`taskGroups`, `taskElapsedMs`), the store's subagent and task-output
actions.

### Acceptance (canvas, SUBAGENTS & TASKS)

- Reachable from the 10a moons row, the 9b moons chip and the transcript
  chip — each opens the same screen.
- A subagent screen shows name, model and running/done, and never offers a
  composer.
- Running output follows the tail within 1 s of the Mac; scrolling up
  pauses following.
- Stop appears only while running, always asks once, and freezes elapsed
  time.
- Ended tasks show exit code (mint 0, coral ≠ 0) or who stopped them; never
  red for a stop.
- Asleep: last output stays, the cursor stops, Stop is gone, the age is
  shown.

## 4. The ⋯ sheet and pins (10a pins, 10i, 10j)

### What the user sees

- **⋯ in the 9b header** (beside the context readout) opens one bottom
  sheet in the dropdown shell, 52 px rows, in this order: ✎ **Rename**,
  **Change tag** <current> ›, **Pin to top** / **Unpin** (with "pinned"),
  a divider, ↺ **Clear and start over** ("asks first"), **End session**
  ("asks first").
- **Confirms in place (10i).** End and Clear swap the sheet's content for
  the desktop dialog's copy — /END "End this session?", /CLEAR "Clear and
  start over?" — in the same sheet, no second layer, each listing what stops
  or carries over: "stops with it · n running subagents", "stops with it · ▣
  <task> (age)" for End; "keeps · <folder>", "keeps · <tag> · <model> ·
  <mode>", "context · 212k → 0" for Clear. Primary cyan, Cancel outlined
  directly below; tapping the backdrop cancels. After End: "✓ Ended · moved
  to Ended in the list"; after Clear: "✓ Cleared · a fresh session started
  here".
- **Rename (10j).** One field, prefilled and selected, above the keyboard;
  "only Orbital's label · the folder and branch don't change"; Cancel /
  Save; Save disabled when empty.
- **Change tag (10j).** The Mac's tags as 52 px rows with their dot, ✓ on
  the current one. Picking saves and closes. Creating or editing tags stays
  on the Mac.
- **Pin is instant.** Pin / Unpin acts on tap and closes the sheet; the row
  in 10a moves at once.
- **Terminal session (10j).** "<title> · TERMINAL"; Rename, Change tag and
  Pin stay; End and Clear are absent, not greyed; one line: "Started in
  Terminal — end or clear it there. Orbital only labels it."
- **Asleep (10j).** The sheet opens; "<Mac> is asleep — these wait for it";
  every item inert at reduced alpha.
- **Pins in the list (10a).** Pinned rows lead their group with a small pin
  after the title; NEEDS INPUT still comes first. A pinned session that
  ended stays above the ENDED fold (its own headless row, "· ended,
  pinned") until unpinned.

### Behaviour and rules

- **Routes** (all allowlisted already): `PATCH /api/sessions/:id` `{ title
  }`, `PUT …/tags` `{ tagIds: [id] }` (one tag, replacing, as the desktop's
  `selectTag`), `PUT …/pinned` `{ pinned }`, `POST …/end`, `POST …/clear` `{
  startNew: true, carryHarness? }`, `GET /api/tags`.
- **Optimistic** like the desktop: title, tag and pin change in the store at
  once and roll back with one line on failure.
- **Clear** carries an unfinished harness into the new session
  (`harnessUnfinished` → `carryHarness: true`), the desktop dialog's
  default; the new session opens in place of the old one. The "keeps" lines
  are the cleared session's own folder, tag(s), model and mode — what the
  Mac now always keeps (Decision 7, § 4 Server).
- **End** is offered only while the session is not ended; an ended
  session's sheet shows Rename, Change tag, Pin / Unpin and Clear.
- **Terminal** sessions (`source === 'terminal'`): no End, no Clear, ever.
- **Pin order.** Within a group pinned rows come first, in pin order
  (`pinnedAt`, as the desktop's PINNED section keeps it), then the rest by
  last activity. A pinned ended session leaves the ENDED
  fold and sits as a headless row above it.
- **Asleep**: labels, pins and tags are stored on the Mac, so every item
  waits; the sheet still opens.

### Server

- `PATCH /api/sessions/:id` and `PUT /api/sessions/:id/tags` publish the
  session's upsert on `sessions`, as `PUT …/pinned` already does. Today
  neither publishes, so a rename or a retag reaches no other window and no
  phone until a reload.
- **Clear keeps what it cleared** (Decision 7), on the Mac, for the desktop
  and the phone alike. `POST /api/sessions/:id/clear` with `startNew`
  starts the new session in the same folder, with the cleared session's
  model (`row.model`; a session that ran on the default stays on the
  default), its permission mode (`row.permission_mode`; null → the default
  mode) and its tags (its `manual` and `manual_removed` tag rows copied, so
  the new session's effective tags equal the old one's; rule tags follow
  from the same folder). Today the model is always `default_model`, the
  mode is inherited only with `inherit_permission_mode` and manual tags only
  with `inherit_tags`.
- **The two inherit settings go.** Clear is their only consumer
  (`server/src/api/routes.ts`; read nowhere else). Settings → Sessions
  loses the "New session inherits" row (Tags, Permission mode) under CLEAR
  & LIFECYCLE; their defaults leave `server/src/db/database.ts`; a value
  stored in an existing database is ignored. The descriptions of "Default
  model" ("… and used by Clear") and the default permission mode ("… and to
  sessions created by Clear") drop their Clear clause, since Clear no
  longer reads either default. The desktop `ClearDialog` already reads
  "inherits its settings" and lists the mode and tags; it becomes accurate
  without a change.
- No allowlist change.

### Shared code reused

The desktop's End/Clear copy (`EndDialog`, `ClearDialog` — the strings and
`harnessUnfinished`, not the `Dialog` chrome), the store's
`withSessionPatch`-style optimistic patch, `tagColor`. The sheet, its
confirm states, Rename and Change tag are phone components, built on a
`BottomSheet` primitive added to `web/src/mobile/ui.tsx`.

### Acceptance (canvas, ⋯ MENU & PINS)

- ⋯ offers Rename, Change tag, Pin / Unpin, Clear and start over, End
  session, in that order.
- End and Clear never act on the first tap; each confirm says what stops
  and what stays.
- Terminal sessions show no End or Clear, plus one line saying why.
- Pinned sessions lead their group in 10a with a pin mark; needs input is
  still first.
- A pinned session that ends stays above the ENDED fold until unpinned.
- Asleep: the menu opens, every item is inert, and one line says why.

## 5. Limit wait and context (10a limit group, 10k, 10l)

### What the user sees

- **Header (10k).** The state reads WAITING FOR LIMIT · 14:05 with a
  hollow, still dot (the desktop's status line); cancelled, IDLE · LIMIT
  UNTIL 14:05. The **context readout** sits beside ⋯ on every Orbital
  session: "used / window" and a small ring; tap → the context sheet.
- **Transcript notice (10k).** The last row: "Limit reached, continues at
  14:05", "<window> · then sends “<text>”", and **Cancel**. Cancel turns
  into **Undo** and the wording changes to "resets at" / "auto-continue
  cancelled for this wait" — the wording, never the colour. With
  auto-continue off on the Mac: "<window> · automatic continue is off", no
  button. After the reset it folds into the divider "14:05 · LIMIT RESET ·
  SENT “continue”". Times are absolute; nothing counts down.
- **Queued (10k).** While waiting, the composer's placeholder is "Queue a
  message for 14:05…"; what is sent appears as dashed bubbles "queued ·
  sent at the reset", in order, only listed.
- **10a.** A group WAITING FOR LIMIT between WORKING and IDLE, idle glyph,
  still, never amber; third line "Continues at 14:05 · 5-hour window · 1
  queued", cancelled "Limit resets 14:05 · auto-continue cancelled", asleep
  "Resets at 14:05 — continues only if <Mac> is awake then". When the
  window resets the row moves back to WORKING by itself; no notification.
- **Asleep (10k).** "WAS WAITING FOR LIMIT · as of …"; the notice reads
  "Limit resets at 14:05 · It continues only if <Mac> is awake then. Asleep,
  it stays waiting and continues when the Mac wakes."; "<window> ·
  auto-continue on · n queued"; no Cancel; NOTHING NEWER · MAC ASLEEP and
  the locked composer.
- **Context sheet (10l).** CONTEXT, "640,212 of 1,000,000 tokens · 64%",
  "Grows with every turn. Near the window, Claude Code compacts the
  conversation on its own.", "<model> · <window> window · as of hh:mm", and
  "Read-only facts. To start fresh, use ⋯ → Clear; compacting is not a
  phone action."
- **Context fill** gets brighter, never warmer: three steps of one neutral
  ink (the Plan limits fill scale) at the canvas's two thresholds; never
  amber or red. It changes per turn without animating.

### Behaviour and rules

- **The wait** is `ApiSession.limitWait`, already on every snapshot; the
  header, the notice, the queue and the list row read it. Cancel / Undo:
  `POST …/limit-wait/cancel` / `…/undo` (new allowlist entries). Nothing
  changes locally on tap; the republished session redraws the notice, as on
  the desktop.
- **Queueing** is the ordinary send (`POST …/messages`); the Mac queues it
  while a wait is open and `limitWait.queued` lists it.
- **Copy needs the Mac's two limit settings** (auto-continue on/off, the
  continuation text), which the phone cannot read (`/api/settings` stays
  denied). They ride the wait instead (§ 5 Server).
- **Context.** `contextUsedTokens` over `contextWindowFor(session, models,
  contextWindows)` (the models route is the phone's already). Unmeasured:
  "— / <window>". Unknown window: the readout shows the count alone and the
  ring is absent. Above the window: the ring full, the number as measured.
  The phone's two brightness thresholds are the canvas's, fixed; the
  desktop's own context thresholds and colours are a Mac setting and do not
  apply.
- **Fit.** The readout fits next to ⋯ at 390 px without truncating the
  title below 12 characters.
- **Terminal sessions** have no limit wait and no measured context today
  (Decision 1): the phone shows neither for them.

### Server

- **Allowlist**: `['POST', '/api/sessions/:id/limit-wait/cancel']`,
  `['POST', '/api/sessions/:id/limit-wait/undo']`.
- **`LimitWait` gains `autoContinue: boolean` and `continueText: string`**,
  the two settings as the wait is published (`server/src/limits/service.ts`,
  mirrored in `web/src/lib/types.ts`). `limitWaitCopy` takes them from the
  wait when present, the settings otherwise — the desktop reads the same
  values it reads today.
- No `limits` topic and no `GET /api/limits` for the phone: the Plan limits
  page stays "Add — later" in the feature map.

### Shared code reused

`lib/limits.ts` (`limitWaitCopy`, `formatResetAt`, `continuesAtReset`,
`limitWaitStatus`), the queued-bubble and reset-divider rows the desktop
transcript already renders, `lib/usage.ts` (`contextFractionFor`),
`lib/models.ts` (`contextWindowFor`), `lib/format.ts` (`formatTokens`,
`formatContextWindow`). `LimitWaitNotice` itself is not reused: its links
go to desktop pages (Limits, Settings) and it reads the settings. The
phone's notice is a phone component on the same copy.

### Acceptance (canvas, LIMIT & CONTEXT)

- A waiting session says when it continues (absolute time), which window,
  and how many messages are queued — in the 9b header, the transcript and
  the 10a row.
- Cancel and Undo are one tap each and change the wording, not the colour.
- Nothing about a limit wait is amber, red or animated.
- Every session's header shows used / window; it fits next to ⋯ at 390 px
  without truncating the title below 12 characters.
- Context fill gets brighter, never warmer, as it fills.
- Asleep and terminal sessions show the wait with no Cancel and no queue.

## 6. Phone answer

This feature **is** the phone: every screen above is in
`web/src/mobile/`, behind the allowlist.

### Desktop impact

This change reaches the desktop DMG and its changelog:

- **Clear keeps what it cleared** (§ 4 Server, Decision 7). On the desktop
  too, Clear and start over now always starts the new session with the
  cleared session's folder, tag(s), model and permission mode.
- **Settings → Sessions loses "New session inherits"** (Tags, Permission
  mode) under CLEAR & LIFECYCLE; Clear was the settings' only consumer.
  "Default model" and the default permission mode lose their "used by
  Clear" clause. A layout change to a Settings page: the main session
  checks it against the canvas (Settings) in its fidelity pass.
- **A rename or a tag change shows at once** in the Mac's other windows
  (the two routes start publishing the session's upsert).
- **Not visible:** the new snapshot fields (`harnessStep`,
  `LimitWait.autoContinue` / `continueText`), the optional `limit` and
  `maxBytes` query parameters, the `file_get` message, and the two `web/`
  seams (`configureFileOpen`, the message context), which default to
  today's behaviour. The desktop file viewer and `Lightbox` are untouched.

## 7. Versions

- **Desktop: minor.** New allowlist entries, the `file_get` handler,
  snapshot fields, and a behaviour change on Clear with two settings
  removed.
- **Phone (Android and iOS): minor.** Five features.
- **`MIN_SERVER_VERSION`** (`web/src/mobile/version.ts`) rises to the
  desktop version that ships § 1–5's server side, set at merge when the owner
  picks the bump. A Mac older than that shows 9i rather than half-working
  (gates that cannot be answered, files that never load).
- **Relay: untouched.** No frame changes: `file_get` is a sealed inner
  message the relay never sees, and `PROTOCOL_VERSION` stays.
- **Changelogs:** `desktop/CHANGELOG.md` — Clear keeping the folder, tags,
  model and mode (and the inherit settings gone), renames and retags showing
  at once in other windows, and the phone features the Mac now serves;
  `mobile/CHANGELOG.md` — the five features. One plain line each.

## 8. Decisions (2026-10-05)

The owner's answers to where the canvas and the server disagreed.

1. **Terminal sessions show no limit wait and no context readout.** The Mac
   makes waits only for Orbital sessions
   ([[2026-10-03-usage-limits-design]] Scope), and a terminal session's
   `contextUsedTokens` is permanently null (the desktop hides its gauge
   too). 10k's third phone cannot occur; its terminal half of the last
   LIMIT & CONTEXT acceptance item is moot. Reading usage and limit errors
   from terminal transcripts was not taken up.
2. **Subagent rows carry no model.** `Subagent` has none; the subagent
   screen shows it once its messages arrive (`subagentModelFrom`). A model
   label on moons stays ruled out (idea `subagent-model`).
3. **"Stopped by you" only for a stop this phone sent in this run;**
   otherwise plain STOPPED. The Mac records `status: 'stopped'` alone; no
   `stoppedBy` field.
4. **The gate card's thumbnails are the image paths its summary or
   evidence names** (through § 2's `file_get`); nothing otherwise. No
   screenshot field on the harness.
5. **The commit range without a count** on the card and the Go back sheet.
   No count stored on the step.
6. **Go back sends at once**, as the canvas says ("the agent starts the
   step again"). The desktop keeps leaving the rewound message in its
   composer.
7. **Clear keeps the folder, tag(s), model and permission mode** of the
   cleared session — changed on the Mac, for the desktop and the phone
   alike (§ 4 Server). The `inherit_tags` and `inherit_permission_mode`
   settings, whose only consumer was Clear, are removed with their Settings
   row (§ 6 Desktop impact). The defaults route does not change.
8. **The phone never opens or runs anything on the Mac.** No "Open on
   <Mac>" and no route for it. A path the phone cannot show (not an image,
   not a previewable text type) is not a link: plain mono text that
   long-press copies. A viewable-looking path that turns out not to be
   viewable (too large, binary) says plainly that it can't be shown on the
   phone, with Copy path. This departs from canvas 10e (NOT AN IMAGE OR
   TEXT) and from two IMAGES & PATHS acceptance items, rewritten in § 2.
9. **Absolute times only.** The canvas's "in 24m" on the 10a waiting row
   and "in 24 min" in the notice are not built; the row's right column shows
   its last activity like every other row.

## Testing

Worth a test (root `CLAUDE.md` → Tests):

- The allowlist: every new entry passes for its one method; its siblings
  stay denied (`DELETE …/rewind`, `PATCH …/harness`, `POST …/harness`,
  `GET …/harness/steps/:i/diff`, `GET /api/files`, `GET /api/files/image`,
  `GET /api/limits`); a non-numeric or traversing `:index` is refused by
  the segment rule.
- `file_get` on the Mac: inside the cwd → 200 with the bytes; outside and
  not named → 403; named absolute path → 200 through the realpath; missing
  → 404; unknown session → 404; text over the phone cap → 413; binary as
  text → 415; not an image as image → 415; `w`/`h`/`size` in `blob_meta`.
  End to end through the real relay: an image read in chunks with progress.
- `RemoteClient.getFile`: progress per chunk, the idle timeout, a non-200
  `blob_meta`, a lost tunnel mid-transfer.
- Clear: the new session has the old one's cwd, model, permission mode and
  effective tags — with a null model and mode, with a manual tag, with a
  removed rule tag — whatever the old inherit settings and the defaults
  say.
- `harnessStep` on the snapshot (no harness, mid-run, finished);
  `LimitWait.autoContinue`/`continueText`; `?limit` on subagent messages
  (`droppedCount` raised); `?maxBytes` on the task tail (bounded by
  `OUTPUT_TAIL_BYTES`); rename and retag publish the upsert.
- Phone pure logic: list grouping (WAITING FOR LIMIT between WORKING and
  IDLE, pinned first within a group, pinned-ended above the fold, needs
  input first), the gate reason line, the ⋯ sheet's items per session kind
  (Orbital, terminal, ended, asleep), the End/Clear "what stops / what
  keeps" lines, the context level steps and readout formatting, the limit
  copy from the wait's own settings, the file cache's eviction order and
  bound, file-type routing (image / text / not a link) and the
  can't-be-shown answers (413, 415), the navigation stack's back rules.

Not tested: the screens render their rows, sizes, inks, motion, the zoom
gestures (verified on a phone in the fidelity pass).

## As built (2026-10-05)

Built from [[2026-10-05-mobile-next]] by parallel tracks, then integrated
(Z1). The canvas fidelity pass (Z2) has not run yet; values below are
behaviour, not looks. Where the build departs from the text above, or
settles what it left open:

### § 1 Harness gate

- **`harnessStep` once finished** is `{ index: total, total }`; null without
  a harness or after it was removed. A paused harness still reports.
- **Reopen has no fold line.** The card shows the REOPENED BY YOU note
  (10b third phone) for as long as the step's state says reopened, so it
  also shows a reopen made on the desktop. The header's "REOPENED · YOUR
  TURN" follows the composer's reopen intent instead, which a send, the
  list or another session clears; the two can disagree after that.
- **The fold after Approve or Go back** is held in memory only and gives way
  once an assistant message newer than the answer arrives. On the last step
  Approve folds to "Approved step n · every step is done".
- **Go back** is disabled for a step without `startMessageUuid`. The phone
  pages back (bounded) to find the step's first message before it calls the
  route; when it cannot, the card's error line says so and nothing is
  changed.
- **The steps sheet's record** is a second sheet over the steps sheet with
  "‹ steps", not a pushed screen. Before the harness loads, the header
  segments are drawn from `harnessStep` alone.
- **Thumbnails** (Decision 4) are read over `file_get` through the phone's
  file cache: the image online, a cached copy asleep, the dashed "not
  cached" box only for an image never held. A tap opens the viewer on that
  one image.
- **Cache**: `harness:<id>` in Preferences holds the harness, `removed` and
  the events with `asOf`; live data always wins over it.

### § 2 Images and paths

- **Long-press** is 500 ms within 10 px (the platforms' convention; no
  canvas value). A copy shows no confirmation.
- **A tool row's image result** stands full width under its row on the
  phone, open or folded, with the ⤢ mark (10d); the expanded body keeps
  only the result's text. The desktop keeps its 96 px thumbnail.
- **Swiping** pages through the message's image refs, then the image paths
  its assistant prose names; a path pressed in a tool label or user text
  opens alone.
- **A cached path copy** stands in when the tunnel is offline or the Mac
  answers 404. A timeout or a dropped transfer is COULDN'T LOAD even with a
  copy held. Image refs (`blob_get`) keep the tunnel's default timeout and
  show no byte progress.
- **403** reads "Not on the phone — outside the session's folder" with the
  path and Copy path; can't-be-shown takes 10e's NOT AN IMAGE OR TEXT layout
  with its own words.
- **A file opened from a screen pushed over the same session** (task
  output, subagent) is pushed on top, so back returns there; from anywhere
  else the stack restarts over its session.
- **Server bounds** the text did not set: `FILE_PATH_MAX_CHARS`,
  `FILE_SESSION_MAX_CHARS`, one `NamedPathCache` shared by every phone; a
  handler error answers `blob_meta` 500, which the phone shows as COULDN'T
  LOAD.

### § 3 Subagents and tasks

- **The transcript chip** (10g) comes through a seam in `ToolRow`
  (`PhoneToolRowContext`) that only the phone's session screen sets; on the
  phone it replaces the inline `OPEN →` / `OUTPUT →`. A task's chip stands
  under its row even without an output file, with no ›.
- **The moons sheet is a sheet**, not a pushed screen: opening an item
  closes it, so back from the item returns to the session.
- **A task without output** has no › in the 10a list rows, the sheet or the
  chip. The list's moon rows word their state as the sheet does ("done ·
  14s", "running · 3h 04m"), without its inks.
- **"Stopped by you"** is remembered in memory per session and task, marked
  when Stop is confirmed.
- **404 or 410 on the output** is ENDED BEFORE THE RESTART even while the
  snapshot still says running.
- **TASK FROM** falls back to the parent's launching call's prompt when the
  page does not reach the agent's first message, with "N earlier steps not
  shown". "Subagents take no replies" shows only while it runs.
- `PHONE_SUBAGENT_PAGE` equals the transcript page size;
  `PHONE_OUTPUT_TAIL_BYTES` is sized for worst-case JSON escaping inside one
  frame. Paths in task output open the preview but carry no long-press.

### § 4 The ⋯ sheet and pins

- Pinned rows sort by `pinnedAt`, oldest pin first, then by last activity.
- Clear's "keeps" lines name a null model or mode as the Mac's default;
  "context · X → 0" only when context was measured. `carryHarness` follows
  the loaded harness, or `harnessStep` before it loads.
- Change tag shows and replaces the first tag; Save in Rename is disabled
  for an unchanged title too. Failures roll back with the composer's error
  line. The ✓ Ended / ✓ Cleared line stands at the end of the transcript of
  the session left on screen.

### § 5 Limit wait and context

- The context thresholds are 10l's, fixed in `limits/context.ts`; the
  percent is floored and the fill clamped.
- `LimitWait.autoContinue` / `continueText` are the settings as of each
  publish; changing the continue text republishes waiting sessions.
- **Asleep, the queued bubbles still show**, dimmed and without their note,
  as 10k's asleep phone draws them; the acceptance line "no queue" is read as
  "nothing can be queued".
- A malformed `?limit=` or `?maxBytes=` is ignored, not refused.

### Not done here

- The feature map (`desktop-vs-phone-feature-map`) lives on its own branch
  and is not marked; mark its five items when both have merged.
- Versions, changelogs and `MIN_SERVER_VERSION` wait for the owner's pick
  (§ 7).
