---
id: device-group-federation-edges
title: Device group — edges left in federation and the desktop UI after part 3
status: backlog
type: fix
domain: remote
related:
  - 2026-10-16-device-group-design
  - device-federation
  - device-group-linking-edges
tags:
  - remote
  - server
  - web
---
# Device group — edges left after part 3

Found by the reviews of part 3 (federation in the server, the desktop
UI, the phone as a member); each is narrow or heals on its own.

## Server (`server/src/federation/`)

- **Fold count.** With `ended=exclude`, the `ended` header counts every
  folded session of every member, while this device's own count is one
  page's.
- **A session id on two devices** (one `~/.claude` copied to another
  machine) is routed to the first member that lists it.
- **Seed race.** A frame that arrives while a member's seed is in
  flight can be overwritten by the seed's older list; the next upsert
  corrects it (inherited from #79).
- **Read cache.** A spawn expected on a member and never listed keeps
  its read-cache entries until the member is dropped (bounded by
  `READ_CACHE_MAX_BYTES`). No test pins that a live member's 409 is not
  masked by a cached copy (the code guards it with the channel's
  readiness).
- **MCP server names** with `.`, `:` or a space cannot be managed from
  another device: a channel's path segments are held to `SAFE_SEGMENT`.
- **Custom model check.** `POST /api/models/validate` is not on the
  member allowlist, so New session checks a custom model id against this
  device even when the session will run on another.

## Desktop UI (`web/src`)

- **Archipelago** gets none of the device treatment: a chip turned off
  removes its ships outright (the map reflows), and an offline device's
  ships show no `as of`, no device name, no dimming and no stillness.
- **Context gauge.** A member's session's context window is read from
  this device's model catalog; it differs only when the member's models
  differ.
- **A turn refused because the device went offline** goes back to the
  draft as text; its attached images are lost.
- **"As of" before the server's `machine` event.** While only the roster
  says a device is offline, the detail panel's state line shows no
  `AS OF` until the server's `machine` event for that device arrives.
- **Folder chooser.** No retry after an "offline" answer; the order in
  which Escape closes the chooser and the dialog is unverified.

## Phone (`web/src/mobile`, `shared/src/remote`)

- **Two relay clients.** The server's `RelayClient` and the phone's
  `RelayLink` implement the same protocol separately.
- **A too-old device's rows** still look live in the session list (its
  session screen is read only).
- **This phone's code** is the QR's JSON as one long word; canvas 50i
  draws a short code.
- **A phone left with only other phones.** `GroupClient.grouped()` still
  counts another phone as a member to reach, so a phone whose roster holds
  only phones (a path outside Settings' removal, which leaves) waits out
  `ALONE_GRACE_MS` and shows the unreachable card instead of 9h.
- **Model switcher default.** The header's model switcher of another
  device's session starts from this Mac's `default_model`.

## Roster rule (removed devices)

Closed: the group's primary alone signs the roster (ADR
`the-group-has-one-primary-device`), so a removed device has nothing to
sign with. What remains is listed under Known limits in
`docs/domains/device-group.md`. Left from
the security pass of 2026-10-18:

- **A peer announcing a huge size** may stream that many bytes until the
  download deadline; the size is not capped, because the image store
  keeps transcript images of any size.
- **Keys the relay does not know share one mutual budget per address**,
  which a page on the same network can use up; it only slows re-pairing
  after the relay lost its device rows.
- **After the relay lost its store**, a member whose peer is offline
  cannot leave a half for it until that peer connects again.

