---
id: group-settings-converge-by-last-change
title: The group's shared settings live on every member and converge by last change
status: in-force
type: adr
domain: remote
related:
  - 2026-10-24-group-shared-settings-design
  - the-group-has-one-primary-device
  - every-member-reaches-one-literal-allowlist
  - a-member-is-granted-groups-of-the-allowlist
tags:
  - settings
  - remote
  - group
---
# The group's shared settings live on every member and converge by last change

## Context

Every device in a group belongs to one person, so a preference should be
the same on every Mac and server in it, and the phone should get one answer
whichever Mac it asks ([[2026-10-24-group-shared-settings-design]]). The
relay is blind and stores no group state. Members already talk end to end
over a channel per pair, and the group has one primary.

## Decision

- **Shared versus per device is a fixed list in code**
  (`SHARED_SETTING_KEYS`). An unlisted key stays on its device. Paths,
  directory ids, layout, desktop notifications and every `remote_*` key are
  per device.
- **Every member holds the full copy.** Each shared key carries a stamp
  (time, device). There is no owner of the shared values, the primary
  included.
- **Last change wins.** Members push changes to every live member that
  supports sync, and compare everything when a channel comes back. A tie,
  which in practice is two untouched values, goes to the primary and then to
  the higher device id.
- **A joining member resets its stamp times to -1**, below every value in the group, so the group's values
  replace its own.
- **The tag list converges the same way**, per tag, with a group-wide id so
  a rename travels and a stamped tombstone so a delete does. Tag rules stay
  on each device, because they match paths.
- **No conflict prompt, no switch to turn it off.**

## Alternatives

- **The primary owns the values; others read or forward to it.** Simple and
  conflict-free, but a change made while the primary is off is lost or
  refused, and every Settings read on a non-primary goes over the channel.
  The group already works with the primary offline for everything except
  membership.
- **The relay stores the shared values.** Would need the relay to know
  groups and keep (encrypted) state. It is blind by design.
- **Ask the user on conflict.** A conflict needs the same setting changed on
  two disconnected Macs, which is rare. A prompt about it is the kind of
  interruption `docs/why-orbital.md` rules out.
- **Sync every setting.** Machine paths would break launches on the other
  Mac, and the user wants layout and desktop notifications per device.
- **A version vector or CRDT per key.** Correct under clock skew, but heavy
  for a few dozen strings set by one person. The cost of skew is that an
  older edit can win when two offline edits race, which the user can redo.

## Consequences

- Clock skew between Macs can let an older offline edit win a race. This is
  accepted.
- On the first connection after updating, the non-primary members of an
  existing group take the primary's untouched values. This is said in the
  changelog.
- Whoever adds a setting must place it in a class, and a test enforces it.
- A member too old for sync keeps its own values until it updates.
