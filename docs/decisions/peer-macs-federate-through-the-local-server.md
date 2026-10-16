---
id: peer-macs-federate-through-the-local-server
title: Peer Macs federate through the local server, as phones to the relay
status: in-force
type: adr
domain: remote
related:
  - 2026-10-06-peer-macs-design
  - the-phone-tunnels-the-api-behind-an-allowlist
tags:
  - remote
  - relay
  - server
---
# Peer Macs federate through the local server, as phones to the relay

## Context

Two paired Macs should show each other's sessions on one map and drive
them with full parity ([[2026-10-06-peer-macs-design]]). Something has to
hold the connection to the other Mac and merge its sessions with the
local ones.

## Decision

The local server does it. It connects to each peer through the existing
relay, merges the peer's `sessions` topic into its own hub, and forwards
requests for a peer's session through the tunnel, where `inject()` serves
them behind an allowlist chosen by the device's platform. The web app
keeps talking to one origin.

The client side of a Mac registers with the relay as a phone
(`kind: 'phone'`, `platform: 'macos'`) under its own identity, so the
relay needs no change and no new release.

## Ruled out

- **Federation in the renderer**, the way `web/src/mobile/transport`
  tunnels: identity keys would live in the renderer, every web client
  would pair on its own, and desktop notifications, which follow the
  server, would not see a peer's sessions.
- **A direct Tailscale or LAN link**: lowest latency, but it binds the
  server beyond `127.0.0.1`, needs Tailscale on both Macs, and steps
  around the relay's end-to-end model. Kept as a possible later shortcut.
- **A new `mac` ↔ `mac` pair kind in the relay**: cleaner on paper, but a
  relay migration and release for no capability the phone kind lacks.

## Consequences

- A forwarded request costs a relay round trip; acceptable for a session
  you drive, not for a tight loop.
- A peer's sessions reach the phone too, through its Mac's merged list.
- A Mac never forwards for a third Mac, so trust stops at one hop.
