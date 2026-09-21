---
id: context-fill-arc
title: Context fill arc
type: spec
status: done
domain: map
related:
  - models-come-from-the-sdk
  - 2026-09-20-session-stats-design
tags:
  - map
  - runner
  - settings
---

# Context fill arc

A thin arc around each orbital-session planet shows how full the session's
context window is, colour-stepped at two configurable thresholds, with a
`/compact` badge past the second. Design source of truth:
`Feature - Context size.dc.html`, artboards **1i** (arc, thresholds, badge)
and **1h** (settings). Artboards 2a–2d and 3a on that canvas are marked
"not pursued" — ignore them.

**Scope cut agreed with the owner:** the canvas also scales planet diameter
by context (`48 + 62·√…`). We do **not** implement that. Planet, moon and
label sizes stay exactly as the code has them today; this feature is only
the arc, the badge, and their settings. The canvas's "Planet size:
Context / Fixed" setting is dropped; a master on/off toggle (below)
replaces it.

## Where the number comes from (server)

Only sessions Orbital runs itself have usage data, so the feature applies to
`source: 'web'` sessions only (same ruling as `canShowUsage` in
`DetailPanel.tsx:377` — terminal sessions hide, they don't dash).

- **Used tokens.** On each SDK `result` message the runner already receives
  `msg.usage` — the per-turn snapshot of the main agent loop. Context used =
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens +
  output_tokens`, the same formula `extractUsageTokens` in `DetailPanel.tsx`
  uses today.

  > **Corrected in build.** `result.usage` is not a snapshot of anything: it
  > is the turn's total across every API request the turn made, so a turn
  > with tool round-trips counts the whole conversation once per round-trip.
  > The formula above is right for ONE request and wrong for a turn. The
  > runner now asks the CLI (`get_context_usage`) and falls back to the
  > turn's last main-loop call — see
  > [[context-arc-summed-the-whole-turn]]. Extract that shared math into `web/src/lib` rather than
  duplicating it; the server computes the same sum in the runner.
  Cache-read tokens count (the canvas left this open): cached-in tokens
  occupy the window like any others, and this keeps the arc consistent with
  the detail panel's existing readout.
- **Persistence.** New nullable integer column
  `sessions.context_used_tokens`. The runner writes it on every `result`
  that carries usage — a `result` with no usage fields at all is reported
  as *nothing*, not as null, so an unreadable message cannot erase a good
  reading (a compaction is the only thing that nulls the column) —
  and the server republishes the session on the `sessions` topic (the
  `republish()` path in `server/src/index.ts:60` — same precedent as
  subagents and resolved model). This matters because the web map only
  subscribes to `session:<id>` for the selected session; a map-wide
  indicator must ride on the `ApiSession` snapshot.
- **Compaction.** Handle `system` messages with subtype `compact_boundary`
  in `pump()` (today they fall through unread): set `context_used_tokens`
  to `compact_metadata.post_tokens` when present, otherwise null it, and
  republish. This is what makes the arc shrink after `/compact`.
- **Window (denominator).** Client-side via the existing
  `contextWindowFor(session, models)`. Per the in-force ADR
  `models-come-from-the-sdk`: a `null` window means **no arc**, never an
  invented denominator. Do not use the SDK's `getContextUsage()` control
  request — `catalog.ts:81` records why its `maxTokens` is unusable.
- **API shape.** `ApiSession.contextUsedTokens: number | null` in
  `server/src/api/shape.ts`, mirrored in `web/src/lib/types.ts` as
  `contextUsedTokens?: number | null` — optional on the web side for the
  same reason as `pendingDecision`: the server always sends it, absent and
  null read the same, and requiring it would rewrite every session fixture
  in the suite. Terminal sessions are always `null` (the indexer extracts
  no usage).

## The arc (canvas 1i)

A ring outside the planet's existing outer rings, drawn per the canvas:

- **Track + fill.** 2 px ring; conic fill starts at 12 o'clock
  (`from -90deg`) and sweeps clockwise `fraction × 360°`. Unfilled track
  `rgba(190,225,255,.1)`. Sits just outside the halo ring; exact radial
  offsets per artboard 1i (the fill ring is the `inset:-Npx` layer with the
  2 px mask, the tick ring 2 px further out).
- **Ticks.** A second 1-px-wider ring layer holding two 2°-wide tick marks
  in `rgba(240,248,255,.8)` at the threshold angles (T1 and T2 mapped to
  degrees, e.g. 50 % → 180°, 80 % → 288°). Ticks are visible even at 0 %
  fill and move live when thresholds change.
- **Colour by fill level.**
  - fill ≤ T1: the session's tag hue at 0.6 alpha (`oklch(80% .13 <hue> / 0.6)`,
    via the existing `setOklchTagColor` conversion)
  - fill > T1: amber `oklch(80% .13 60)`
  - fill > T2: red `oklch(72% .17 25)` plus a 1.6 s opacity pulse
    (canvas `orb-ring` keyframe: opacity .55 ↔ 1)
- **Who gets one.** Only planets with `source === 'web'`, a non-ended
  status, a non-null `contextUsedTokens` and a non-null context window.
  Ended sessions show no gauge (canvas: "ended · no gauge"). Moons never
  have one — their context is the parent's. Terminal planets are untouched.
- Implementation lives in `Planet.tsx` following its house rules: design
  constants transcribed at the top of the file, preallocated materials,
  opacity driven from the frame loop, `ArcRing`/`TickRing` are the closest
  existing primitives.

## The /compact badge (canvas 1i)

Past T2 a pill appears next to the planet: `NN% · /compact` — JetBrains
Mono 9.5 px, background `rgba(6,10,20,.9)`, border
`oklch(72% .17 25 / .7)`, the `/compact` text in `oklch(80% .15 25)`.
Mount and fade it like `NeedsInputBadge` (the `useLingering` + frame-loop
pattern; position offsets per canvas). If the needs-input pill and this
badge are due at once, needs-input wins — one pill at a time.

Clicking the badge sends `/compact` to the session through the same path
the composer uses to send a message, subject to the same availability
rules (if the composer can't send right now, the badge click does
nothing visible but must not throw). The percent shown is
`round(fraction × 100)`.

## Scene model (web)

`ScenePlanet` gains `contextFill: { fraction: number; level: 'ok' | 'warn'
| 'critical' } | null` (null = no arc), derived in `buildSceneModel` from
`session.contextUsedTokens`, `contextWindowFor(session, state.models)` and
the settings below — the same pattern as the settings-gated `modelFamily`
field. `fraction` is clamped to [0, 1]. The level function is pure and
unit-tested. Remember `useSceneModel.ts`: any new store slice the scene
model reads must be added both to the filler object and the `useMemo`
dependency array.

## Settings (canvas 1h, Sessions page → MAP section)

Three new keys in `DEFAULT_SETTINGS`, string-valued like the rest, UI in
`Settings.tsx` under Sessions → MAP (rows modelled on "Model name under
planet label"; visual values from artboard 1h via DesignSync):

| key | default | UI |
|---|---|---|
| `map_show_context` | `'true'` | Toggle "Context usage on planets" — master switch for arc, ticks and badge. Default-on convention `!== 'false'`. |
| `context_threshold_warn` | `'50'` | Number input, 1–99 |
| `context_threshold_critical` | `'80'` | Number input, 1–99 |
| `map_show_compact_badge` | `'true'` | Checkbox "Show /compact badge above the second threshold"; only effective while the master toggle is on |

Threshold parsing lives next to the other settings parsers in the store:
clamp to [1, 99], fall back to defaults on garbage, and if
`warn >= critical` fall back to the defaults for both (the settings UI
should also refuse to save such a pair). Changing any of these updates
arcs live through the normal settings → store → scene-model flow — no
reload, no server round-trip beyond the PATCH.

The detail panel's existing context bar adopts the same two thresholds for
its colour (today's neutral bar turns amber past T1, red past T2), so the
arc and the panel never disagree — the canvas acceptance "arc colour and
sidebar % change at the same values".

## Edge cases

- Session restarted / server restarted: `context_used_tokens` persists, so
  the arc is right immediately; it refreshes on the next turn.
- Model changes mid-lineage (Clear → new session): new session starts with
  `contextUsedTokens` null → no arc until its first turn ends.
- Fraction > 1 (window learned smaller than actual use): clamp to 1,
  critical level.
- `map_show_context` off: no arc, no ticks, no badge; everything else
  (detail panel readout included) unchanged.

## Testing

Per the repo test rule — logic, not pixels:

- level function: boundaries at T1/T2 (≤ vs >), clamping, null propagation
- settings parsers: defaults, clamping, garbage, `warn >= critical`
- server: context-used extraction (the CLI's own answer, and the fallback to
  the turn's last main-loop call — never the turn's sum);
  `compact_boundary` handling (post_tokens present / absent);
  `contextUsedTokens` in `toApiSession`; column round-trip
- shared token math extracted from DetailPanel keeps its existing tests
  passing

Not tested: arc radii, colours, pulse timing — canvas fidelity is checked
against artboard 1i by hand during the work.

## Clearance around the gauge (owner ruling, 2026-09-21)

The gauge's tick ring is the planet's outermost extent, and two things used
to collide with it on a gauged planet (1i draws gauged planets only as
spec-sheet entries, so the canvas never addressed either):

- **Moon orbits.** The innermost trail starts past the gauge instead of the
  body. Because the planet-size slider scales the render group the gauge
  lives in while orbit radii never see the slider
  (spec 2026-09-18-planet-size-design), the clearance is taken against the
  gauge at `PLANET_SCALE_MAX` — the trail clears the ring at every slider
  setting. `GAUGED_PLANET_EDGE` in `sceneModel.ts`; covered by
  "moon orbits around a gauged planet" in `spacemap.test.tsx`.
- **The session label.** Its rest anchor sat inside the ring band, so the
  title read through the arc. A gauged planet drops it below the tick ring
  with the same 34px gap it keeps below the body edge — the same discrete
  switch as the badges' `clearsGauge` offsets (`LABEL_GAUGED_REST_Y` in
  `Planet.tsx`, untested as a styling value).

## Out of scope

- Planet/moon sizing by context (owner ruling; sizes stay as-is)
- Auto-compact at T2 (canvas open question — revisit as an idea)
- Context history / per-turn stats (belongs to
  `2026-09-20-session-stats-design`, which is transcript-derived and
  historical; this feature is live and SDK-derived)
- Terminal sessions, in any form
