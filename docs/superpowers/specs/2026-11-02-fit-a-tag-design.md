---
id: 2026-11-02-fit-a-tag-design
title: Fit a tag — the cluster name frames its own planets
type: spec
status: done
domain: map
related:
  - 2026-09-21-fit-honours-the-panels-design
  - 2026-09-18-tag-clusters-design
tags:
  - space-map
  - camera
  - tags
---
# Fit a tag — the cluster name frames its own planets

## Problem

Fit (⌘F, the `⌖` in the zoom stack) frames the whole map. On a map with
several tags, getting one cluster to fill the view means zooming and panning
by hand, every time.

## Behaviour

- Hovering a cluster's name on the Planets map shows the map's fit glyph,
  `⌖`, after the name, in the tag's colour. It is hidden otherwise, so a
  map at rest looks exactly as before.
- Clicking it flies the camera to frame that tag's planets — the same fit
  as ⌘F (what the planets draw, the panels' insets, the settled positions),
  restricted to the planets of the tag. The trash and the suns are left out:
  they belong to no tag. A tag with one planet zooms in on it up to the
  camera's zoom limit.
- The glyph sits outside the name's flow, so the name stays centred over its
  clump when it appears.
- A press on the name does not start a map pan, the same trade the state
  disc makes: the name is small, and a press there would otherwise reach the
  canvas's raycaster with offsets measured against the name. The wheel still
  zooms the map over it.
- A cluster whose planets are all on a device whose chip is off has a faded
  name; it takes no pointer.

## Scope

- **Who:** anyone with more than one tag on the map.
- **Where:** on by default. It is invisible until the name is hovered, and
  hovering a name did nothing before.
- **What someone notices after updating:** nothing until they hover a
  cluster name — except that a press on the name no longer starts a map
  pan (Behaviour above).
- **Settings:** none. There is nothing in it people would set differently.
- Planets theme only. Desk lays its mats out as a list without a camera to
  fly, and Archipelago is Experimental with its own fit.

## Phone

Left out on purpose: the phone has no space map, it lists sessions. Nothing
here reaches it — no route, no WS topic, no component under `web/src/mobile`.

## Design

The glyph is the map's own fit control (`⌖`), so the target means the same
thing in both places. No artboard yet; if the canvas gets one, its values
replace the inline ones in `ClusterLabel`.
