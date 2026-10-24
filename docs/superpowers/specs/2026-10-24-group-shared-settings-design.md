---
id: 2026-10-24-group-shared-settings-design
title: Settings the group shares — one person's habits, the same on every Mac
status: active
type: spec
domain: remote
related:
  - 2026-10-16-device-group-design
  - 2026-10-21-question-card-go-back-design
  - 2026-10-19-member-grants-design
  - device-federation
  - device-group
  - group-settings-converge-by-last-change
tags:
  - settings
  - remote
  - group
---
# Settings the group shares

ADR: `group-settings-converge-by-last-change`. Builds on the group of
`2026-10-16-device-group-design` and the channels between members
(`docs/domains/device-federation.md`).

## Why

Every device in a group belongs to one person. A preference set on one Mac
is that person's habit, so they expect it to apply on every Mac in the group,
and a phone that follows a setting expects one answer. Today each Mac keeps
its own `settings` table and nothing travels.

The trigger was `questions_review_before_send` (spec
`2026-10-21-question-card-go-back-design`). The phone reads it with
`api.getSettings()`, which goes to `defaultSource()` in
`web/src/mobile/groupFederation.ts`. A phone paired with two Macs that hold
different values therefore follows whichever Mac is its default at that
moment, and applies that value to question cards from every Mac. Once shared
values are the same on every Mac, which Mac the phone reads from stops
mattering.

## Goals

- A shared setting changed on any Mac or server in the group reaches every
  other member that supports this feature, as soon as the member is online.
- A member that was offline catches up when its channel comes back.
- A Mac or server that joins a group takes the group's values.
- Settings tells the user whether a setting applies to the whole group or to
  this device only.
- The phone reads shared values and gets the same answer from any Mac that
  supports this feature.

## Non-goals

- The phone does not change Mac settings. It only reads them. The routes may
  still accept a PATCH from the phone, but no phone screen sends one.
- Per-device overrides of a shared setting.
- Syncing anything other than the settings table: tags, tag rules, harness
  templates, drafts and the like stay where they are.
- Syncing the phone's own settings (notification rules, app lock).

## Anti-goals

- A member's machine-specific value (a path, a directory id) overwritten by
  another member's. A sync that breaks how a Mac launches `claude` is worse
  than no sync.
- Joining a group resets settings the user tuned in the group to the new
  Mac's defaults.
- A conflict prompt. Two offline changes of the same setting are rare, and
  the later one wins quietly.
- Anything new on the relay. It stays blind and stores nothing about settings.

## Which settings are shared

Each key is in exactly one class. The list is code
(`SHARED_SETTING_KEYS` in `shared/`). Any key not on it stays on its device,
so a new setting is per-device until someone decides otherwise. Whoever adds
a setting decides its class in the same change, and a test fails on a key in
`DEFAULT_SETTINGS` that is not explicitly classified (shared, or listed as
per-device).

**Shared** (the person's habits):

- `default_permission_mode`, `default_model`, `remember_model_per_project`
- `confirm_before_clear`, `end_closes_panel`, `name_sessions_automatically`
- `transcript_edit_diffs`, `transcript_expand_diff_on_permission`,
  `permission_guard_gesture`, `questions_review_before_send`
- `context_threshold_warn`, `context_threshold_critical`
- `session_instructions_tips`, `session_instructions_custom`,
  `session_instructions_custom_text`
- `limits_auto_continue`, `limits_continue_text`
- what the map and header show: `map_show_model`, `map_show_trash`,
  `map_show_context`, `map_show_compact_badge`, `map_state_pills`,
  `map_scale_labels`, `header_session_stats`, `header_pull_request`,
  `header_line_changes`
- the look: `map_theme`, `map_limit_sun_style`, `map_limit_sun_colors`
- the Labs switches: `harness_enabled`, `walkthrough_enabled`,
  `archipelago_enabled`, `limit_suns_enabled`

**Per device:**

- the machine: `claude_executable_path`, `default_project_dir`,
  `default_claude_dir`, `new_session_last_*`, every `remote_*` key,
  `update_auto_download`
- history: `delete_sessions_older_than_days`. A shared value would delete
  another Mac's history without the confirmation the local dialog asks for,
  so each Mac keeps its own.
- the layout: `sidebar_collapsed`, `sidebar_width`, `detail_panel_width`,
  `planet_scale`, `map_fps_focused`, `map_fps_background`,
  `map_limit_sun_positions`, `settings_last_section`
- desktop notifications: `notify_needs_input`, `notify_session_ended`,
  `notify_session_failed`, `notify_sound`, `notify_only_when_background`,
  `notify_tip`. The user decided each Mac sets its own.
- bookkeeping: `whats_new_seen`, `models_catalog`, `model_context_windows`,
  `cli_built_in_commands`

The user decided the classes, including retention per device and
`name_sessions_automatically` shared. The placement of the map look and the
Labs switches under Shared was proposed and accepted without objection.

## How a shared value travels

**Stamps.** Each shared key on each member carries a stamp next to its
value: a time (wall-clock ms) and an origin, the device on which the value
was set. The stamp travels with the value: a member that takes a value takes
its stamp unchanged, so the origin always names the device where the value
was set, not the one that last relayed it. A local PATCH of a shared key
whose value actually changes stamps it now, with this device as origin.
Seeded defaults and values from before this feature carry time 0 with this
device as origin.

**Ordering.** One value beats another when its time is later. On equal
times, a value whose origin is the group's current primary wins, and after
that the higher origin id wins. The comparison is a pure function of the two
stamps and the primary's id, so every member settles on the same value
whichever order the channels come up in. A key missing on one side is taken
from the other. The ADR explains why this rule and not another.

**Transport.** Two routes, `GET /api/settings/shared` (every shared key with
its value and stamp) and `POST /api/settings/shared` (some of them), on the
allowlist under the `settings` grant. Both answer only a request that came
over a channel from a non-phone member (`DEVICE_HEADER` naming a roster
member whose kind is not phone), and 403 otherwise, the local web app and
the phone included: the local app keeps using `PATCH /api/settings`, and the
phone only reads. A stamp time later than the receiver's clock plus
`SETTINGS_STAMP_SKEW_MS` is clamped to that bound, so one member's wrong
clock cannot pin a value forever.

**Push.** After a local change of shared keys, the server sends the changed
keys with their stamps to every live member whose hello names the
`settings-sync` capability and whose channel is ready. The receiving member
applies each key whose incoming stamp beats its own. It runs the same side
effects as a local PATCH (`limits.settingsChanged`,
`branchStatus.settingsChanged`), republishes the change to its own windows,
and does not forward it. Every member hears every change from the member
that made it, so nothing needs chaining.

**Catch-up.** When a channel to such a member becomes ready, each side asks
the other for all its shared keys and stamps, applies what beats its own,
and pushes back nothing extra. The other side's own ask covers the reverse
direction.

**Joining.** When this device joins a group (accepts a roster of a group it
did not found and was not in), it sets the time of every shared stamp to -1
before its first catch-up, so every value already in the group beats it,
untouched defaults included. The reset is written in the same transaction
that records the membership, so a restart between the two cannot skip it.
The founding primary keeps its stamps. Leaving a group keeps the current
values and stamps. A device that leaves and joins another group resets
again. How the join is detected in the roster code is the builder's call.

**Grants.** Sync rides the `settings` grant of
`2026-10-19-member-grants-design`. A member that has the grant turned off
on this device may neither push to it nor read from it, and this device
skips that member in its pushes and catch-ups.

**Existing groups.** Two Macs already in a group update to a version with
this feature, both carrying zero stamps. At the first catch-up the
primary's values win every untouched key. That is the one moment an
existing user's settings change without them touching anything, and the
changelog line says so.

**The web app and the Electron main process.** Today nothing tells an open
window that a setting changed under it. The server publishes a local-only
hub topic `settings` with the changed keys (never on `memberMayWatch`, so no
member or phone subscribes to it). The web store applies it, and the
renderer sends the existing `settings-changed` IPC so the main process
re-reads.

## Older members

A member whose hello lacks `settings-sync` (any Mac or server from before
this feature) neither sends nor receives. It keeps its own values. Once it
updates, its first catch-up runs as for an existing group: zero stamps, so
anything changed elsewhere in the meantime wins, and untouched keys follow
the primary.

## The phone

The phone only reads. `questionSetting.ts` and any later reader of a shared
setting ask a Mac whose hello names `settings-sync` (the default source when
it does, otherwise the first live member that does). Only when no live
member does, it falls back to today's default source. The capability is
read from the hello, as with `sessions` and `group`, not from a version in
`MAC_FEATURES`. A phone that updates before its Macs keeps today's
behaviour.

Phone decision: built for the phone, read-only. No new route: `GET
/api/settings` is on the allowlist under the `settings` grant already. The
phone's own settings (notification rules, app lock) stay on the phone, and
its Settings screen gains nothing.

## What the user sees in Settings

Visual placement and form belong to Claude Design (canvas
`Orbital.dc.html`, Settings artboards). What must be readable:

- Which settings apply to the whole group and which to this device only.
  This shows only while the group holds another Mac or server. Alone, or
  with phones only, Settings looks as it does today.
- A quiet note when a Mac or server in the group does not share settings
  yet because it is too old, naming the member and saying that updating it
  fixes it. No dialog, no badge outside Settings.
- Nothing about conflicts or sync progress: a change applies, and the other
  members follow when they are online.

Until the canvas has this, the server and phone work ships without the
Settings marking (see Build order).

## Scope

- **For whom:** anyone with two or more Macs or servers in one group. With
  one Mac and phones, nothing changes except that the phone reads from a Mac
  that supports sync.
- **Where it lives:** on by default, with no switch. Pairing devices into
  one group already says they belong to one person (`docs/why-orbital.md` →
  What gets in; ADR `group-settings-converge-by-last-change`).
- **What an existing user notices after updating:** in a group with two or
  more Macs, the shared settings of the non-primary Macs take the primary's
  values at the first connection, unless they were changed after the
  update. Settings then marks what is shared.
- **What can be set:** nothing new. Which keys are shared is fixed in code.

## Build order

1. Server: the stamps, `SHARED_SETTING_KEYS`, push, catch-up, joining, the
   grant, the local `settings` topic, and the `settings-sync` capability in
   the hello. Web: apply the `settings` topic in the store and forward the
   IPC. Phone: read from a member with `settings-sync`. No design needed.
2. Settings marking and the too-old note, once Claude Design has them.

## Testing

- The ordering: later wins, a tie goes to the primary origin and then to the
  higher origin id, a copied value keeps its origin, and the result does not
  depend on which side compares (pure function).
- The transport routes refuse the local app, a phone and a member without
  the `settings` grant, and clamp a future stamp.
- A local PATCH stamps only shared keys and only when the value changes.
- Apply: an incoming older value is ignored, a newer one runs the side
  effects and publishes `settings`, a per-device key in a push is ignored,
  and a push from a member without the `settings` grant is refused.
- Joining resets the stamps. Catch-up between two members with diverging
  values converges both.
- Phone: picking the source for a settings read with and without a
  `settings-sync` member.

## Out of scope

- Changing Mac settings from the phone.
- Syncing tags, tag rules and harness templates across members.
- Per-device overrides.
