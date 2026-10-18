---
id: 2026-10-17-device-group-handoff
title: "Device group — handoff: parts 1–3 in PR #97, security pass before merge, then part 4"
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
  - device-group-federation-edges
  - device-federation
  - phone-in-the-group
  - a-device-has-one-identity-and-one-channel-per-pair
  - joining-one-member-joins-the-group
  - the-relay-pairs-two-devices-that-both-sign
  - every-member-reaches-one-literal-allowlist
  - a-headless-orbital-is-a-full-member
  - the-group-has-one-primary-device
  - roster-entries-are-signed
  - transfer-the-primary-role
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

- **PR #97** (`feat/device-group-spec`, worktree
  `.claude/worktrees/device-group`), pushed at `acfdb2d9`, open, not
  merged. It carries parts 1–3 with desktop 0.34.0, relay 0.6.0 and
  phone app 0.15.0 (no native change), merged with `origin/main` up to
  #95. Labels: desktop, relay, mobile, ui, site, enhancement. The
  feature review is posted on the PR ("fits").
- **`/orbital-code-review` ran on the PR** (8 agents). All 11 findings
  were fixed, reviewed and pushed (commits `b119a41e` … `015c3448`),
  plus the last round: two phones never link with each other.
- **Security pass (2026-10-18), done.** Four adversarial reviews (a
  stolen phone, a malicious member, a malicious relay, a page in the
  WebView origin) found 16 issues; all were fixed. The roster had to be
  rebuilt: signed multi-writer entries kept leaking through four review
  rounds, so the group now has **one primary device** that alone signs
  the roster, adds, removes and dissolves (ADR
  `the-group-has-one-primary-device`; `roster-entries-are-signed` is
  superseded). Pairs end only once their ending was acknowledged
  (bounded by `EXIT_MAX_MS`), an ending device is served nothing on the
  Mac or the phone, and every check fails closed. A final whole-branch
  review and a scoped re-review of its fixes followed. The working files
  are in `.superpowers/sdd/security/` (git-ignored).
- **Design**: the primary model is in Claude Design file
  `Feature - Device group 2.dc.html` (50a primary, 50l member, 50m/50n
  dissolved, 50i phone in a group, 50o group full); desktop fidelity
  checked live, the phone screens not yet in a browser.
- **Before merge:**
  1. The four Demo screenshots in the PR description.
  2. The maintainer's look at "For the maintainer to confirm in Claude
     Design".
  3. Deploy order: the relay (0.6.0) before the Mac and the phone — the
     phone reads a relay below `RELAY_PHONE_GROUP_VERSION` as one without
     the group routes.
- **After merge:** close **#79** (peer Macs, replaced); **#93** (MCP on
  every Mac) is rebuilt as part 5.
- Run the server suite with the session's `ORBITAL_*` variables unset;
  four tests fail otherwise (`env | grep ORBITAL`, then `env -u …`).
- Nothing runs in the background; the throwaway servers' data is in
  `/tmp/fid-a`, `/tmp/fid-b`, `/tmp/fid-relay` (disposable).

## Security posture (2026-10-18, after the pass)

Holds, besides what held before (end-to-end crypto, a blind relay that
cannot invent pairs, the pairing proof and code limits, one literal
allowlist, the restricting device header, no chaining): only the
primary's signature changes membership; a removed or left device has
nothing to sign with and is served nothing; old foundings and versions
are refused; a group is adopted only through a ceremony; member ids are
encoded in every web path and cannot claim another device's session; a
member's 401 cannot log the window out; downloads are bounded; the relay
bounds mutual halves and cannot wipe a grouped phone.

Knowingly left: a member asleep at a removal links with the removed
device until a newer version reaches it; a stolen, unlocked primary
controls the group; group-wide trust for allowlisted routes; relay
metadata and denial of service; snapshots at rest unencrypted.

## What is done

| part | what | where it is described |
|---|---|---|
| 1 | One identity and one channel per pair, both directions | `docs/domains/device-channel.md` |
| 2a | The roster, `/pair/mutual`, linking, removal, leaving | `docs/domains/device-group.md` |
| 2b | Settings → Devices on the desktop (50a–50d, 50k) | spec § 14 |
| 3a | Federation in the server: one member allowlist, every member's sessions in the hub, requests through their channels, snapshots, a read cache, presence across the group | `docs/domains/device-federation.md` |
| 3b | The desktop UI: chips, offline, the detail panel's pill and lock, New session on another device with a folder chooser (50e–50h) | spec § 14 |
| 3c | The phone as a member: `GroupMember`, `PairingCeremony` and `RelayLink` in `shared/`, `GroupClient`, `GroupFederation`, Settings → Devices, the code, the join sheet, chips and asleep per device, the device picker (50i, 50j) | `docs/domains/phone-in-the-group.md` |

Plans 1, 2a and 2b are in `docs/superpowers/plans/` (done); part 3 ran
without plan documents, from task briefs. Open edges:
`docs/fixes/device-group-linking-edges.md` (after 2a) and
`docs/fixes/device-group-federation-edges.md` (after 3).

## Decisions taken along the way (not all in ADRs)

- Groups do not merge; pairing by hand inside one's own group is allowed.
- "In a group" counts only members that link or are not paired here.
- The relay is fixed while in a group (`ideas/move-a-group-to-another-relay`).
- The roster never changes on the relay's word alone.
- The pairing code is drawn only on a click.
- A leaving device sends a signed left notice and waits for one member to acknowledge it.
- A request a channel injects carries `x-orbital-device`; it only ever
  restricts (never forwarded, no `remote_*` settings).
- "Too old" between members is a non-phone whose hello names no
  `group` (a Mac from before groups); it is not federated.
- Device chips live in the sidebar in both themes (the Desk has a
  sidebar; 50h's HUD chips are not built).
- One primary per group: only it adds, removes and dissolves; losing it
  means founding again (handover is an idea).
- A phone no member can reach is shown so (a card with Pair again),
  never wiped automatically.

## For the maintainer to confirm in Claude Design

- 50a draws "Reset to default" in the relay editor, but Orbital has no
  default relay (`docs/ops/run-the-relay.md`), so it is not built. Drop
  it from the canvas, or decide on a default relay first.

- From part 2b: the "Request rejected" card body; the one-line join
  errors; "paired with <name>"; "Show code"; 50a's Relay description
  ("every online member moves with it") against the lock.
- 50h draws device chips in the Desk HUD, assuming no sidebar; they are
  built in the sidebar.
- 50f's too-old state promises "Reading still works"; a Mac too old for
  groups is not federated, so there is nothing to read.
- 50i draws this phone's code as a short word; the code is the QR's JSON
  as one long word.
- Wording the canvas does not have, written by the implementers:
  desktop — "Nothing from <name> is kept here yet.", "Only images can be
  sent to a session on another device.", the folder chooser's two error
  lines, the device pill in a detached window; phone — "No device in
  your group can reach this phone right now.", "<name> needs a newer app
  on this phone — read only", "update Orbital on <name> — read only",
  "New session · needs a device awake", "Choose a device", the leave
  confirm and "Forget this group on this phone", the device-offline card
  on joining, "The relay needs an update before this phone can show a
  code.".

## Next

- **Before merge**: the rest of "Where the work is"; the phone screens
  50i/50n in a browser.
- **Part 4, the headless server** (spec § 11): `ORBITAL_HEADLESS=1`,
  kind `headless`, `orbital devices add|join|list|rename|remove`, the
  Linux fixes, a systemd unit and a runbook.
  With it, the phone's own-code sheet gains the canvas's line "On a
  server: orbital join" (50i), left out until the command exists.
- **Part 5, the orbital MCP on every member** (#93 rebuilt on part 3).

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
