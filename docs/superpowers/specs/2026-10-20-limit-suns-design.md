---
id: 2026-10-20-limit-suns-design
title: Limit suns — plan limits on the map, a run-out estimate, and limits on the phone
status: draft
type: spec
domain: sessions
related:
  - 2026-10-03-usage-limits-design
  - limits-come-from-the-sdk-event-and-a-probe
  - 2026-10-16-device-group-design
  - device-federation
  - why-orbital
tags:
  - limits
  - map
  - mobile
  - labs
---
# Limit suns

People who run into the plan's limits learn it late: the limits live on
their own page, which they open only once a session has already stopped.
This feature puts the limits where they already look, on the map. Each
Claude account gets a **sun**, and the sun dims as the account's usage runs
out. Next to the percent, Orbital also gives an **estimate of when a limit
runs out** at the current pace, as Claude Desktop does. The phone gets an
overview of the limits it has not had so far.

## Scope

- **For:** people who hit the 5-hour or weekly limit often enough to want
  to see it coming, which is common among people running several sessions
  at once. People who never hit it lose nothing: the suns are off.
- **Where it lives:** Labs, as **Limit suns** (Settings → Labs, off). Its
  reception is not known yet (`why-orbital` → Experimental, Labs, and out).
  The estimate on `/limits` and the phone's overview are **not** in Labs.
  They extend what exists and add no new surface to the map.
- **What an existing user notices after updating:**
  - On `/limits`, a line with the run-out estimate under each window.
  - On `/limits`, one group per account instead of one per Claude
    directory (it is the same for anyone with a single directory).
  - On the phone, a limits overview.
  - Nothing on the map until they turn the suns on.
- **What can be set:** the Labs switch, and where each sun sits on the map
  (by dragging it).

## 1. Accounts, not directories

Plan limits belong to the Claude account, not to the directory. Two
directories signed in to the same account have the same windows.
Directories on two devices of one group signed in to the same account do
too. Everything in this spec therefore groups by account:

- **Identity:** the e-mail from the directory's `.claude.json`
  (`readAccountEmail`), lower-cased. A directory whose account is unknown is
  its own group, keyed by device and directory id.
- **The snapshot carries the account.** Each directory in
  `LimitsSnapshot` gains `account` (the e-mail, or null). The grouping
  rule (account key, freshest reading wins, offline member stale) is one
  function in `shared/`, used by the desktop web and the phone. *(Builder
  call.)*
- **Across the device group:** each device reads only its own
  directories. The desktop federates limits the way it federates sessions.
  While it watches `limits` itself, it subscribes to the `limits` topic of
  every live member (added to `memberMayWatch`). It keeps each member's
  last snapshot so an offline member shows as stale, and its own
  `GET /api/limits` returns its directories plus the members', each tagged
  with its `machine`. A request that came over a channel gets only the
  device's own, as federation already rules. The phone asks every member
  itself and merges with the same shared function. *(Builder call.)*
- **Readings of one account from several places are the same data.** The
  freshest reading wins, its estimate (section 2) included, whole. An
  offline member's last reading counts as stale. One account signed in on
  two devices is read by both; that cost is accepted. *(Builder call.)*
- **One probe per account per device:** two directories of one account on
  the same device need one probe, not two. The waits keep using their own
  directory's windows, as today.
- **The group's label:** the account's e-mail, plus the names of the
  directories (and devices, when more than one) it covers. With a single
  account and a single directory nothing is labelled, as with
  `ClaudeDirMark` today.
- **The account's monogram** comes from the e-mail, by the same rules
  `web/src/lib/claudeDirs.ts` applies to directory names (clashes, two
  letters). Anything stored per account (a sun's position) is keyed by
  the account key, never by the monogram. *(Builder call.)*

## 2. The run-out estimate

**It does not come from the server.** Verified on 2026-10-20 (SDK
0.3.287): the `get_usage` answer gives each window only a percent and a
reset time. Its codenamed fields (`cinder_cove`, `amber_gauge`, …) were all
null. If a projection appears there later, Orbital uses it instead of its
own.

**Computed from:**

- **The window's start.** The 5-hour window starts at `resetsAt` minus 5 h;
  the weekly windows at `resetsAt` minus 7 days. The answer also carries
  `seven_day_breakdown.window_started_at`. A window kind of unknown length
  gets no estimate.
- **The recent pace.** The server keeps the account's readings (percent and
  time per window) in SQLite, pruned to the current window, so the estimate
  survives a restart. The recent pace is the slope over the readings within
  `PACE_LOOKBACK` (a named constant per window length: the 5-hour window
  looks back less far than the weekly one).
- **The fallback.** Until there are enough readings for a slope, the pace is
  the window average: percent over time elapsed in the window.

**Where the readings come from.** A reading is a probe (a short CLI
process, no tokens). The pace needs readings from the hours before anyone
looks, so the server reads in the background too. Decided with the user:

- **While any session is working** (Orbital's or a terminal's, on this
  device), every `LIMITS_REFRESH_INTERVAL_MS`, and for
  `LIMITS_TRAILING_READ_MS` (a named constant, minutes) after the last one
  stops. Usage changes almost only then.
- **While someone watches** (`/limits` open, the suns on, the phone's
  overview open), as today.
- **From `rate_limit_event`.** When an event carries `utilization` and
  `rateLimitType`, it is a reading in its own right, at no cost. As today,
  it also triggers a probe.
- **Otherwise, nothing.** Usage spent on claude.ai or on a machine outside
  the group while nothing here works shows up at the next reading. Until
  then it shows as a jump in the slope, not a missed limit.

**What it says:**

| state | estimate |
|---|---|
| at this pace the limit runs out before the reset | "runs out ~Thu 14:00" (absolute, rounded) |
| at this pace it lasts past the reset | "lasts until reset" |
| at 100 % | none: the row already reads LIMIT REACHED |
| no pace yet, unknown window length, extra usage | none |
| stale reading | none |

- Never a countdown and never minutes left (`why-orbital` → Waiting is
  fine). Times are written by `web/src/lib/limits.ts` like the reset times.
- The wording above is a placeholder. Claude Design sets the words.
- The estimate is part of each window in the limits snapshot, computed on
  the server, so the desktop and the phone say the same thing.

## 3. The limits page

`/limits` keeps its rows. What changes:

- One group per account (section 1), labelled as above.
- Under each window, the estimate (section 2).

## 4. The suns (Labs)

- **One sun per account that has plan limits.** Not tracked (API key, an
  account billed by usage) means no sun. With the switch on and no account
  read yet, there is no sun until the first reading.
- **What a sun shows:** how much of the account's usage is left. The more
  is used, the dimmer it gets. Which windows it shows and how, and what is
  readable at a glance, is Claude Design's, within these constraints:
  - Dimming is slow and only follows readings; nothing blinks or pulses,
    at 100 % either.
  - No alarm colours. Severity stays the three steps of one neutral ink, as
    on `/limits`.
  - A stale reading shows quietly as stale; the sun does not pretend to be
    full.
  - With several accounts, the suns tell each account apart the way
    `ClaudeDirMark` does: by monogram, never by colour.
- **Not part of the simulation:** no halo, no push on planets, nothing can
  be dropped on it. A planet drag passing over a sun ignores it.
- **Click** (a press without a drag) opens `/limits`.
- **It is part of space** (decided with the user): it lives in map
  coordinates and pans and zooms with the map, like the planets and the
  trash. Panning can take it off screen.
- **Drag** moves it anywhere on the map. The position (in map
  coordinates) is stored on the server, per account key, in one setting,
  so it survives a restart and is the same in every window of this
  device. A drag that starts on a sun moves the sun and never pans the
  camera.
- **Default position:** off the planets' field, away from the trash.
  The builder picks it within that rule; several suns sit side by side.
  A sun with a stored position stays there when the planets' layout
  changes; one without follows the default as the field grows.
- **Map themes:** Planets only. Desk and Archipelago do not draw suns,
  like the waiting pill (`2026-10-03-usage-limits-design` → As built).
- **Cost while running:**
  - With the suns on, the map keeps the `limits` topic watched, so the
    probe runs every `LIMITS_REFRESH_INTERVAL_MS` all day (one CLI process
    per account each time, no tokens). The same goes for every member it
    subscribes to.
  - With the suns off, the background reading of section 2 still runs
    while sessions work. That is new for everyone, and it is what the
    estimate on `/limits` costs.
  - At rest a sun only redraws when a reading arrives. Any slow ambient
    motion Claude Design gives it must not keep the map rendering.

## 5. The phone

Decision: **the phone gets the limits overview, not the suns.** The phone
has no map. The suns are a map element, so leaving them out is what
"leave the phone out on purpose" means here, and no `idea` follows.

- **What:** the content of `/limits` (the account groups, the window rows,
  the estimate, the waits, the stale and not-tracked states), read-only
  apart from Read again. Where it is reached from and how it looks is
  Claude Design's.
- **Transport:** `GET /api/limits` and `POST /api/limits/refresh`, already
  on the allowlist, and the `limits` topic, which section 1 adds to
  `memberMayWatch`. Against a Mac without the topic, the overview reads on
  open and on Read again.
- **An older Mac:** it answers `/api/limits` without the estimate and
  without account grouping. The phone then shows the rows per directory
  without an estimate, so no `MAC_FEATURES` gate is needed for the
  overview. If the builder finds a part that cannot degrade like that, it
  gets a `MAC_FEATURES` row.
- **Versions:** it ships over the air (`mobile/` app version). No native
  change.

## Edge cases

| case | behaviour |
|---|---|
| two directories, one account, one device | one group, one sun, one probe |
| one account on two devices of the group | one group; the freshest reading |
| a member offline | its last reading, stale; no estimate from it |
| account e-mail unknown | the directory is its own group |
| usage spent elsewhere (claude.ai, another machine outside the group) | counted: the server's percent includes it, and the pace follows the percent |
| the window resets | readings of the old window are dropped; the pace restarts from the window average |
| the percent falls between readings (a reset the server moved) | readings before the drop are discarded |
| the Labs switch goes off | suns go; their stored positions stay |

## Tests

- The estimate: window start, slope vs window average, before/after reset,
  100 %, unknown window, the percent dropping (pure function).
- Grouping by account: the same e-mail across directories and members,
  unknown e-mail, freshest reading wins, offline member stale.
- Reading history: stored, pruned on reset, read back after a restart.
- `GET /api/limits` with the estimate and the groups.
- The sun drag: a press under the drag threshold is a click, beyond it a
  move. This only if the threshold logic is a pure function. The
  rendering is not tested.

## Design brief for Claude Design

Prompt for `Feature - Plan limits.dc.html` (new artboards next to 31a–31e):

> Orbital shows Claude Code sessions as planets on a 2D space map. Plan
> limits (the 5-hour window and the weekly windows, each with a percent and
> a reset time) currently live only on the Limits page (31a). Design three
> things:
>
> 1. **A limit sun on the map** (Planets theme), one per Claude account.
>    The more of the account's usage is spent, the dimmer the sun. Decide
>    which windows it shows and how, and what a glance tells you first.
>    Constraints: nothing blinks or pulses, not even at 100 %; no alarm
>    colours (severity is three steps of one neutral ink, as on 31a); a
>    stale reading reads as stale, not as full; several accounts are told
>    apart by monogram (as the Claude directory mark), never by colour; it
>    must not compete with planets for attention. Show it at roughly 0 %,
>    50 %, 85 %, 100 %, stale, and two suns side by side. The sun is part of
>    space (it pans and zooms with the map), can be dragged anywhere, and
>    clicking it opens Limits. Show whether it has a
>    hover state, and the label it wears, if any.
> 2. **The run-out estimate** on the Limits page: under each window, when
>    the limit runs out at the current pace ("runs out ~Thu 14:00"), or
>    that it lasts until the reset. Always an absolute time, never a
>    countdown. Also the page grouped by account: account e-mail plus the
>    directories (and devices) it covers.
> 3. **Limits on the phone**: the same content for the mobile app (which has
>    no map): where it is reached from and how it reads on a phone screen.
>
> Plus the Labs row in Settings → Labs that turns the suns on.

## Out of scope

- Suns on the phone, and in the Desk and Archipelago themes.
- Notifications about limits.
- Any change to how waits are made or fired.

## As built

The server half, `shared/` and the web types; the map sun, the `/limits`
page by account and the phone overview wait for the design.

**The snapshot.** Each `ClaudeDirLimits` gains two fields; nothing else
changes, so an older client still reads it:

```ts
account: string | null        // the e-mail, lower-cased
machine?: MachineRef          // set on another member's directory only
```

Each `LimitWindow` gains `estimate?: LimitEstimate | null`
(`server/src/limits/estimate.ts`):

```ts
interface LimitEstimate {
  runsOutAt: string | null    // ISO; null = lasts until the reset
  basis: 'recent' | 'window'  // the recent slope, or the window's average
}
```

`estimate: null` is "none to give" (the table in § 2, plus a run-out
already past). An older server sends no `estimate` at all.

**Accounts.** The account is read off each directory's `.claude.json`
again once `ACCOUNT_RECHECK_MS` old, and before every probe. One reading
per account key (the e-mail, or `dir:<id>` when unknown) is shared by
the account's directories and probed once, under the login of the
directory that asked first.

**History.** Table `limit_readings` (migration `0031_limit_readings`),
`LimitHistory` in `server/src/limits/history.ts`. A window is keyed by
`windowKeyOf` (kind and label, so two scoped weekly rows stay apart). A
reset more than `SAME_WINDOW_TOLERANCE_MS` from the stored one, or a
percent more than `PERCENT_DROP_TOLERANCE` below the last, drops what
came before; anything older than `HISTORY_MAX_AGE_MS` goes. Fed by every
good probe and by every `rate_limit_event` carrying `utilization` and
`rateLimitType` (`readEventUsage`; the event's window is matched to a
probe row through `EVENT_TO_PROBE`, so an event before any probe is not
kept). The SDK does not say the unit of the event's `utilization`: a
value up to 1 is read as a fraction, anything above as a percent.

**The estimate.** Pace over the readings within
`FIVE_HOUR_PACE_LOOKBACK_MS` or `WEEKLY_PACE_LOOKBACK_MS` when there are
at least `PACE_MIN_READINGS` spanning `PACE_MIN_SPAN_SHARE` of the
lookback (least squares); else the window's average. None for a reading
older than `ESTIMATE_MAX_AGE_MS`. `seven_day_breakdown.window_started_at`
(ISO or epoch) starts the all-models weekly window (`WEEKLY_ALL_KINDS`)
when it is plausible; the scoped weekly windows keep reset minus 7 days.

**Background reading.** A tick every `LIMITS_BACKGROUND_TICK_MS` notes
the directories with a session working (the Runner's and the live CLI
registry's) and reads each one seen working within
`LIMITS_TRAILING_READ_MS` whose last read started
`LIMITS_REFRESH_INTERVAL_MS` ago (`backgroundReadDue`). Not with an API
key.

**Federation.** `limits` is on `MEMBER_ALLOWED_TOPICS`. While a window
of this device watches `limits`, `FederationService` subscribes to every
member's and reads `GET /api/limits` once per ready channel. The hub
tells this device's own windows from a paired device's view of it
(`onFirstLocalSubscriber`, `Socket.peer`): a member watching our limits
is not asked on to the others, or two members would keep each other
watching for good. Each member's last directories are kept in memory and
merged after the device's own by `LimitsService.snapshot`, tagged with
`machine`, stale and without an estimate while the member is offline.
`POST /api/limits/refresh` asks every live member too. A request with
`DEVICE_HEADER` gets the device's own directories only, and
`ServingHalf` strips every directory carrying `machine` from a `limits`
frame to a peer. Until the page groups by account, `/limits` filters the
members' directories out.

**Grouping.** `groupLimitsByAccount` and `limitsAccountKey` in
`shared/src/limits.ts`. A directory of unknown account is keyed
`<machine id>:<dir id>`, `self` for this device's own. A directory never
read loses to any reading, a stale one to any fresh one. The account's
monogram can reuse `claudeDirMonograms` (`web/src/lib/claudeDirs.ts`) fed
with names built from the e-mail; it stays there.

**Settings.** `map_limit_sun_positions`, default `{}`: JSON from the
account key to `{ x, y }` in map coordinates. The Labs switch is
`limit_suns_enabled`, read as `=== 'true'` like Harness's
(`LIMIT_SUNS_ENABLED_KEY` in `web/src/lib/experimental.ts`); no server
default. The settings route takes any key.
