---
id: move-a-group-to-another-relay
title: Move a whole device group to another relay
status: backlog
type: idea
domain: remote
related:
  - 2026-10-16-device-group-design
  - joining-one-member-joins-the-group
  - the-relay-pairs-two-devices-that-both-sign
tags:
  - remote
  - relay
---
# Move a whole device group to another relay

A group lives on one relay, so while a device is in a group of two or
more its relay field is read-only ([[2026-10-16-device-group-design]]
§ 4). Today the only way to another relay is for every device to leave,
change its relay and join again.

Changing the relay on one member could move every online member with it;
a member offline at the time is shown "not linked — pair by hand"
(canvas 50a, Relay) and comes along through a pairing code.

What it needs:

- a group message naming the new relay (and its secret, if it has one),
  sent over the channels to every member;
- each member reconnecting to the new relay;
- mutual pairs formed on the new relay ([[the-relay-pairs-two-devices-that-both-sign]]);
- the old pairs revoked on the old relay.
