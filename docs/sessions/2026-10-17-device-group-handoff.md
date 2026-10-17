---
id: 2026-10-17-device-group-handoff
title: "Device group — handoff after parts 1, 2a and 2b (next: part 3, federation and the phone as a member)"
type: session
status: active
domain: remote
related:
  - 2026-10-16-device-group-design
  - 2026-10-16-device-channel
  - 2026-10-17-device-group-roster
  - 2026-10-17-device-group-settings
  - device-channel
  - device-group
  - device-group-linking-edges
  - a-device-has-one-identity-and-one-channel-per-pair
  - joining-one-member-joins-the-group
  - the-relay-pairs-two-devices-that-both-sign
  - every-member-reaches-one-literal-allowlist
  - a-headless-orbital-is-a-full-member
tags:
  - remote
  - handoff
---
# Device group — handoff (2026-10-17)

The state a fresh session needs to continue the device group: every
device of one person (desktops, headless Linux servers, one phone) talks
to every other directly. Written because the chat's compaction cannot
carry it.

## Where the work is

- **Branch** `feat/device-group-spec`, **worktree**
  `.claude/worktrees/device-group` (created from local `main` at
  `3e130ece`). Nothing pushed, no PR yet.
- **`main` has moved since.** Merge it in before opening a PR;
  `web/src/panels/Settings.tsx` `NAV_ITEMS` conflicts with the Labs
  section (#91).
- **PR #79** (peer Macs) and **#93** (MCP on every Mac, stacked on it) are
  still open. This work replaces #79; close it once part 3 lands, and
  rebuild #93 on top of part 3. Take from #79: the `preHandler` routing,
  the tag mapping by name, `MultiClient`'s merge on the phone
  (branch `feat/peer-macs-spec`).
- Run the server suite with the session's `ORBITAL_*` variables unset;
  four tests fail otherwise (`env | grep ORBITAL`, then `env -u …`).

## What is done

| part | what | plan |
|---|---|---|
| 1 | One identity and one end-to-end `Channel` per pair, both directions; the phone's client and the server's serving half run on it; a server can join another device (`POST /api/remote/join`) | `2026-10-16-device-channel` (done) |
| 2a | The roster (`group_members`), sync over channels, `POST /pair/mutual` at the relay, linking every member, removal everywhere, leaving | `2026-10-17-device-group-roster` (done) |
| 2b | Settings → Devices on the desktop (canvas 50a–50d, 50k): members, add by code, join another group, the join confirmation naming the kind, leave | `2026-10-17-device-group-settings` (done) |

How it works today: `docs/domains/device-channel.md`,
`docs/domains/device-group.md`. The spec's § 14 carries an "As built"
note per part. Open small edges: `docs/fixes/device-group-linking-edges.md`.

Shipped devices are untouched: `PROTOCOL_VERSION` stays 1, the server's
hello still carries `server`/`macName`, every hello carries `app`, the
phone names no `group` capability, group messages and `linked` reach only
devices that ask for them.

## Decisions taken along the way (not all in ADRs)

- Groups do not merge: a device in a group cannot join another until it
  leaves (design 50 SCOPE). Pairing by hand inside one's own group is
  allowed.
- "In a group" counts only members that link or are not paired here: a
  desktop with only its own phones keeps today's relay change and may join
  a desktop's group.
- The relay is fixed while in a group; moving a group to another relay is
  `ideas/move-a-group-to-another-relay`.
- The roster never changes on the relay's word alone (the relay cannot
  remove members); a departed member a sleeping peer missed stays until
  removed by hand.
- The pairing code is drawn only on a click.
- A leaving device sends its roster with its own entry removed, never
  `removed` (which means "you were removed").
- No version gate between servers yet, so no "update Orbital on <name>"
  for a server member.

## For the maintainer to confirm in Claude Design

- Wording the canvas does not have, written by the implementers: the
  "Request rejected" card body; the one-line join errors (already paired,
  relay offline, relay too old, relay error); "paired with <name>" for
  another member's phone; "Show code".
- 50a's Relay description ("every online member moves with it")
  contradicts the lock; the canvas should say the relay is fixed in a
  group.

## Next: part 3 — federation over channels and the phone as a member

Spec § 6–8, § 10, § 12; design 50e–50j. Write its plan first; it likely
splits into:

1. **One allowlist for every member** (§ 6, ADR
   `every-member-reaches-one-literal-allowlist`): today a member reaches
   the phone list.
2. **Federation in the server**: #79's `PeerService` on channels —
   subscribe to every member's `sessions`, republish with `machine`,
   forward requests for another member's session through its channel, tag
   mapping by name, no chaining. A version/capability gate between
   members (§ 8), which also gives the "update" state.
3. **Desktop UI**: device chips on the map and sidebar (50e), another
   device's session in the detail panel (50f), the device picker and the
   remote folder chooser in New session (50g, needs `GET /api/dirs`), the
   Desk theme (50h).
4. **The phone as a member**: one relay socket carrying a channel per
   member (`RemoteClient` split into the socket and N `Channel`s), the
   `group` capability and roster on the phone, its Settings → Devices,
   own code and the join confirmation as a sheet (50i), the list with
   device chips, "asleep" per device and the device picker (50j). Gate it
   in `MAC_FEATURES` against older desktops (`mobile/CLAUDE.md`).
5. **Notifications across the group** (§ 10): presence over channels, so
   the phone stays quiet while the user is at any member.

Then part 4 (the headless server, § 11, with `orbital devices …` and a
runbook) and part 5 (#93 rebuilt on part 3).

**Versions:** parts 1–3 ship together. When they do, ask about desktop
minor, relay minor (the relay change is in part 2a) and phone app minor
(no native change expected).

## How the work was run

- superpowers: brainstorming → spec → writing-plans → subagent-driven
  development: an Opus (or Sonnet for small tasks) implementer per task,
  a reviewer per task, fix rounds, then a whole-plan review and one fix
  wave. The ledger and briefs live in `.superpowers/sdd/<plan>/`
  (git-ignored); a finished plan's folder is deleted.
- **Design**: Claude Design project `df77470e-1384-436c-8b25-5e01acfc497f`,
  file `Feature - Device group.dc.html` (50a–50k). A split copy is in
  `.superpowers/design/` (git-ignored; re-fetch with `DesignSync get_file`
  if it is gone; the file is under the 256 KiB cut). Subagents cannot use
  DesignSync, so they read that copy.
- **Fidelity pass** (the main session's job): build the web, run a relay
  on :4840 and two throwaway servers (:4848, :4849) with
  `ORBITAL_STATIC_DIR`, `ORBITAL_DATA_DIR=/tmp/…`, pair them through the
  API, compare Playwright screenshots with the canvas served on :4870.
  The canvas renders without its runtime there, so **every conditional
  branch shows at once** — read `logic.js` for what shows when. Kill the
  whole process trees afterwards (`pkill -f "<worktree>/node_modules/.bin/tsx watch"`).
