---
id: desk-mats-order-by-tag-anchors
title: Desk mats are ordered by the tag anchors the map already stores
type: adr
status: in-force
domain: map
related:
  - 2026-10-01-map-themes-design
  - themes-share-one-scene-model-renderer-per-theme
tags:
  - web
  - map
---

# Desk mats are ordered by the tag anchors the map already stores

## Context

The Desk theme lays cards out in one mat per tag cluster. The mats need an
order, and the user needs a way to change it.

## Decision

Mats are ordered by the tag's anchor (`anchor_x`, then `anchor_y`) — the same
stored home the planet clusters and the islands use. Reordering a mat writes a
new anchor for its tag, between its new neighbours.

## Alternatives

- **Free card placement with stored positions.** Matches the mockup, but needs
  a new per-session position store on the server and gives up the stable,
  automatic order.
- **A separate mat order.** A second notion of "where a tag lives" that the
  map does not know about.

## Consequences

The three themes keep one spatial memory: what sits left on the map sits left
on the desk. Reordering mats moves the planet cluster and the island as well.
