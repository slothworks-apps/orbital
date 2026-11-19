---
id: 2026-11-19-context-report-dialog-design
title: /context as a report dialog — an overview and a chart instead of a printed table
type: spec
status: active
domain: transcripts
related:
  - locally-answered-slash-commands
  - notice-rows-are-their-own-kind-of-turn
  - the-context-gauge-is-a-traffic-light
  - context-usage-has-one-source
  - context-fill-arc
tags:
  - slash-commands
  - context
  - phone
---
# /context as a report dialog

`/context` answers with a long markdown printout: a header, a table of
categories, then one table row per MCP tool, memory file, agent and skill.
In the transcript it is a wall of mono text folded at eight lines
(`locally-answered-slash-commands` → How the row is drawn). What the user
wants from it — how full the window is, what fills it, and which server or
file is the heavy one — is buried in the table.

The CLI already hands over the same report as data. This feature draws it:
a dialog with the fill, a chart of the categories and the breakdowns, on
the Mac and on the phone.

## Scope

- **Who it is for.** Everyone who runs `/context`. Reading what fills the
  window is part of managing long sessions, which every Orbital user does.
- **Where it lives.** On by default. It replaces the printout only where
  the structured report is present, and the printout stays one tap away
  inside the dialog, so nothing the row shows today is lost. That meets
  "plainly better for everyone" (`why-orbital` → What gets in).
- **What someone notices after updating.** A `/context` they run opens a
  dialog. In the transcript the answer is a short summary row instead of
  the folded table. Older answers in history, written by a CLI too old to
  attach the data, still show the table as before. On the Mac, the detail
  panel's context bar and read-out become a button wherever a report can
  be had: a muted `›` follows the figure, the line washes on hover, and
  a click opens the report without typing anything. On the phone, tapping
  the session header's read-out opens the report sheet instead of the
  context facts sheet (10l) wherever a report can be had; the facts sheet
  stays only where none can.
- **Why the read-out change is plainly better.** Both places already said
  how full the window is; now they also answer what fills it, which is
  the next question anyone looking at a full window asks, and before this
  they had to type `/context` into the session to get it — a turn in the
  transcript for a question about the transcript. Nothing is taken away:
  a session with no report shows the read-out as before, with no
  affordance. The facts sheet's two extra lines are covered. Its "as of"
  time is the report sheet's "taken 14:20" under the title (70f, 71e). Its
  sentence that Claude Code compacts the conversation near the window is
  dropped: the canvas has no place for it in the sheet, and the report
  shows the same thing as data — the compaction reserve hatched at the end
  of the window bar and listed as Autocompact buffer in the legend, and a
  window past the compaction point said in words with the tokens over.
- **What can be set.** Nothing. The dialog is the answer to a command the
  user typed; there is no taste to configure.
- **Why opening by itself is the default.** Typing the command is asking
  for the report. Someone who typed `/context` and got a summary row they
  must click again would be asked twice for one thing; an answer that opens
  only while they are still looking at that session (When it opens) cannot
  land over other work.

## Where the data comes from

The CLI attaches a structured twin of the report to every `/context`
answer (measured on Claude Code 2.1.278 and 2.1.280, 2026-11-19):

| where | field | shape |
|---|---|---|
| SDK stream, synthetic assistant frame | `context_usage` | `SDKContextUsage` |
| transcript file, `system`/`local_command` answer entry | `contextUsage` | the same object, same snake_case keys |

The fields drawn: `model`, `total_tokens`, `raw_max_tokens`, `percentage`,
`over_limit`, `categories[]` (`name`, `tokens`, `kind`: `used` / `free` /
`buffer` / `deferred`), `mcp_tools[]` (`name`, `server_name`, `tokens`),
`memory_files[]` (`path`, `type`, `tokens`), `agents[]`
(`agent_type`, `source`, `tokens`) and `skills[]` (`name`, `source`,
`plugin_name`, `tokens`).

Because the file carries it too, the dialog works for terminal sessions and
for history after a reload, not only for a live answer in an Orbital
session.

### Server

- `transcript/notices.ts` reads the twin in both places, beside the text it
  already reads, and puts it on the notice as `notice.contextReport`. The
  pump (`noticeFromSdkMessage`) and the parser (`messageFromLocalCommandEntry`)
  keep calling the one helper.
- The reader is tolerant, because the format is undocumented and changes
  with the CLI: a report without a numeric `total_tokens` and
  `raw_max_tokens` and a `categories` array is dropped as a whole; a list
  that is missing or malformed becomes empty; a row without a numeric
  `tokens` is skipped. A row with an unknown `kind` is kept and listed in
  the legend, outside the chart.
- `notice.contextReport` is camelCase, declared once in
  `shared/src/contextReport.ts` and used by `server/src/types.ts` and
  `web/src/lib/types.ts`. It is read only from a `stdout` answer, live and
  from the file alike, so a live row and its reload agree. The notice keeps its `text`: it is the
  fallback and the "as text" view.
- Classification is by `kind`, never by the English `name` (the SDK's own
  rule).

## Behaviour

The design is canvas `Feature - Context report` (Claude Design artifact):
**70a** the row and the report in place, **70b** the transcript row,
**70c** the dialog's states, **70d** breakdowns and As text open, **70e**
the chart and its colours, **70f** the phone row and sheet.

### When it opens

- **Opens by itself** when the answer arrives live for a `/context` that
  this window (or this phone) sent, and only if, when it arrives, that
  session is the one on screen here. Typing the command is asking for the
  report, so showing it is not calling for attention. The canvas draws only
  the opening from the row (`report ›`); opening by itself is the owner's
  call on top of it (2026-11-19), and the row stays as the way back.
- **On screen** means: on the Mac, the session shown in the main window's
  detail panel (the selected session) or the one session of a detached
  `/session/<id>` window; on the phone, that session's screen is the
  visible one — not merely kept under a pushed subagent, task or file
  screen, and not behind the lock.
- **An answer that arrives while its session is not on screen** settles the
  ask and leaves only the summary row. Coming back to the session does not
  open it late.
- **The ask** is made only when the `/context` goes out now. One queued
  behind a usage-limit wait or a worktree still being set up is not
  asking: its answer comes after a wait, over whatever the user turned to
  since. A reconnect drops every ask, since answers that came while the
  socket was down arrive as history.
- **Does not open by itself** for an answer in history, a terminal
  session's answer, or one sent from another device. Those show the summary
  row; a click (a tap on the phone) opens the dialog.
- Closing it leaves the summary row where it is; it can be reopened any
  time. Nothing disappears.

### Opening it from the context read-out

The report also opens from where Orbital shows how full the window is: the
Mac detail panel's context line and the phone's session header read-out.
Like session stats, this opens the report without running `/context` and
adds nothing to the transcript. A typed `/context` keeps its row as above.
The design is canvas `Feature - Context report from the read-out`:
**71a** in situ, **71b** the read-out as a button, **71c** loading, arrival
and failure, **71d** sessions that cannot count, **71e** the phone.

**The Mac keeps the latest report per session**, whichever way it was
taken: a typed `/context` (its row stays in the transcript) or the
read-out. A newer one replaces it; nothing older is kept.

- `context_reports` (migration 0040, a new table, empty on update) holds
  one report per session with when it was taken and where it came from:
  `transcript`, with the `/context` answer's entry uuid, or `readout`. The
  indexer reads the newest `/context` twin off the live branch of each
  transcript it reparses and keeps it unless a newer one is kept, after
  the session's row and in the same transaction; the route keeps every
  report it takes, if the session is still there once it has counted. The
  retention sweep deletes the row with its session. A session indexed
  before the update shows its old `/context` as kept only once its
  transcript is written to again; until then the read-out opens the loaded
  transcript's own `/context`, as its transcript row does.
- **A rewind takes a kept report with it.** One from the transcript
  follows the live branch: when its `/context` is rewound away the row
  becomes the branch's newest `/context`, even an older one, or goes. One
  from the read-out goes when a rewind was sent from Orbital after it was
  taken (`rewinds`), the branch's newest `/context` standing in. A rewind
  done in the terminal leaves no record, so a read-out report survives it
  until the next report replaces it.
- Every session carries `contextReportAt`, when its kept report was taken,
  or null. With a live Orbital session, which can always take one, it says
  whether the read-out opens a report at all, without asking.
- `GET /api/sessions/:id/context-report`:
  - a session Orbital runs right now (a live query, not held by a
    terminal) is asked for a fresh report on the side — the
    `get_context_usage` control request with `detail: 'full'`, mapped into
    the same `ContextReport` by `contextReportFromControl` with the twin
    reader's tolerance. No turn runs and nothing is written to the
    transcript. The report is kept and `{ report, takenAt, fresh: true }`
    answered; the session is republished with its new `contextReportAt`.
    A session that stopped or ended while it counted answers its kept
    report instead of a failure; one the sweep deleted meanwhile is
    `not_found` and nothing is kept.
  - any other session — ended, asleep, still starting, held by a terminal —
    answers its kept report, `{ report, takenAt, fresh: false }`.
  - refusals: 404 `not_found`, a session nobody knows; 404 `no_report`, one
    that is not running and has none kept. Taking a fresh one can fail with
    504 `timeout` (`CONTEXT_REPORT_TIMEOUT_MS`, under the phone's request
    timeout), 502 `failed` (the CLI refused, or answered with nothing
    readable) or 409 `unsupported` (a query without the control request);
    those carry the kept report as `earlier` when there is one. A `failed`
    is recorded in the error log (`context_report_failed`) with the CLI's
    words or the unreadable answer: the control answer is the CLI's
    undocumented format, and a break in it has to be readable afterwards
    (adr `errors-are-recorded-not-announced`).
  - the answer's type, `ContextReportAnswer`, is declared once in
    `shared/src/contextReport.ts` for the route and the web.
- **The window is `rawMaxTokens`.** The CLI builds `/context`'s twin from
  this same control answer (measured in the CLI the SDK bundles, 2.1.322),
  `raw_max_tokens` from `rawMaxTokens`, so the two reports measure against
  the same window. `maxTokens` is not read: the model catalog found it
  reporting the session's ceiling rather than the window on older CLIs
  (`models/catalog.ts`). The control answer has no `over_limit`, so it is
  worked out the way the CLI works it out for the twin: past the window,
  `hard_limit` when the answer's undocumented `autocompactSource` is `auto`,
  `compaction_window` otherwise.

**What the user sees** (`store/takeContextReport.ts`):

- **The read-out is the button** (71a variant A, redrawn for the shipped
  one-line header). On the Mac the bar, the note and the figure are one
  target with the tooltip "Context report"; a muted `›` after the figure
  marks it. It costs one character, so the bar keeps its length at the
  panel's minimum width; the word `report` in front of it, as first drawn,
  took about 50 px more from the bar. Hover washes the line, underlines the
  figure and turns `›` link blue, all over 180 ms, and the header is as
  tall as before. On the phone the header read-out keeps its 44 px
  target; a tap opens the report sheet, and the 10l facts sheet stays only
  where no report can be had.
- **No report, no affordance.** A session that is not running and has none
  kept shows the read-out as before: no `›`, no hover, no pointer.
- **A running Orbital session** opens the dialog (the sheet) at once with
  what the read-out knows — the figure, the window bar, the level — and one
  static line of words where the split will be, in space kept for it, so
  the dialog keeps one size. The split, the legend and the breakdowns
  crossfade in when the report comes: the waiting layer out in 160 ms, the
  data in in 240 ms, both ease-out. The figure changes once if the count
  differs from the read-out's, without counting.
- **An ended or terminal session** opens its kept report at once when the
  loaded transcript holds it, else fetches it (no counting words, it is not
  being counted).
- **Failure** keeps the dialog open: one line of words, "nothing was added
  to the transcript", Try again and, when there is one, Show the report
  from `<time>` — the Mac's kept report, else the transcript's. No red, no
  icon. On the phone the Mac asleep is a failure, said at once. The Mac out
  of reach — an older member Mac without the route, a member offline, no
  answer over the network or the tunnel — is said as such; any other
  failed request says the report could not be taken and is recorded in
  the error log.
- **No printout.** A report from the keeper or the read-out has no CLI text
  behind it, so the dialog and the sheet leave out As text rather than
  making one up.
- **Footers** say where a report came from: "open it again for a new one"
  for one taken from the read-out, the session's end or its terminal for a
  kept one, "run /context again" for a typed one.
- An answer for an opening that was closed, replaced or superseded opens
  nothing.

### The summary row in the transcript

The `/context` notice keeps the notice row's `CLI` + command chip + time
header (canvas 20c A). Its body, instead of the printout, is one line: the
fill as a thin bar plus `<used> / <window> · <percent>`, and an
`open report` affordance. A row without `contextReport` is drawn exactly as
today.

### The dialog

What it holds, top to bottom (the arrangement is Claude Design's call):

1. **Header.** Eyebrow `/context`, the session's name, the model, and when
   the report was taken. It is a snapshot; it does not update.
2. **The fill.** Used tokens against the window and the percentage, coloured
   by `contextLevelOklch` exactly like the arc and the detail panel's bar
   (adr `the-context-gauge-is-a-traffic-light`). `over_limit` is said in
   words with the tokens over; `hard_limit` and `compaction_window` read
   differently ("over the model's limit" / "past the compaction point").
3. **The chart.** The window as one whole, split into the `used` categories,
   the `buffer` (compaction reserve) and the `free` remainder. `deferred`
   rows are not part of the window and are not in the chart.
4. **The legend.** One row per category: colour key, name, tokens, share of
   the window. Zero-token rows are hidden. `deferred` rows follow in their
   own quiet group, "not loaded — listed for reference".
5. **Breakdowns.** MCP tools grouped by server (server total, expandable to
   its tools), memory files (path shortened to the project or `~`, type,
   tokens; the full path is the row's tooltip on the Mac and its
   long-press on the phone, which shows it under the row), custom agents,
   skills (grouped by plugin or source). Each list
   sorted by tokens, heaviest first; each section collapsed past a handful
   of rows. A section with no rows is absent.
6. **As text.** The CLI's own printout, the row's `text`, behind a
   disclosure, with copy.

### Colour

The gauge colour (green, amber, red at the Settings → Sessions marks)
appears only on the fill: the row's bar, the used part of the window bar
and the headline key. The categories take seven fixed slots in the CLI's
order (canvas 70e), the same category always the same colour on the Mac
and the phone; none of them is green, amber, red, a tag hue or the accent.
The CLI's own `color` names (from the control request) are not used.

The chart is two bars (70e): the window at true scale — used in the gauge
colour, free as an empty track, the buffer hatched at the end — and under
it the used part spread to full width in category colours.

### Calm

No animation beyond the dialog's standard enter and exit. The chart does
not count up or grow in. A full window is not an alarm: red is the fill's
level colour, nothing pulses.

## Phone

Built for the phone too, as a bottom sheet.

- **How it reaches the phone.** The notice and its `contextReport` travel
  inside the transcript messages the phone already reads through the relay,
  with no new WS topic. The report from the read-out is the one new route,
  `GET /api/sessions/:id/context-report`, on the allowlist in the
  `sessions` grant group beside the session's other reads, and
  `contextReportAt` on the session.
- **A phone ahead of its Mac.** An older Mac sends notices without
  `contextReport`; the phone draws the old printout. The field's absence is
  the gate for the row and the sheet. An older Mac also sends no
  `contextReportAt`: the read-out then opens only the last `/context` in
  the loaded transcript and never asks the route. The field's absence is
  that gate too, per device of the group, so no `MAC_FEATURES` entry is
  needed.
- **A Mac ahead of its phone.** An older phone ignores the unknown fields
  and draws the printout as today, and never calls the new route.
- **Opening by itself** applies to a `/context` sent from the phone.
- Ships over the air: `web/src/mobile` only, no native change.

## Not in this feature

- `/usage`'s twin (`usage_report`), which the same code could draw next.
- Refreshing the report from inside the dialog. Running `/context` again,
  or opening it again from the read-out, is the refresh.
- Rendering the markdown table of answers without the twin (canvas 20c C).
- Reconciling the CLI's window with the arc's. The dialog shows the CLI's
  own figures; `raw_max_tokens` can be a compaction window smaller than the
  model's (the 200K boundary on a 1M model), so the two can disagree. The
  dialog names its window ("compaction window" vs "model window") when the
  data says which.

## Testing

- `contextReportFromControl`: the control answer read into the same report
  as the twin; `rawMaxTokens` as the window; `over_limit` worked out; the
  same tolerance. The route's answer and each of its refusals.
- The kept report: newer wins, found by the indexer, swept with its
  session; the route's fresh, kept, refused and failed answers.
- Which report the read-out opens (fresh, kept, the transcript's, none),
  the failure with its earlier report and Try again, and that a late or
  superseded answer opens nothing.
- `notices.ts`: the twin read from a frame and from a file entry; a report
  dropped when its core numbers are missing; malformed lists and rows
  skipped; unknown `kind` kept.
- The grouping and sorting of the breakdowns (MCP by server, skills by
  plugin) as a pure function.
- Not the dialog's rendering or colours.
