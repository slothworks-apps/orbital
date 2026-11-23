---
id: the-tips-button-is-on-and-cannot-be-hidden
title: The tips button is on for everyone after the update and cannot be hidden
type: adr
status: in-force
domain: desktop
related:
  - why-orbital
  - 2026-11-16-tips-design
tags:
  - tips
  - map
---
# The tips button is on for everyone after the update and cannot be hidden

## Context

[[why-orbital]] → What gets in says a new feature arrives off, in Labs, or
as an option beside the old behaviour, and that an update changes nothing
the user did not choose. [[2026-11-16-tips-design]] adds a bulb to the map's
corner column, above the error log, with a quiet dot while a tip has not
been shown yet.

Tips exist for people who do not know a feature is there. Those are the
people who do not browse Settings or Labs, so a tips button they have to
turn on first would reach almost nobody it is meant for.

## Decision

The tips button is on by default, for new and existing installs alike, and
there is no setting to hide it, like the error log's `!`. This is a
deliberate exception to "An update changes nothing you did not choose".

What keeps it inside the calm rules:

- It never opens by itself and nothing appears anywhere else: no notice,
  no toast, nothing in New session.
- The dot has no number and no motion, and it goes once every tip has been
  shown or All tips has been opened. It returns only when an update adds a
  tip.
- At rest, with nothing new, the bulb is in muted ink, like the `!` with
  no unseen errors.

## Alternatives

- **Labs, or off by default.** Only people who already read Settings would
  find it, and they need tips least.
- **A setting to hide the button.** Considered and left out for now: the
  button is one muted 34 px square in a column that already exists. Revisit
  if people ask for it.
- **No button; tips in an existing place** (the map's notice queue, the New
  session dialog, Settings). The notice queue and New session would push
  tips at people. A Settings section would be as hidden as Labs.
