---
id: 2026-10-03-usage-limits-design
title: Usage limits — continue after a reset, and a view of the plan's windows
status: draft
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

The design (where the view lives and how it looks) comes from Claude
Design. This spec fixes behaviour and content only.

## Scope

- Only sessions Orbital starts. Terminal sessions are shown, not driven
  (`why-orbital`), and their transcripts carry nothing to read a limit hit
  from.
- Plan limits only. With `ORBITAL_USE_API_KEY=1` there are no plan windows;
  the view says limits are not tracked and nothing is scheduled.

## 1. Continue after a reset

### Trigger

The runner stops dropping `rate_limit_event`. A main-loop session that
receives one with `status: 'rejected'` remembers its `resetsAt` and
`rateLimitType`. When that turn then ends on a rate-limit error, the
session gets a **continuation plan**: continue at `resetsAt` plus
`RESET_GRACE` (a named constant, a short margin past the reset).

- The plan is made when the main turn ends, not when the event arrives. A
  subagent that hits the limit does not schedule anything on its own; the
  main turn it belongs to ends with the error and that schedules it.
- If the event carries no `resetsAt`, the server asks the limits probe
  (section 2) for the reset of the window named by `rateLimitType`. If that
  is unknown too, nothing is scheduled and the session ends as it does
  today.
- If extra usage covers the request, the status is not `rejected` and
  nothing happens.
- A `resetsAt` in the past (clock skew) means continue after `RESET_GRACE`.

### Persistence

Plans live in SQLite (session id, reset time, window type, created at), so
they survive a restart. On startup, a plan whose time has passed fires at
once, subject to the checks below. A plan whose session is no longer live
continues the way reopening and continuing a session does today.

### What the user sees

- A notice row in the transcript: "Limit reached, continuing at 15:00"
  with a Cancel action. The time is a clock time, never a countdown.
- On the map the session waits with its own label, "waiting for limit",
  in the same way as the other things a session can wait for
  (`what-a-session-waits-for-is-a-label`).
- With the setting off, the notice states the reset time and offers
  nothing; no plan is stored.
- No new notifications.

### Cancelling

A plan is dropped when the user presses Cancel, sends anything to the
session themselves, or ends the session.

### Firing

At the planned time, the plan fires only if the setting is still on and
the plan still exists. It sends the configured continuation text as an
ordinary user turn, visible in the transcript. If that turn hits a limit
again (for example the weekly window), it gets a new plan from the new
`resetsAt`; there is no retry loop, because every plan needs a fresh
`rejected` event with its own reset time. Several sessions waiting on the
same window all continue at that window's reset.

### Settings

- **Continue automatically after a limit resets** — a global switch,
  on by default.
- **Continuation text** — editable, with a default along the lines of
  "The usage limit has reset. Continue where you left off."

## 2. The limits view

### Source

A limits probe, built like the model catalogue probe
(`models-come-from-the-sdk`): a `query()` whose prompt stream never
yields, so no message is sent and no tokens are spent. It calls the SDK's
usage request with `skipBehaviors: true` (no scan of local transcripts),
then closes. That API is marked experimental in the SDK; if it changes,
only the view breaks. Continuation rests on `rate_limit_event` alone.

The server keeps the last good answer and when it was read.

### Refresh

- When the view opens: the cached answer is served at once and a fresh one
  is fetched behind it.
- After every `rate_limit_event` from a running session.
- While the view is open, every `LIMITS_REFRESH_INTERVAL` (a named
  constant, on the order of minutes). While it is closed, the probe does
  not run.

### Content

Every window the server returns, as it returns it — the 5-hour window,
weekly windows, per-model weekly windows with the server's display name,
and extra usage when the plan has it. Each window shows its utilisation
(0–100 %) and its reset as date and clock time. The server's severity
(`normal` / `warning` / `critical`) is passed through; Orbital does not
grade a window itself. A window the server adds later appears without a
change to Orbital.

States:

- **Not tracked** — `rate_limits_available` is false (API key login).
- **Stale** — the probe failed; the last known answer stays, with the
  time it was read. The failure goes to the error log and is not
  announced (`errors-are-recorded-not-announced`).

### Transport

`GET /api/limits` returns the cached answer and its read time. Changes are
pushed over the WebSocket hub so an open view redraws itself.

## Edge cases

| case | behaviour |
|---|---|
| Mac asleep or Orbital closed at the reset | overdue plans fire on startup |
| setting switched off while plans wait | they do not fire; the switch is read at firing time |
| a subagent hits the limit | the plan is made when the main turn ends on the error |
| extra usage covers the request | not `rejected`, nothing scheduled |
| `resetsAt` already passed | continue after `RESET_GRACE` |
| no reset time from event or probe | nothing scheduled, session ends as today |

## Tests

- Turning a `rate_limit_event` plus a turn ending on the limit error into a
  plan (pure function).
- Plan state transitions: scheduled, cancelled by each of the three
  causes, fired, overdue after restart, setting off at firing time.
- Persistence of plans across a restart.
- `GET /api/limits` and mapping the probe's answer, including "not
  tracked" and "stale".

UI rendering is not tested.

## Out of scope

- Limits for terminal sessions.
- Notifications about limits.
- Spreading continuations of several sessions over time.
