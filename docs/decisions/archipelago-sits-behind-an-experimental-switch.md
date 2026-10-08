---
id: archipelago-sits-behind-an-experimental-switch
title: Only Planets and Desk are maintained; Archipelago sits behind an Experimental switch
type: adr
status: in-force
domain: map
related:
  - 2026-10-01-map-themes-design
  - themes-share-one-scene-model-renderer-per-theme
  - walkthrough-sits-behind-an-experimental-switch
  - 2026-10-08-release-roadmap
tags:
  - map
  - themes
  - experimental
---
# Only Planets and Desk are maintained; Archipelago sits behind a switch

## Context

[[2026-10-01-map-themes-design]] shipped three map themes — Planets, Desk
and Archipelago — offered side by side in Settings → Appearance. Every
feature that draws on the map has to be built three times, and Archipelago
is the one that falls behind. Orbital is about to go to testers
([[2026-10-08-release-roadmap]]), who should not meet a theme that may lack
newer features or break.

## Decision

Planets and Desk are the maintained themes. Archipelago stays in the app
but is offered only once Settings → Experimental → "Archipelago map" is on,
as the Walkthrough is ([[walkthrough-sits-behind-an-experimental-switch]]).
Without the switch it is not listed in the theme picker, and a stored
`map_theme: archipelago` draws Planets until the switch is turned on again.
A new feature need not reach Archipelago, and a break there does not block
a release.

## Alternatives

- **Remove Archipelago.** Its scene code and geometry are worth keeping for
  now; hiding it costs nothing.
- **Keep all three on equal footing.** The cost of keeping three renderers in
  step is the reason for this decision.
