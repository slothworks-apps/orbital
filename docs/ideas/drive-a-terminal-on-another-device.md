---
id: drive-a-terminal-on-another-device
title: Open and drive a terminal on another device of the group
status: backlog
type: idea
domain: remote
related:
  - 2026-10-16-device-group-design
tags:
  - remote
---
# Open and drive a terminal on another device of the group

The group's allowlist leaves the terminals out
([[2026-10-16-device-group-design]] § 6): a terminal is a pty stream,
not an HTTP request, and the channel carries no stream of that shape.
A shell on the headless server, opened from the Mac's map, would be the
first use. It needs a stream message in the channel and a terminal view
that tolerates a relay round trip.
