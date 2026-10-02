---
id: 2026-10-01-map-themes-design
title: Map themes — Planets, Archipelago and Desk over one scene model
status: done
type: spec
domain: map
related:
  - why-orbital
  - themes-share-one-scene-model-renderer-per-theme
  - desk-mats-order-by-tag-anchors
  - state-labels-are-dots-first-on-the-map
  - the-hole-subsumes-map-declutter
  - context-fill-arc
  - 2026-09-18-tag-clusters-design
tags:
  - map
  - settings
  - web
  - server
---
# Map themes

The map can be drawn three ways, chosen in Settings → Appearance → MAP:
**Planets** (today's map, the default), **Archipelago** and **Desk**. A theme
changes only the map surface. The sidebar, the detail panel, the subagent
panel and every dialog stay as they are. All three themes reach full parity
with the planet map: the same sessions, states, labels, context arc,
compaction, subagents, history drop, cluster re-homing, camera and filters.

Everything here is weighed against [[why-orbital]]: no theme blinks, waiting
is a calm state, nothing leaves behind the user's back.

## 1. Setting

- Key `map_theme`: `planets` | `archipelago` | `desk`. Parser `mapTheme(settings)`
  in `store.ts` falls back to `planets` on anything unknown, like `mapStatePills`.
- Settings → Appearance → MAP gets a **Theme** row with a `Segmented` control
  (*Planets / Archipelago / Desk*), written through `patchAndSet`.
- `planet_scale` applies to Planets only; its row is hidden for the other themes.
  Every other map setting (`map_state_pills`, `map_show_model`,
  `map_show_context`, `map_show_compact_badge`, context thresholds,
  `map_show_trash`, `map_scale_labels`, fps caps) applies to all three.

## 2. Architecture

- `map/MapView.tsx` reads `map_theme` and mounts the renderer. `App.tsx` mounts
  `MapView` where it mounted `SpaceMap`.
- `map/shell/MapShell.tsx` holds the overlays the new themes share — aggregate
  HUD, zoom column, new-session CTA, error log, camera readout, sloth, the End
  dialog a history drop opens — and `useMapInsets`, the panel-driven insets.
- Camera, drag and the history drop are built per renderer from the same pure
  pieces the planet map uses: `camera.ts` (`zoomAt`, `applyPan`,
  `screenToWorld`, `fitViewTo`, `bodyZoomFactor`), `HOLE_DROP_RADIUS`,
  `trashDropFor`, `setTagAnchor`. Moving `SpaceMap` itself onto the shell is
  left for later ([[spacemap-onto-the-map-shell]]).
- Planets keeps its R3F canvas, `Planet`, `Moon`, `Hole`, unchanged.
- `map/archipelago/` — an SVG renderer. Island shape, pier, berths and routing
  around an island are pure functions in their own module.
- `map/desk/` — a DOM renderer.
- All three read one `useSceneModel()`. No theme adds a model of its own.
- Archipelago animates in a rAF loop capped by `frameSchedule` (focused and
  background fps; hidden or fps 0 pauses). Desk uses CSS transitions, paused
  by the same `data-paused` signal. `prefersReducedMotion` makes every theme
  jump to its settled state.

## 3. Archipelago

**Islands.** One island per tag cluster, placed at the cluster's anchor from
the scene model, so it sits where the planet cluster sits. Size grows with the
number of sessions. The tag hue colours village roofs, the warehouse flag and
the hull stripe of its ships. The island plaque carries the cluster label
(`NAME · N`). Village windows light with the number of working sessions.

**Ships by `sessionStateKey`:**

| state | ship |
|---|---|
| working | sails set, circling the island, wake, cabin windows lit |
| waiting | sails slack, hove-to off the island, rowboats out |
| needs_input | at the pier, amber flag, stern lantern breathing slowly |
| done | at the pier, sails furled, hollow-dot flag |
| interrupted | anchored off the pier, interrupted-tone flag |
| idle | moored in the island's bay, sails furled, no flag |
| ended, pinned | anchored aside, grey |
| ended, leaving | sails furled, fades out in 500ms like a planet |

The pier has two berths; further ships moor along the coast beside it. Ships
route around an island, never across it.

**Ship label** — title (typed out in full on hover when truncated), model
family as a second line, the state dot or pill per `map_state_pills`, the
latest tool call (§ 5), `/compact` and `COMPACT FAILED` badges, the detached
badge. The context arc is a thin ring around the ship with the planet's
thresholds, colours and conditions. Compacting: sails furled, two rings
contracting, `COMPACTING m:ss`. Selected: the planet's language — a slowly
turning dashed ring and corner brackets. Muted: 0.28 opacity, rowboats too.
`bodyZoomFactor` keeps ships readable when zoomed out.

**Subagents are rowboats.** materializing — lowered at the ship's side;
working — rowing to the shore and scouting along it; needs_input — stopped with
a small amber lantern. An inert subagent is tied alongside and cannot be
opened. Click opens the subagent panel; the open one gets a ring and a tether.

**History is a lighthouse on a rock** at the hole's position:
`HISTORY · N sessions · click to browse`. While a ship is dragged it brightens;
over it, "release to end"; a terminal session turns it amber with
"can't end a terminal session". Release runs the existing flow. Click reveals
history. `map_show_trash=false` removes it.

**Interaction.** Dragging a ship or an island re-homes the island
(`setTagAnchor`). Pan, wheel zoom, fit, follow-selected, Escape — the shared
camera.

**Calm.** Nothing blinks. The only periodic motion is slow: sailing, lantern
breathing, surf. Critical context pulses as it does on the planet map, so
every theme carries the same information.

## 4. Desk

**Mats.** One mat per tag cluster, in columns ordered by the tag anchor
(`anchor_x`, then `anchor_y`), so left-to-right matches the map; scrolls
horizontally when they do not fit. Header: hue, `NAME · N`, counts by state.
Dragging a mat header reorders the mats; the drop writes a new anchor for the
tag (`setTagAnchor`, x between its new neighbours), which moves the planet
cluster and the island too ([[desk-mats-order-by-tag-anchors]]).

**Cards.** Stable order inside a mat (by session id); cards never reshuffle.
A card shows:

- the hue, the title on up to two lines (full on hover), the state pill
  (`statePill`, `stateColor`, dot or label mode), the detached badge;
- branch (`git`) · model family;
- the latest tool call, crossfading as it changes, and a strip of tool calls
  over the last two minutes (§ 5);
- the context fill as a thin bar along the bottom edge — thresholds and colours
  as the arc — with the `/compact`, `COMPACT FAILED` and `COMPACTING m:ss` badges;
- subagents as strips with their names; click opens the subagent panel, inert
  ones do not open;
- needs_input: the question unfolds on the card. Permission and plan:
  Allow / Deny. A single-select question: its options. Free text, multi-select
  or anything richer: "Answer", which selects the session and opens the detail
  panel. Terminal sessions are read-only and get no buttons.

done reads a calm DONE; interrupted wears its tone; idle is neutral; a pinned
ended card is faded and compact; a leaving card folds in 500ms. Selected:
accent border and corner brackets. Muted: 0.28 opacity.

**History** is a drawer at the bottom left, beside the sidebar, `HISTORY · N sessions · click to
browse`, with the same drop states and flow as the lighthouse.

**Controls.** Click selects; Escape deselects; ⌘F scrolls the selected card
into view. The zoom column is hidden; the HUD, the CTA and the error log stay.

## 5. Recent tool calls (`recentTools`)

- Server: an in-memory `RecentToolsStore` modelled on `SubagentStore`, keeping
  the last 30 tool calls per session as `{ name, summary, at }`.
- `summary` is a short argument — a path, a command, a pattern — capped at 80
  characters. File contents and tool output are never sent.
- Fed where `tool_use` blocks already pass: the runner for Orbital's sessions,
  the transcript path for terminal sessions. Dropped when the session is dropped.
- `toApiSession` adds an optional `recentTools`; absent and empty mean the same.
  No new endpoint — the snapshot and the existing WS updates carry it.

## 6. Testing

Only where a test can catch a real regression:

- server: `summary` extraction across tools (Edit, Bash, Grep, Agent, MCP,
  unknown), the 30-entry cap, drop on session drop;
- archipelago geometry: berth by state, pier overflow, routing that never
  crosses land, island size;
- desk: mat order from anchors, the anchor written by a mat drop, stable card order;
- `mapTheme` parsing and the Theme row; `planet_scale` hidden off Planets;
- the planet map is untouched, so `spacemap.test.tsx` holds as it is.

Not tested: that components render their props, colours, animation lengths.

## 7. Order of work

Each step lands on its own: (1) the shared overlays (`MapShell`);
(2) `map_theme`, the settings row, `MapView`; (3) `recentTools`;
(4) Archipelago; (5) Desk.
