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
- Syncing anything other than the settings table and the tag list (§ Tags):
  tag rules, harness templates, drafts and the like stay where they are.
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

Keys found after the first list (implementer's and writer's call, step 2):
shared are `map_moon_orbits`, `stats_show_human_wait`, `narrate_model`,
`narrate_commentary`, `issue_check_enabled`, `issue_check_model`,
`terminal_enabled`, `terminal_cursor`, `terminal_cursor_blink`; per device
are `terminal_placement` and `terminal_dock_height` (layout), `gh_tip` and
`experimental_unlocked`.

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

## Tags

The user decided: the tag list is shared, tag rules stay on each Mac,
because a rule matches paths that differ between Macs. Both ship in this
PR.

**What is shared:** each tag's name, hue, and which tag is the default. Not
the clump's anchor on the map (`anchor_x`, `anchor_y`): that is layout, per
device like the limit-sun positions. Not which sessions carry a tag: a
session belongs to its Mac, and a member's sessions are already tagged
through the name mapping of `device-federation`.

**Identity.** Each tag gets a group-wide id (a random uuid) beside its local
integer id, so a rename on one Mac renames the same tag everywhere. At the
first catch-up between two members, tags without a shared history are
matched by name: same name, same tag, and the id that wins by the ordering
of § How a shared value travels is kept by both. Two tags created offline
with the same name on two Macs become one the same way.

**Changes.** Each tag carries a stamp like a shared setting. A create,
rename, recolour or a change of the default stamps the tag and is pushed;
the later stamp wins per tag. A rename that would collide with another tag's
name on the receiver merges the two into the one that wins.

**Deleting.** Deleting a tag on one Mac deletes it on every member (a
tombstone with a stamp travels, so an offline member deletes it at its
catch-up, and a later re-create of the same name wins over the
tombstone). On each member the delete does what a local delete does today:
the default tag cannot be deleted, sessions fall back to the default, and
`regenerateRuleTags` runs, so a local rule that pointed at the tag behaves
as it does when the tag is deleted locally. Writer's call: this follows the
user's rule that the group behaves as one.

**Joining.** A joining member's tags are stamped -1 like its settings, so
the group's list wins. Its tags whose names the group lacks are kept and
pushed (a joining Mac's own tags are not lost, unlike its setting values,
because a tag holds sessions). Writer's call.

**Transport.** The same two routes carry tags beside settings (or a sibling
pair, `GET/POST /api/tags/shared`; the builder's call), with the same
member-only guard, the `settings` grant and the stamp clamp. Older members
and the phone are handled as for settings.

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

Canvas: `Feature - Shared settings.dc.html`, artboards 63a (Planets), 63b
(Desk), 63c (parts and states), 63d (scope map). The canvas is the source of
truth for every value; the rules it sets:

- The right end of every section heading reads `SHARED · ALL MACS &
  SERVERS`, `THIS MAC ONLY` (with the desktop device glyph) or `SHARED ·
  EXCEPT MARKED`.
- In a mixed section each per-device row carries a `THIS MAC ONLY` pill
  beside its name, the PRIMARY pill of Devices. Wholly shared or wholly
  per-device sections carry no pills.
- At the top of every tab: "Shared settings apply on every Mac and server
  in this group: <names>. Phones read them." A Mac or server too old for
  sync is left out of the names and named in a second line, "<name> doesn't
  share settings yet — update it", where "update it" opens Devices. Its row
  in Devices says the same.
- Nothing shows while the group holds no other Mac or server (alone, or
  phones only): Settings matches today pixel for pixel. With only old Macs,
  the marks still show.
- The marks never animate in.
- Settings move as the canvas does: Review answers before send moves into
  Permissions beside the guard gesture, and Appearance gets its own LAYOUT
  section (per device). Only New sessions and Map mix.

The canvas mocks a reduced Settings. Tabs it does not show take one label
for the whole tab by the classes above: Profiles, Notifications, Harness
templates, Updates and Devices read `THIS MAC ONLY`; Terminal and
Experimental mix (placement and dock height are per device). Shortcuts is a
read-only list of keys and carries no label. Tags & rules: the tags section
is shared, the rules section `THIS MAC ONLY`. The writer's call, following
the canvas rule.

What must be readable:

- Which settings apply to the whole group and which to this device only.
  This shows only while the group holds another Mac or server. Alone, or
  with phones only, Settings looks as it does today.
- A quiet note when a Mac or server in the group does not share settings
  yet because it is too old, naming the member and saying that updating it
  fixes it. No dialog, no badge outside Settings.
- Nothing about conflicts or sync progress: a change applies, and the other
  members follow when they are online.


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
2. Settings marking, the group line and the too-old note (canvas
   `Feature - Shared settings.dc.html`), the moves between tabs, the
   remaining keys, and the shared tag list (§ Tags).

## Implementation notes (step 1)

Step 1 is built. Where the code made the spec more precise, each point
below is the implementer's call:

- **The `settings` topic is published only for values taken from a
  member,** not for a local PATCH. The window that saved already holds the
  value, and an echo arriving after more typing would overwrite a text
  field being edited.
- **The refusal is 403 `not_a_member`**, for the local app, a phone, a
  stranger, this device itself and a member without the `settings` grant
  alike (a member without the grant is already refused `not_granted` by the
  channel before the route). A catch-up refused with `not_a_member` (the
  member has not yet taken the roster that names this device, as right
  after a join) is asked again at the next status change; any other answer
  ends that channel's catch-up.
- **A member's federated Settings PATCH** of a shared key on this device
  counts as a local change: it is stamped with this device as origin and
  pushed to every member, the asking one included.
- **A key this device holds no row of** (a shared key that is not seeded,
  such as `map_theme`, never set here) is not listed by `GET`, and is taken
  from any member that lists it.
- **This device's own origin is stored empty** and named with its id when
  listed, so a stamp survives the identity being regenerated.
- **Per-device prefixes:** every `remote_` and `new_session_last_` key is
  per device by its prefix, listed or not.
- **The settings seed writes only `key` and `value`** (raw SQL), so the
  database tests that open an older schema with the migrations cut short
  keep working; a seeded row takes the column defaults, time 0 and this
  device.

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
- Tags: rename travels by group id, same-name tags merge, a delete
  tombstone deletes offline and loses to a later re-create, a joining
  member's unknown tags are kept and pushed, anchors never travel.

## Out of scope

- Changing Mac settings from the phone.
- Syncing tag rules and harness templates across members.
- Per-device overrides.
