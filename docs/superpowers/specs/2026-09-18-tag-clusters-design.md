---
id: 2026-09-18-tag-clusters-design
title: Tag clusters — spring-field map with a corner black hole
status: done
type: spec
domain: web
related:
  - retag-migration-motion
  - map-ended-declutter
  - one-tag-per-session
tags:
  - space-map
  - motion
  - settings
---
# Tag clusters — spring-field map with a corner black hole

Canvas: `Feature - Tag clusters.dc.html` (artboards 4a, 4b) in the Claude
Design project. Agreed in chat on 2026-09-18. This replaces the map's
deterministic golden-angle layout outright — the direction the
`retag-migration-motion` ADR anticipated but did not build.

## What ships

Sessions with the same tag hold together as a physical clump on damped
springs; the clumps rest at fixed home spots and never orbit. A black hole
sits in the bottom-right of the field: it is the history index. Ended
sessions lose their bond after a configurable delay and fall in; a body can
also be dragged in by hand. Nothing is deleted — absorption only removes a
session from the map, and the sidebar remains the full history browser.

## 1 · Simulation

A new `web/src/map/simulation.ts` owns the physics. No third-party solver:
d3-force was considered and rejected because its `forceCollide` cannot
express pair-dependent minimum distances (same-tag vs cross-tag), which
would leave every force custom anyway, while its global alpha cooling does
not model the design's per-body sleep. The canvas 4a demo script is the
tuned reference implementation and ports directly.

State per body: `x, y, vx, vy, asleep, mode` (`hold | fall | gone`).
`stepSimulation(simState, inputs)` is pure and deterministic — no
`Math.random`, no `Date.now`; any phase or jitter derives from body index,
and the clock arrives as a parameter. Tests drive ticks directly.

Forces, one named-constant block citing canvas 4a/4b (px values converted
to world units at 34 px = 1 unit — canvas 4a's own working-planet radius
against the world's working planet at radius 1; all tunable). One
deliberate divergence: the fall acceleration is retuned to the brief's
~8 s figure rather than converted, because this map's release distances
are proportionally longer than the demo's pixel run (see
[[custom-spring-sim-over-d3-force]]).

- **Cohesion** — spring to the tag's radius-weighted barycentre,
  `k = 0.0011` per tick. Big sessions move the centre more, so the clump
  leans toward the work.
- **Home anchor** — weak spring (`k = 0.0004`) to the tag's home spot.
  Home spots default to the deterministic per-tag anchors: tags on a
  circle around the origin, sorted by tagId ascending with the default tag
  last — exactly the placement `layoutClusters` computes today. A tag the
  user has re-homed (see the drop behaviour in § 3) instead uses its
  stored anchor (`tags.anchor_x`/`anchor_y`, world units, both-or-null),
  which survives reload; clearing both returns the tag to the circle.
- **Separation** — same tag: bodies keep `r₁ + r₂ + 96 px`-equivalent, so
  labels stay legible; different tags: bodies keep a 190 px-equivalent
  gap, which is what draws the visible space between clumps. (4a's footer
  values; the 4b card's 30/150 are an earlier draft of the same numbers.)
- **Hole repulsion** — a bonded body inside the hole's 300 px-equivalent
  halo is pushed out (strength 1.1 at the centre, linear falloff), so the
  hole never eats a working tag.
- **Integration** — velocity damping 0.92 per tick at a fixed 60 Hz
  timestep. A body whose acceleration and speed fall under the wake
  thresholds goes to sleep individually; drag, membership change, or a
  neighbour's motion above threshold wakes it.

## 2 · Scene model and driver

`buildSceneModel` stays pure and keeps producing everything except final
positions: cluster membership, per-tag home anchors, deterministic seed
positions (today's golden-angle spiral around the anchor — where a body
first appears before the springs take over), scales, moons, labels,
counts. `layout.ts` keeps `clusterSessions`, the anchor-circle math and
the spiral as the seed generator; `layoutClusters` as the final-position
oracle goes away.

The mutable sim state lives in a ref inside `SpaceMap`, reconciled against
the scene model on every model change (bodies added at their seed,
removed, or re-tagged — a retag just changes the body's tag and wakes the
sim, so the body walks to the other clump under the springs, preserving
the `retag-migration-motion` behaviour; camera-follow of the selected
planet is retained and reads sim positions). A `useFrame` driver steps the
sim and applies positions imperatively to the planet groups — the same
no-store-writes-per-frame pattern as `transition.ts`. Moons stay
parent-anchored and ride along. Cluster labels anchor above the cluster's
drawn extent and track per-frame.

`prefersReducedMotion`: the same sim is ticked synchronously to
convergence on each model change and rendered statically — same positions,
no animation; falls become instant removals.

## 3 · Interactions

- **Drag a body** — pointer-down on a planet plus movement past a small
  threshold is a drag; below it, the pointer-up stays a click/select
  (today's selection behaviour unchanged). The dragged body pins to the
  pointer; its tag-mates trail behind through the barycentre spring with
  the 1–2 s lag of the brief.
- **A drop re-homes the clump** (canvas 4a brief: "re-settles around
  wherever you let go"; agreed in chat over 4b's drift-home variant): the
  release point becomes the tag's stored home (`setTagAnchor`, persisted
  via `PATCH /api/tags/:id`), so the dragged body stays put and its mates
  fly to it. Two exceptions, decided by the pure `rehomeTarget`: a release
  that absorbs the body keeps the survivors' old home, and a release
  inside the hole's repulsion halo declines (a home the physics fights
  forever is no home) — the clump drifts back instead.
- **Drag into the halo** — releasing an **idle or ended** body inside the
  hole's halo cuts its bond: snap to the hole, ring flash, count ticks up,
  and a toast with **Undo** (10 s). A **working / needs-input** body
  cannot be absorbed — the halo repels it and it springs back on release.
- **Drop-target signal** (added post-canvas, agreed in chat): while an
  absorbable body is in hand the halo brightens (`eligible`); once the body
  is inside the drop halo the horizon ring arms at full opacity and the
  hint flips to "release to absorb" (`armed`). Dragging a working body
  shows nothing — the hole would refuse the drop. The same
  `holeDropState` predicate decides both the signal and the release, so
  the promise and the outcome cannot disagree.
- **Pan and zoom unchanged** — drag on empty space pans; pinch/buttons
  zoom; `bodyZoomFactor` counter-zoom applies as today.

## 4 · The hole

A world-space body (pans and zooms with the map, included in fit-to-view),
pinned bottom-right of the field at a deterministic position derived from
the anchor circle's extent. Visuals per canvas 4a: 50 px-equivalent black
disc, no accretion disc, faint halo, ring flash on absorption. Constant
size regardless of count (canvas open question 3, resolved: constant).
Label: `HISTORY` with `N sessions · click to browse`, where N is the
number of sessions in the index that are not drawn on the map. The client
only ever holds a page of sessions, so the index total comes from a new
`GET /api/sessions/count` (`{ total }`), fetched at load and refreshed on
WS session events; N = total − drawn. Clicking
the hole un-collapses the sidebar and scrolls to its HISTORY section — the
sidebar is already the history browser; the hole is its spatial handle.

**Falls** are scripted per-body animations outside the spring physics
(`mode: fall`, as in the canvas demo): the body accelerates on a straight
line to the hole, stretches along the path, shrinks near the horizon, and
triggers the ring flash on contact.

- Timed release of an ended session: bond fades, body drifts out, slow
  fall (~8 s, the brief's figure).
- Drag-absorption: fast snap from the drop point.
- Finished subagent: its moon detaches and falls in ~1 s — a purely
  visual exit for something that today just vanishes; no persistence, no
  undo, no count change.

## 5 · Absorption semantics and server

Absorption is **map-only dismissal**. Two paths:

- **Manual (drag)** — persisted: `sessions` gains a nullable
  `map_dismissed_at` (ms), exposed on `ApiSession`, written via
  `PUT /api/sessions/:id/dismissed` with `{ dismissed: boolean }`. Undo
  (the 10 s toast) clears it. Any new activity on the session — the
  indexer seeing new transcript lines, the status going live — clears the
  flag server-side, so a continued session flies back out of the hole.
- **Timed (ended sessions)** — derived, never written: an ended session is
  absorbed when `now − lastAt >` the release delay, computed client-side
  in `mapSessions` off the existing minute clock, exactly like today's age
  cutoff. No server writes, no history migration; the fall animation plays
  when a drawn session crosses the threshold while the map is open. No
  undo toast — the setting governs it and the session is one click away in
  the sidebar.

The sidebar, search, `?tag=` filter, detail panel and every API listing
are untouched by dismissal.

## 6 · Settings

`Settings → Sessions` gains a **Clusters** row: *release ended sessions
after* — duration select (30 min / **2 h default** / 8 h / 1 day / never).
It replaces both existing declutter mechanisms, which are removed:

- `map_ended_max_age_days` — superseded by the release delay (the hole is
  where old ended sessions now go, on a much shorter default).
- `map_hide_ended` — removed; the ENDED segment of the map readout reverts
  from toggle-button to plain count. Hiding is the hole's job.

The `map-ended-declutter` ADR gets a superseded-by note; a new ADR records
that the hole subsumes declutter. `bondStrength` / `clusterGap` stay code
constants, not settings (the canvas exposes them as canvas-editor props
only).

## 7 · Out of scope

- **Multi-tag springs / bridge bodies** (canvas open question 1) — moot:
  `one-tag-per-session` is in force, every session resolves to exactly one
  tag with a default fallback, so the "tag removed → floats free" trigger
  row cannot occur either.
- **Lineage over limit** and **pinned sessions** (trigger-table rows) —
  no such product concepts exist; dropped.
- **Clump collapse at 40+ sessions** (open question 2) — not built; the
  release delay bounds map population.
- **Hole growth with count** (open question 3) — constant size.

## 8 · Testing

- `simulation.test.ts` — determinism (same inputs, bit-identical state),
  convergence to rest, both separation floors, sleep and wake, drag-follow
  lag, fall trajectory reaching the hole, live-body repulsion at the halo.
- Updated `sceneModel` / `spacemap` tests — anchors, seeds, membership,
  label anchoring, hole presence and count.
- `store` tests — derived timed absorption in `mapSessions`, dismissal
  round-trip, clearing on activity.
- `settings` tests — new Clusters row, removed toggle and age-cutoff rows.
- Server `database` / `routes` tests — column, endpoint validation,
  clear-on-activity.

Interaction physics that jsdom cannot exercise (pointer capture on canvas
meshes) stays in small pure helpers (`dragThresholdExceeded`,
`releaseTarget`) tested directly.

## 9 · Delivery

Implemented in an isolated worktree branched from `main`, TDD per task,
`atlas validate` before each commit, PR at the end.
