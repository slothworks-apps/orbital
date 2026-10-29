---
id: 2026-10-20-limit-suns-design
title: Limit suns — plan limits on the map, a run-out estimate, and limits on the phone
status: done
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
  - On the phone, a limits overview, from a ring in the session list
    header.
  - Nothing on the map until they turn the suns on.
  - Nothing they see, but the server now also reads the limits while a
    session works and shortly after (one short CLI process per account and
    interval, no tokens), so the estimate has a recent pace.
- **What can be set:** the Labs switch; with it on, the sun style (Eclipse
  or Dim), each account's star colour, Reset positions, and where each sun
  sits on the map (by dragging it).

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
  directories it covers. With a single account and a single directory
  nothing is labelled, as with `ClaudeDirMark` today. Once the page spans
  more than one device, the directories are listed by device (60c, 60d):
  a row per device, its name (`(this Mac)` on this one) and then its
  directories, so a directory whose path is unknown here still says where
  it lives. With one device the device rows are left out, since the name
  of the only device tells nothing.
- **The tiles** are the directories' monograms, each once: `~/.claude`
  named Personal on two devices is one `P`, not two.
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
| an account with no 5-hour or weekly window, only a spend limit (an Enterprise plan's extra usage) | the sun's middle is the share of the money spent, its label the money (`$71.02 / $500`), no week ring; reached at the cap |

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

Built against the canvas `Feature - Limit sun.dc.html`, artboards 60a–60f.
Where the canvas decided something this spec had left open, the canvas
holds: accounts are told apart by a star colour (yellow, white, blue,
red, in the accounts' order, changeable in Labs), not by monogram alone,
and colour never shows state; the sun comes in two styles, Eclipse
(default) and Dim.

**The snapshot.** Each `ClaudeDirLimits` gains three fields; nothing else
changes, so an older client still reads it:

```ts
account: string | null        // the e-mail, lower-cased
accountId: string | null      // accountUuid:organizationUuid, both off .claude.json
plan: string | null           // the answer's subscription_type: pro, max, …
machine?: MachineRef          // set on another member's directory only
```

Each `LimitWindow` gains `estimate?: LimitEstimate | null`
(`server/src/limits/estimate.ts`):

```ts
interface LimitEstimate {
  runsOutAt: string | null    // ISO; null = lasts until the reset
  basis: 'recent' | 'window'  // the recent slope, or the window's average
  ranOutAt?: string           // a spent window: the first reading at the limit
}
```

`estimate: null` is "none to give" (the table in § 2, plus a run-out
already past, and a spent window with no reading below the limit before
it). An older server sends no `estimate` at all.

**Accounts.** The account is read off each directory's `.claude.json`
(`readAccount`, `server/src/claudeDirs/paths.ts`) again once
`ACCOUNT_RECHECK_MS` old, and before every probe. One e-mail can be a
member of two organizations, a personal plan and a company's, each with
its own limits, so the account is `oauthAccount.accountUuid` and
`organizationUuid` together, and the e-mail is for display. One reading
per account key (`accountId`, else the e-mail when the ids are not read,
else `dir:<id>`) is shared by the account's directories and probed once,
under the login of the directory that asked first; the history is kept
under the same key.

**History.** Table `limit_readings` (migration `0031_limit_readings`),
`LimitHistory` in `server/src/limits/history.ts`. A window is keyed by
`windowKeyOf` (kind and label, so two scoped weekly rows stay apart). A
reset more than `SAME_WINDOW_TOLERANCE_MS` from the stored one, or a
percent more than `PERCENT_DROP_TOLERANCE` below the last, drops what
came before; anything older than `HISTORY_MAX_AGE_MS` goes. Fed by every
good probe and by every `rate_limit_event` carrying `utilization` and
`rateLimitType` (`readEventUsage`; the event's window is matched to a
probe row through `EVENT_TO_PROBE`, so an event before any probe is not
kept). The SDK does not say the unit of the event's `utilization`; the
CLI (checked in 2.1.280) passes on the API header's fraction, which
exceeds 1 past the limit, so it is always scaled by 100.

**The estimate.** Pace over the readings within
`FIVE_HOUR_PACE_LOOKBACK_MS` or `WEEKLY_PACE_LOOKBACK_MS` when there are
at least `PACE_MIN_READINGS` spanning `PACE_MIN_SPAN_SHARE` of the
lookback (least squares); else the window's average. The lookbacks are
in `shared/src/limits.ts`, since the limits page words them. They are
Orbital's own choice, not the canvas's: a whole day for the weekly
windows, so the night's pause averages out, and an hour for the 5-hour
window, so the slope rests on several reads. None for a reading
older than `ESTIMATE_MAX_AGE_MS`. `seven_day_breakdown.window_started_at`
(ISO or epoch) starts the all-models weekly window (`isWeeklyAllKind`)
when it is plausible; the scoped weekly windows keep reset minus 7 days.
The window kinds, by the server's names and the SDK's, are
`isFiveHourKind`, `isWeeklyAllKind` and `isWeeklyScopedKind` in
`shared/src/limits.ts`, for the server's window lengths and the web's
wording alike; a kind on none of them has no estimate.

**Background reading.** A tick every `LIMITS_BACKGROUND_TICK_MS` notes
the directories with a session working (the Runner's and the live CLI
registry's) and reads each one seen working within
`LIMITS_TRAILING_READ_MS` whose last read started
`LIMITS_REFRESH_INTERVAL_MS` ago (`backgroundReadDue`). Not with an API
key. A directory not seen working within the trailing time is passed over
before its account is looked up, so an idle tick reads no `.claude.json`.
A read never rejects: a probe that fails marks the reading stale, and a
snapshot that cannot be published, or a tick that throws, goes to the
error log.

**Who keeps the probe reading.** `LimitsService.watch`, the probe every
`LIMITS_REFRESH_INTERVAL_MS`, follows this device's own windows only
(`onFirstLocalSubscriber`/`onLastLocalSubscriber` in
`server/src/index.ts`). A member watching this device's limits gets
every read that happens anyway, pushed on the topic: the background
reading, a session's `rate_limit_event`, and its own `GET /api/limits`,
which reads an answer `LIMITS_REFRESH_INTERVAL_MS` old again
(`LimitsService.get`). Otherwise a map open on one Mac kept every other
member probing all day. While a window of this device watches, it reads
every member again each `LIMITS_REFRESH_INTERVAL_MS`
(`FederationService`), so an account used only on an idle member stays
fresh here at the cost of one probe there per interval, and only while
someone here is looking.

**Federation.** `limits` is on `MEMBER_ALLOWED_TOPICS`, under the grant
of `GET /api/limits` (`LIMITS_GRANT`, `settings`): `ServingHalf` refuses
the subscribe of a member without it, and drops every `limits` frame to
it, since the grant can be taken back while the subscription stands.
While a window
of this device watches `limits`, `FederationService` subscribes to every
member's and reads `GET /api/limits` once per ready channel. The hub
tells this device's own windows from a paired device's view of it
(`onFirstLocalSubscriber`, `Socket.peer`): a member watching our limits
is not asked on to the others, or two members would keep each other
watching for good. Each member's last directories are kept in memory and
merged after the device's own by `LimitsService.snapshot`, through
`memberLimitsEntries` (`shared/src/limits.ts`, which the phone uses too):
tagged with `machine`, the e-mail lower-cased, `accountId` carried, stale
and without an estimate while the member is offline, and a directory the
member carries as another's left out (`isOwnLimitsEntry`). A member's
read that fails for a reason other than the channel is logged, never
rejected.
`POST /api/limits/refresh` asks every live member too. A request with
`DEVICE_HEADER` gets the device's own directories only, and
`ServingHalf` strips every directory carrying `machine` from a `limits`
frame to a peer.

**Grouping.** `groupLimitsByAccount` and `limitsAccountKey` in
`shared/src/limits.ts`. The key is `accountId`, else the lower-cased
e-mail: an older Mac sends no `accountId`, so its directories group by
the e-mail, apart from the same account read by a newer one. A
directory of unknown account is keyed
`<machine id>:<dir id>`, `self` for this device's own. A directory never
read loses to any reading, a stale one to any fresh one. The account's
monogram can reuse `claudeDirMonograms` (`web/src/lib/claudeDirs.ts`) fed
with names built from the e-mail; it stays there.

**Settings.** `map_limit_sun_positions`, default `{}`: JSON from the
account key to `{ x, y }` in map coordinates. The Labs switch is
`limit_suns_enabled`, read as `=== 'true'` like Harness's
(`LIMIT_SUNS_ENABLED_KEY` in `web/src/lib/experimental.ts`); no server
default. The settings route takes any key. `map_limit_sun_style`
(`eclipse`, default, or `dim`) and `map_limit_sun_colors` (JSON, account
key to colour) sit beside the positions.

**Stale.** `limitsReadingStale` (`shared/`): a failed read, no read, or
one older than `LIMITS_STALE_AFTER_MS`. Stale, a sun gives no light and
every estimate is hidden, on the map, the page and the phone.

**The map** (`web/src/map/LimitSun.tsx`, `sunModel.ts`, `sunVisual.ts`;
the snapshot through `useLimitsSnapshot`, subscribed only while the Labs
switch is on). Each sun is the canvas's CSS in a drei `Html` layer under
the WebGL canvas, so it sits under the planets and its cross-fades run
without the map drawing frames. It follows the planets' counter-zoom and
the Appearance planet size, so it stays smaller than the smallest planet.
Default places: a row above the planets' field, from its left edge,
opposite the trash, spaced so the labels clear each other at the map's
default zoom. The press area is the disc and the week arc. A lone
account's sun is yellow without tiles (`sunColors`).

**The page** (`web/src/limits/accounts.ts`, `LimitsPage.tsx`). One
section per account, its heading omitted only for one account in one
directory. `/limits/<key>` (`parseLimitsRoute`) scrolls to the account and
lights its head once per load. Window rows carry the canvas's sub-line
(`windowScopeLine`). The tab switch the canvas draws in the header is not
built: the app has no such switch.

**Labs** (`web/src/panels/LimitSunsLabs.tsx`). The canvas's rows in the
app's own Labs layout and segmented control. Sun colours is hidden with a
single account; Reset positions is disabled while nothing was moved.

**The phone** (`web/src/mobile/limits/`, `screens/LimitsScreen.tsx`,
`transport/groupFederation.ts`). The phone asks every member it is
linked to and merges with `groupLimitsByAccount`; a member offline or
failing keeps its last reading as stale. It subscribes to a member's
`limits` topic only from `MAC_FEATURES.limitsTopic` on, otherwise it
reads on open and on Read again. Additions the canvas does not draw: an
Extra usage row, a "not tracked" card, and lines before the first answer.
Directory paths are left out: the phone does not know another member's.
