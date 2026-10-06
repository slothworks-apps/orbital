---
id: the-phone-may-do-what-the-mac-may
title: A paired phone may do what the Mac may, bypassPermissions included
status: in-force
type: adr
domain: remote
related:
  - the-phone-tunnels-the-api-behind-an-allowlist
  - remote-identity-is-ed25519-with-ephemeral-session-keys
  - 2026-10-06-pairing-code-and-app-lock-design
tags:
  - remote
  - mobile
  - security
---
# A paired phone may do what the Mac may, `bypassPermissions` included

**Decided 2026-10-06**, while reviewing how secure the phone link is.

## Context

The link between the phone and the Mac is end-to-end encrypted, and the relay
can neither read nor inject anything
([[remote-identity-is-ed25519-with-ephemeral-session-keys]]). The routes a
phone reaches are a literal allowlist
([[the-phone-tunnels-the-api-behind-an-allowlist]]). Inside that list, though,
a paired phone can start a session in any directory, send the agent any
prompt, and pick any permission mode, `bypassPermissions` included. The
server does not tell a request from the phone apart from one made on the
Mac. Anyone holding an unlocked, paired phone can therefore run an agent on
the Mac with the user's rights.

One way to narrow that: the server refuses `bypassPermissions` (on spawn and
on a mode switch) when the request came through the tunnel.

## Decision

The phone is not restricted below the Mac. A paired phone may choose every
permission mode the desktop offers. The phone's New Session still does not
preselect `bypassPermissions`, as on the desktop, but the user may pick it.

The risk is closed where it comes from — someone else holding the phone or
pairing their own — by [[2026-10-06-pairing-code-and-app-lock-design]]: a
pairing code typed on the Mac, a required screen lock and an app lock.

## Why

- Claude's own Remote Control does not restrict it either.
- Orbital's users are developers who chose to pair a phone with their
  machine. What their agent may do from it is their call, and they are
  expected to know what `bypassPermissions` means.
- A feature cut down for the user who does not understand it costs every
  user who does. Orbital does not trade capability for protection against
  its own user.

## Consequences

- The security of a paired phone rests on the phone: its screen lock, the
  app lock, and the pairing itself. Those get the effort instead.
- A new allowlisted route is judged by whether the phone should have the
  feature, not by whether it could be misused from a stolen phone.
