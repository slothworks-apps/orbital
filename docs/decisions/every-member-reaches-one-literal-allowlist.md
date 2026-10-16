---
id: every-member-reaches-one-literal-allowlist
title: Every member of a group reaches one literal allowlist, the phone included
status: draft
type: adr
domain: remote
related:
  - 2026-10-16-device-group-design
  - the-phone-tunnels-the-api-behind-an-allowlist
  - the-phone-may-do-what-the-mac-may
tags:
  - remote
  - security
---
# Every member of a group reaches one literal allowlist

## Context

The phone reaches a literal list of routes
([[the-phone-tunnels-the-api-behind-an-allowlist]]). PR #79 gave a Mac
peer a second list built the other way round, every route but a few
prefixes, and chose between the two by the platform the device named for
itself at pairing. A group has desktops, servers and a phone, and all of
them belong to one person.

## Decision

One literal list for every member. It is the phone's list plus what the
federated settings need, and leaves out only what makes no sense from
another device: the IDE bridge and "open in editor", which act on the
other machine's screen, the dev tools, the auth and remote routes, and
the terminals. The group itself changes through roster messages in the
channel, never through a route. Who a member is comes from the roster,
not from what it says about itself.

## Ruled out

- **A list per kind of device.** The devices are one person's, and the
  phone already may do what the Mac may ([[the-phone-may-do-what-the-mac-may]]).
- **A denylist** (#79's peer list). A new route would be reachable from
  every member by default, which the phone's ADR ruled out.

## Consequences

- The phone reaches the settings, tag rules and harness templates the
  Mac reaches, through the same list.
- A new route is reachable from no member until it is added here.
