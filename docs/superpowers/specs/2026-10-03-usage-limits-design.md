---
id: 2026-10-03-usage-limits-design
title: Usage limits — continue after a reset, and a view of the plan's windows
status: done
type: spec
domain: sessions
related:
  - limits-come-from-the-sdk-event-and-a-probe
  - models-come-from-the-sdk
  - what-a-session-waits-for-is-a-label
  - errors-are-recorded-not-announced
  - why-orbital
tags:
  - limits
---
# Usage limits

When an Orbital session runs out of the plan's usage, today it stops and
stays stopped until the user notices and types something after the window
resets. Orbital learns when the window resets, so it can continue the
session itself. With the same data it shows the state of every limit
window.

The design is `Feature - Plan limits.dc.html` in Claude Design, artboards
31a–31e (31e-a is the chosen shortcut). This spec holds the behaviour that
was agreed on top of it.

## Scope

- Only sessions Orbital starts. Terminal sessions are shown, not driven
  (`why-orbital`), and their transcripts carry nothing to read a limit hit
  from.
- Plan limits only. With `ORBITAL_USE_API_KEY=1` there are no plan windows;
  the view says limits are not tracked and sessions never wait for a reset.

## 1. Waiting for a reset

### Trigger

The runner stops dropping `rate_limit_event`. A main-loop session that
receives one with `status: 'rejected'` remembers its `resetsAt` and
`rateLimitType`. When that turn then ends on a rate-limit error, the
session gets a **wait**: it is waiting for the window named by
`rateLimitType` to reset at `resetsAt`.

- The wait is made when the main turn ends, not when the event arrives. A
  subagent that hits the limit makes nothing on its own; the main turn it
  belongs to ends with the error and that makes the wait.
- If the event carries no `resetsAt`, the server asks the limits probe
  (section 2) for the reset of that window. If that is unknown too, no
  wait is made and the session ends as it does today.
- If extra usage covers the request, the status is not `rejected` and
  nothing happens.

### Persistence

A wait is stored in SQLite whatever the setting says: session id, reset
time, window type and label, whether auto-continue was cancelled for it,
and the messages the user queued (below). It survives a restart. The
setting is read only when the wait fires, so switching it on or off also
applies to sessions that are already waiting.

### Firing

A wait fires at its reset time plus `RESET_GRACE` (a named constant, a
short margin past the reset). A reset time already in the past (clock
skew, or Orbital was closed or the Mac asleep at the reset) fires at once
on the next check, including on startup. What it sends:

1. **Messages the user queued during the wait**, if any, in the order they
   were written, as one user turn. These are always sent, whatever the
   setting and whether auto-continue was cancelled: the user wrote them.
2. Otherwise, **the continuation text** from Settings, if the setting is on
   and auto-continue was not cancelled for this wait.
3. Otherwise nothing; the wait ends and the session stays idle until the
   user writes.

A session whose process is no longer live is continued the way reopening
and continuing a session does today. If the sent turn hits a limit again
(for example the weekly window), it makes a new wait from the new
`resetsAt`; there is no retry loop, because every wait needs a fresh
`rejected` event with its own reset time. Several sessions waiting on the
same window all fire at that window's reset.

### Writing to a waiting session

A message sent to a waiting session does not go out. It waits for the
reset and is sent then, in place of the continuation text (see Firing).
It shows in the transcript as queued until it is sent.

### Cancel and Undo

The transcript notice offers Cancel while auto-continue would fire. Cancel
applies to this wait only and does not change the setting; the reset time
stays visible. After Cancel the notice offers Undo until the reset. Ending
the session drops the wait.

### What the user sees

Per 31b and 31d:

- **Map** — a still planet: its tag hue at reduced strength, rings, moon
  and core stop moving; a pill under the name, "waiting for limit · 15:00",
  or "limit · resets 15:00" when auto-continue is off or cancelled. It is
  one of the things a session can wait for
  (`what-a-session-waits-for-is-a-label`). The HUD line does not count a
  waiting session as working and gets no new segment.
- **Detail header** — the status line "WAITING FOR LIMIT · 15:00", or
  "LIMIT · RESETS 15:00".
- **Transcript** — one notice row, always last, under the agent's final
  message, in four states: auto on (Cancel), auto off (reset time only,
  with links to Limits and Settings), cancelled (Undo), and after the
  reset, when it folds into a divider "LIMIT RESET 15:00 · CONTINUED" and
  the message is sent. It names the window the server reported as
  exhausted.
- Times are absolute: "15:00" today, "Thu 8 Oct at 09:00" on other days.
  Never a countdown.
- No new notifications.

### Settings

Settings → Sessions, a LIMITS group (31c):

- **Continue automatically after a limit reset** — global, on by default.
- **Message sent on continue** — editable, default "Continue where you left
  off.", with Reset to default.

## 2. The limits view

### Where

A third tab next to Map and Stats (31a), on its own path `/limits`. A
button at the bottom of the sidebar between stats and Settings, and in the
collapsed rail, opens it (31e-a). The button never shows any state.

### Source

A limits probe, built like the model catalogue probe
(`models-come-from-the-sdk`): a `query()` whose prompt stream never yields,
with `persistSession: false`, calls the SDK's `get_usage` control request
with `skipBehaviors: true` and closes. It spends no tokens and scans no
transcripts.

Verified on 2026-10-03 (SDK 0.3.278): besides the typed fixed windows
(`five_hour`, `seven_day`, …) the answer carries `rate_limits.limits[]` —
the server's usage rows (kind, group, scope, percent, reset, severity,
is_active), the same rows `/usage` renders. The SDK's types do not declare
that field yet. The probe reads `limits[]` when present and falls back to
the fixed windows, grading severity from the percent itself, when it is
not. `rate_limits_available: false` is the "not tracked" state.

The server gives a row's kind and scope but no display label. Orbital
names the kinds it knows (`session` → "5-hour window", `weekly_all` →
"Weekly", `weekly_scoped` → "Weekly · <model display name>") and shows an
unknown kind as its kind with the scope's display name, so a new window
still renders as one more row. Rows keep the server's order.

The request is marked experimental in the SDK; if it changes, only the
view breaks. Waiting and firing rest on `rate_limit_event` alone.

The server keeps the last good answer and when it was read.

### Refresh

- When the view opens: the cached answer is served at once and a fresh one
  is fetched behind it.
- On "Read again".
- After every `rate_limit_event` from a running session.
- While the view is open, every `LIMITS_REFRESH_INTERVAL` (a named
  constant, on the order of minutes). While it is closed, the probe does
  not run.

### Content

- A row per window: label and scope from the server, a bar, the percent,
  and "resets" with an absolute time; "reset —" when the server gives
  none. Extra usage shows spend over cap instead of a percent; its bar
  still uses the server's percent.
- Severity from the server, `normal` / `warning` / `critical`, as three
  steps of one neutral ink; an unknown value falls back to `normal`. At
  100 % the row reads "LIMIT REACHED".
- **Waiting for a reset** — the sessions with a wait, with the window and
  the reset time; hidden when there are none.
- **After a reset** — one line saying what the setting does, linking to
  Settings → Sessions.

States:

- **Live** — "read 13:42".
- **Stale** — the probe failed; the last known answer stays, dimmed, with
  "last read 09:12 — may be out of date". The failure goes to the error
  log and is not announced (`errors-are-recorded-not-announced`).
- **Not tracked** — API key login; the view says so and nothing else.

### Transport

`GET /api/limits` returns the cached answer, its read time and the current
waits; a `POST` asks for a fresh read. Cancel and Undo on a wait are routes
of their own. Changes are pushed over the WebSocket hub so an open view, a
transcript and the map redraw themselves.

## Edge cases

| case | behaviour |
|---|---|
| Mac asleep or Orbital closed at the reset | overdue waits fire on startup |
| setting switched while sessions wait | applies to them; read at firing time |
| the user writes to a waiting session | the message is queued and sent at the reset instead of the continuation text |
| a subagent hits the limit | the wait is made when the main turn ends on the error |
| extra usage covers the request | not `rejected`, no wait |
| `resetsAt` already passed | fires after `RESET_GRACE` |
| no reset time from event or probe | no wait, the session ends as today |
| unknown severity or a new window from the server | rendered as `normal`, as one more row |

## Tests

- Turning a `rate_limit_event` plus a turn ending on the limit error into a
  wait (pure function).
- What a firing wait sends: queued messages, continuation text, or
  nothing, across setting on/off and cancelled/not.
- Wait lifecycle: made, cancelled, undone, queued message added, fired,
  overdue after restart, dropped when the session ends.
- Persistence of waits across a restart.
- `GET /api/limits` and mapping the probe's answer, including stale and
  not tracked.

UI rendering is not tested.

## As built

Where the implementation differs from the text above or from the canvas:

- The reset divider is a live notice row only; it is not in the CLI's
  transcript, so after a reload only the sent user turn remains.
- Several messages queued during one wait go out as one turn, joined by
  blank lines.
- `/limits` uses the page header with the breadcrumb, like Stats, not a
  MAP · STATS · LIMITS tab switch; the app no longer has that switch.
- Window rows carry no sub-line ("all models", "model window"): the
  server's rows have nothing to fill it, and the model already sits in
  the label.
- The detail header's waiting line is a bordered chip, like the header's
  other states, not bare text as in 31b.
- The server's reset times arrive a fraction short of the minute
  (`18:29:59.649Z`); the web rounds them to the nearest minute.
- Only the default map theme draws the waiting pill; Desk and Archipelago
  do not, and neither does the mobile app.

## Out of scope

- Limits for terminal sessions.
- Notifications about limits.
- Predicting when a limit will run out.
- Spreading the firing of several sessions over time.
