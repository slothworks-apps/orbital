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
  attach the data, still show the table as before.
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
  inside the transcript messages the phone already reads through the relay
  — no new route, no allowlist change, no new WS topic.
- **A phone ahead of its Mac.** An older Mac sends notices without
  `contextReport`; the phone draws the old printout. The field's absence is
  the gate, so no `MAC_FEATURES` entry is needed.
- **A Mac ahead of its phone.** An older phone ignores the unknown field and
  draws the printout as today.
- **Opening by itself** applies to a `/context` sent from the phone.
- Ships over the air: `web/src/mobile` only, no native change.

## Not in this feature

- `/usage`'s twin (`usage_report`), which the same code could draw next.
- Refreshing the report from inside the dialog. Running `/context` again is
  the refresh.
- Rendering the markdown table of answers without the twin (canvas 20c C).
- Reconciling the CLI's window with the arc's. The dialog shows the CLI's
  own figures; `raw_max_tokens` can be a compaction window smaller than the
  model's (the 200K boundary on a 1M model), so the two can disagree. The
  dialog names its window ("compaction window" vs "model window") when the
  data says which.

## Testing

- `notices.ts`: the twin read from a frame and from a file entry; a report
  dropped when its core numbers are missing; malformed lists and rows
  skipped; unknown `kind` kept.
- The grouping and sorting of the breakdowns (MCP by server, skills by
  plugin) as a pure function.
- Not the dialog's rendering or colours.
