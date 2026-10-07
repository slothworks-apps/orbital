---
id: 2026-10-07-version-compatibility-design
title: Version compatibility between the relay, the Mac and the phone
type: spec
status: active
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - 2026-10-02-mobile-app-design
  - run-the-relay
  - the-relay-takes-a-shared-secret
  - the-relay-answers-cors-for-redeem
tags:
  - relay
  - mobile
  - versioning
---
# Version compatibility between the relay, the Mac and the phone

## Why

Three things ship on their own schedule: the desktop DMG, the relay image
and the phone app. Everyone runs their own relay, so its version is out of
the maintainer's hands. The phone updates itself from the store, and the
Mac updates when its user installs a new DMG. One user routinely runs three
different versions side by side.

Today only part of this is checked:

- The phone and the Mac exchange `PROTOCOL_VERSION` in `hello`. The Mac
  closes with `bye protocol` on a mismatch, and the phone also refuses a Mac
  older than `MIN_SERVER_VERSION`. Both end on the phone's mismatch screen
  (canvas 9i).
- The phone sends its version as `hello.app`, but the Mac never reads it.
  That value comes from `mobile/package.json`, which had drifted from
  `versionName` in `mobile/android/app/build.gradle`, the version that ships.
  The copies were brought back into line, and `scripts/check-versions.mjs`
  (the `versions` CI job) now keeps them that way.
- The relay never says which version it is. It drops a frame whose first
  byte is not `FRAME_VERSION`, and it does so silently. An app that outgrows
  the relay just goes quiet.
- Nothing at release time stops an app from shipping that needs a relay
  nobody has deployed yet.

## Decisions taken while brainstorming

- **Minimum versions, not protocol numbers.** Each side holds the oldest
  version of the other side it works with, as `MIN_SERVER_VERSION` does
  today. A version is the one the component ships under (the version table
  in the root `CLAUDE.md`).
- **The Mac and the phone each check the relay.** Both hold
  `MIN_RELAY_VERSION`. The relay itself enforces nothing new.
- **The Mac checks the phone.** It holds `MIN_PHONE_VERSION`, so all three
  pairs are checked in the direction where a screen can explain the
  problem.
- **The relay announces its version inside messages it already sends**:
  its first WebSocket message and a header on its HTTP answers. There is no
  separate `/version` call, because that costs a round trip and can disagree
  with the relay the socket reaches.
- **Outside the supported range, a screen, not silence.** The screen names
  the part to update and both versions.

## 1. Shared: one comparison, three constants

`compareVersions` moves from `web/src/mobile/version.ts` to
`shared/src/remote/version.ts`, unchanged: dotted numbers, missing parts
are zero, a pre-release suffix is ignored, and `dev` is newer than any
release. Next to it, in the same file:

| constant | held by | compared against |
|---|---|---|
| `MIN_RELAY_VERSION` | Mac and phone | the relay's announced version |
| `MIN_SERVER_VERSION` | phone (moves from `web/src/mobile/version.ts`) | `hello.server` |
| `MIN_PHONE_VERSION` | Mac | `hello.app` |

`RELAY_VERSION_BEFORE_ANNOUNCING = '0.2.0'` names the version of a relay
that announces nothing. Every relay released so far is 0.2.0 or older. A
missing version therefore passes for as long as `MIN_RELAY_VERSION` stays
at or below that value, and fails once it is raised past it.

The first values refuse nobody who runs a release today:
`MIN_RELAY_VERSION = '0.2.0'`, `MIN_SERVER_VERSION` unchanged, and
`MIN_PHONE_VERSION = '0.1.0'`. Every phone up to 0.3.2 reports `0.1.0`
in `hello.app`, because its `mobile/package.json` had drifted, so a higher
minimum would refuse them all.

`PHONE_KNOWS_APP_TOO_OLD = '0.4.0'` is the first phone release that
understands `bye app_too_old` (§ 4).

**When to raise one:** in the change that makes the other side depend on
something new, in the same PR as that change. Raising a minimum alters what
ships, so it goes under the changelog rules in the root `CLAUDE.md`.

## 2. Relay

- `challenge` gains `version: string`, read from `relay/package.json` at
  startup. `RelayToDevice` accepts it as optional, because older relays
  send none.
- Every HTTP answer carries `x-orbital-relay-version`. The redeem
  endpoint's CORS answer adds `access-control-expose-headers:
  x-orbital-relay-version`, so the phone's WebView can read it.
- Nothing else changes. The relay still drops frames with an unknown
  `FRAME_VERSION`, and it neither reads nor refuses device versions.

## 3. The client (`shared/src/remote/client.ts`)

- On `challenge`, the client compares `version ??
  RELAY_VERSION_BEFORE_ANNOUNCING` with `MIN_RELAY_VERSION`. When the relay
  is older, the client does not send `auth`. It closes, emits
  `relay_too_old { relayVersion, needed }` and stops reconnecting, as it
  does for `bad_secret`. It tries again only when the relay URL changes or
  the app asks it to retry.
- `redeem` and the Mac's pairing calls read `x-orbital-relay-version` from
  the answer the same way. On a relay that is too old, they return a
  `relay_too_old` result instead of continuing.

## 4. Mac

- **Relay too old.** The remote status gains `relay: 'too_old'` with both
  versions. The mobile section's status line (canvas 9q) reads it as a
  failure: "relay too old", with the detail "relay x.y.z, Orbital needs
  ≥ a.b.c — update the relay image". No pairing code is offered while the
  relay is too old.
- **Phone too old.** `phoneSession` compares `hello.app` with
  `MIN_PHONE_VERSION` after the protocol check. When the app is older, the
  Mac closes with `bye app_too_old` and the minimum, and it records the
  refusal against that phone. The paired-phones list in the mobile section
  marks the phone "needs an update" until it next connects with a
  supported version.
- `bye` becomes `{ t: 'bye', reason: 'protocol' | 'revoked' | 'app_too_old',
  needed?: string }`. A phone from before this change does not know
  `app_too_old`, and its schema would reject the message. If the refused
  phone's version is older than `PHONE_KNOWS_APP_TOO_OLD`, the Mac sends
  `bye protocol` instead, the closest refusal it understands.
- **The Mac's two new states need Claude Design too**: the "relay too old"
  status line (9q) and the "needs an update" mark in the paired-phones list.
  Until the canvas draws them, the copy above is provisional.

## 5. Phone

- **`hello.app` is the shipped version.** It stays `version` from
  `mobile/package.json`, which the `versions` CI job holds equal to
  `versionName` (`mobile/CLAUDE.md`).
- **The mismatch screen (9i) gets a cause.** `mismatch` becomes
  `{ cause: 'mac' | 'relay' | 'app', theirs: string | null, needed: string }`:
  - `mac`: as today. Triggered by `bye protocol` or by `hello.server` below
    `MIN_SERVER_VERSION`.
  - `relay`: the client's `relay_too_old`, at connect or at redeem. It
    names the relay's host and says the relay has to be updated by whoever
    runs it.
  - `app`: `bye app_too_old`. It says the app needs an update and links to
    the store.
- "Try again" and the re-check on every foreground stay as they are, for
  all three causes.
- **The copy and layout of the two new variants come from Claude Design.**
  The canvas draws only the Mac variant of 9i, so the relay and app
  variants need a canvas update before the fidelity pass.

## 6. Release check

`scripts/check-versions.mjs`, which the `versions` CI job runs, also
checks each minimum against the version of the component it names, as
recorded in the repo:

- `MIN_RELAY_VERSION ≤ relay/package.json` `version`
- `MIN_SERVER_VERSION ≤ desktop/package.json` `version`
- `MIN_PHONE_VERSION ≤ versionName` in `mobile/android/app/build.gradle`

This test cannot see whether the relay image is actually published or
installed. It does stop one mistake: shipping an app that needs a version
that does not yet exist.

## 7. The phone

This feature is mostly the phone's own: the relay and app causes of the
mismatch screen, the shipped version in `hello`, and the relay check at
redeem. No route is added to `server/src/remote/allowlist.ts`, because
everything travels in the relay's own messages and in `hello` / `bye`.

## 8. Testing

- `compareVersions` keeps its tests where it moves, plus the
  missing-version fallback.
- The client: a `challenge` without a version and one with a version too
  old, a redeem answer with an old version header, and that a refused relay
  is not retried in a loop.
- `phoneSession`: an app below the minimum gets `app_too_old`, or `protocol`
  when it predates the reason.
- The relay: `challenge` carries the version, and the redeem answer exposes
  the header to CORS.
- Mobile state: each mismatch cause is derived from its event.
- The release check (§ 6).

## What ships

| | change | changelog |
|---|---|---|
| relay | announces its version | `relay/CHANGELOG.md` |
| desktop | refuses a relay or a phone that is too old and says so | `desktop/CHANGELOG.md` |
| phone | explains a relay or app that is too old | `mobile/CHANGELOG.md` |

## As built (backend)

- **The Mac's relay client checks too.** `server/src/remote/relayClient.ts`
  makes the same check as the phone's client on `challenge` and on every
  signed post. A refusal emits `refused` with `relay_too_old` and both
  versions, the way `bad_secret` is emitted. The remote status then reads
  `relay: 'too_old'` with `relayTooOld: { relayVersion, needed }`, and
  `POST /api/remote/pair` answers 409 `relay_too_old`. "Try again" (or any
  settings change) starts the remote afresh.
- **Retrying a refused relay on the phone.** After `relay_too_old`, the
  client stays stopped until `start()` or `recheck()`. `recheck` is the only
  way a stopped client comes back. That is what 9i's "Try again" and the
  foreground re-check already call.
- **`redeem`** returns `relayTooOld` beside `status` and `body`, emits
  `relay_too_old` and stops the client.
- **A missing version header** counts as `RELAY_VERSION_BEFORE_ANNOUNCING`
  only on a successful answer. An error page may come from a proxy in front
  of the relay, so it says nothing about the relay itself.
- **`hello.app` that names no version** (`phoneAppVersion` returns null) is
  not refused. A refusal has to name both versions.
- **The phone refusal is kept in memory**, per device, as
  `devices[].needsUpdate: { version, needed } | null` in the remote status.
  A restart of the Mac forgets it until that phone says hello again.
- **The relay reads its version** by importing `relay/package.json`. The
  esbuild bundle inlines it, so the image needs no package.json at runtime.

## As built (UI)

- **`mismatch.needed` may be null.** It is null only for `app` after a
  `bye app_too_old` that carried no `needed`; the screen then leaves out the
  "needs" row instead of printing a made-up minimum. `theirs` is always null
  for `app`: the part too old is the phone itself, and 9i reads its own
  version from the build.
- **A `bye protocol` keeps only a Mac version.** After a relay cause, the
  relay's version is not carried over as the Mac's.
- **Leaving 9i.** A supported `hello` leaves it for every cause. For `relay`,
  the relay's `ok` (link `online`) leaves it too, since only a relay new
  enough answers `ok`, and the Mac may be asleep when the relay is updated.
- **Mid-pairing, a relay too old is reported on 9e, not 9i.** With no pair
  stored there is no app behind 9i to block, and 9i's "Try again" has no
  link to retry. Both at connect and in the redeem's answer, the pairing run
  goes back to scan with a message naming the relay's host and both
  versions, as it does for a refused relay secret. `reduce` ignores
  `relay_too_old` while `pairing` is null.
- **The store link.** On Android the `app` variant's primary action opens
  the Google Play listing of the app id from `mobile/capacitor.config.ts`
  (a top-level navigation the Capacitor bridge hands to the system), with
  "Try again" as the secondary action.

## As built (design)

Claude Design drew the feature in `Feature - Version compatibility.dc.html`:
11a (9i's three causes on the phone), 11b (Settings → Mobile with a relay
too old, a new 9q state), 11c (a paired phone that needs an update) and 11d
(parts and states). The copy of 9i's `relay` and `app` variants and of the
Mac's two states is now the canvas's; nothing of them is provisional any
more. Where the build departs from the canvas, or the canvas left a
decision open:

- **A relay that announces no version reads "an older relay"** (11d). So
  `RelayTooOld.relayVersion` is null for such a relay instead of
  `RELAY_VERSION_BEFORE_ANNOUNCING`, which still decides the verdict. Every
  readout prints "an older relay" for it: 9i's first row, the Mac's status
  line, both result lines and the 9e message.
- **The Mac re-checks a relay too old on its own.** 11b's card says
  "Orbital reconnects on its own". The server's relay client stops on a
  relay too old, so the service now starts afresh `RELAY_TOO_OLD_RECHECK_MS`
  after the refusal. Any start or stop in between cancels it.
- **Try again on the Mac is one bounded check** (11b), as on the phone:
  "Checking…" while the remote restarts and the relay answers, for
  `RELAY_CHECK_WINDOW_MS` at most, then "still x.y.z · checked just now".
  The restart passes through `connecting`, and showing that would swap the
  card for "Waiting for the relay" in the middle of the check. So the
  too-old status stays on screen until the relay answers or the window
  runs out (`statusDuringCheck`).
- **The Mac's card** keeps the type sizes of the QR state beside it (9n as
  built, a step smaller than the canvas draws). The empty QR frame is
  drawn at the canvas's size.
- **The paired phone's row** keeps the list's built layout: name over one
  caption line. 11c's separate dot and seen columns are not built. The
  chip and the versions sit inline after the paired date, and the seen
  text follows them. That text reads "refused · <age>" with the list's
  `timeAgo` ("refused · 10m"; the canvas writes "10 min ago"). To carry the
  age, the server keeps the time of the latest refusal as
  `needsUpdate.at`, and every refusal publishes the status again.
- **iOS has no store link.** The canvas makes "Open App Store" the primary
  action on iOS, but the repo has no App Store id. So on iOS "Try again"
  stays the primary action, and the hint reads "The update is in the App
  Store." in place of 11a C's "The update is in Google Play."
- **The 9e message for a relay too old mid-pairing** is not drawn. It uses
  11a B's words: "The relay at <host> is older than this app supports:
  relay x.y.z, this app needs relay ≥ a.b.c. Whoever runs the relay
  updates its image." It stays provisional.
- **"opened Google Play · Orbital re-checks when you're back"** shows from
  the tap until a check lands after it. The check on return to the
  foreground then replaces it with its own result line.
