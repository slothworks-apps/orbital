---
id: every-openable-moon-mounts-an-html-portal-and-they-accumulate
title: "Every openable moon mounts an <Html> portal, and ended moons accumulate without a cap"
status: backlog
type: fix
domain: subagents
related:
  - 2026-09-22-subagent-transcript-panel-design
  - moon-button-is-a-plain-dom-child-for-testability
  - map-ended-declutter
tags:
  - web
  - map
  - performance
---

# Every openable moon mounts an `<Html>` portal, and ended moons accumulate without a cap

Found by the whole-branch review of `feat/subagent-panel`. Filed rather than
fixed: it is a cost that grows with usage rather than a wrong result, and
there is no browser tooling in the environment it was found in to measure
what the cost actually is.

## What the bug is

Two decisions this branch made compose into an unbounded one.

**Moons outlive their agents** (spec § 4): `sceneModel` no longer filters
`state === 'ended'`, and an ended moon stays until the user dismisses it.
Dismissal is manual, on a timer of nobody's, so a long session that spawns
agents steadily accumulates moons for every agent it has ever run.

**Every openable moon mounts a DOM portal**
([[moon-button-is-a-plain-dom-child-for-testability]]): `Moon` renders
`<Html center>` wrapping `MoonControl` whenever `openable` is true — which is
true for every moon with a `toolUseId`, ended ones included. drei's `<Html>`
is not free: each instance is a portal into a positioned wrapper `div` that
drei re-projects from world space to screen space **every frame**, per
instance.

So the per-frame DOM work scales with the total number of agents a session
has ever run, and nothing bounds it. Sessions are laid out as clusters of
planets, so a busy map can hold several such sessions at once.

Sessions themselves already have an answer to the same shape of problem —
`map_release_ended_after_minutes` and the hole ([[map-ended-declutter]],
[[the-hole-subsumes-map-declutter]]) — and moons have none.

## What is NOT the bug

An ended moon being openable is correct and deliberate: its transcript is
still in the server's buffer and the panel's whole COMPLETED/FAILED/STOPPED
half exists to show it. The problem is the mounting strategy, not the
lifetime.

## Where to start

Three candidate fixes, in ascending order of cost:

- **Mount the portal on demand.** The hit area only needs to exist when the
  pointer is near it or focus is moving through the map. A single
  `<Html>`-free hit test in three.js (`onPointerOver` on the disc mesh)
  could mount the control only for the hovered moon — at the cost of the
  tab order, which currently comes free from having a real `<button>` per
  moon.
- **Cap or release ended moons**, mirroring the session-level declutter: a
  moon that has been ended for N minutes leaves on its own, and its `OPEN →`
  row in the parent transcript remains the way back
  ([[dismissal-marks-the-agent-only-the-map-reads-it]] makes that route
  reliable). Needs a design decision, since spec § 4 says "not on a timer".
- **Move the whole affordance into three.js**, which removes the portal
  entirely and is already the idiom `Planet.tsx` uses for its own selection
  brackets. Rejected for the review pass that found this (see the ADR) but
  it is the one that makes the cost disappear rather than bounding it.

Measure first. `<Html>`'s per-frame cost has not been profiled for this app
at any moon count.
