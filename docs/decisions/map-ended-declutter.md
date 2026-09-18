---
id: map-ended-declutter
title: Declutter ended sessions on the map, not in the API
status: superseded
type: adr
domain: sessions
related:
  - 2026-09-15-orbital-design
  - the-hole-subsumes-map-declutter
tags:
  - space-map
---
# Declutter ended sessions on the map, not in the API

> **Superseded by [[the-hole-subsumes-map-declutter]]** (tag clusters,
> 2026-09-18): the corner hole absorbs ended sessions after
> `map_release_ended_after_minutes`, replacing both the age cutoff and the
> ENDED toggle described below. The parts that survive unchanged are the
> principles — the cutoff is applied client-side so the sidebar's HISTORY
> stays whole, and live sessions are never dropped by age.

## The problem

The map drew 50 planets of which 44 were `ended` history — on a typical day
six live sessions were lost in a field of dead ones. Nothing ever removed
them: no retention, no age cutoff, no way to filter by status. The index held
384 sessions, 177 of them older than a month, and the only reason all 384 were
not on screen was the default `limit=50` on `GET /api/sessions`.

The `ended_after_idle_minutes` setting looks like it should have covered this
and does not. It lives in `Runner`, whose session map is populated only by
`start()` — web sessions orbital spawned itself. It kills an idle SDK process;
it has nothing to say about drawing. With zero `source: web` sessions in the
index, it had never once fired.

## What we decided

Two mechanisms, both scoped to the map:

1. **An age cutoff.** `map_ended_max_age_days` (default `1`, `never`
   available) stops the map drawing `ended` sessions older than the window.
   Applied client-side in `mapSessions`, as a hard drop.
2. **A manual toggle.** The ENDED segment of the map's aggregate readout is a
   button that suppresses ended planets outright (canvas 2a/2b). It is
   **persisted**, as the `map_hide_ended` setting: a user who decluttered the
   map meant it, and a toggle that comes back on every reload reads as broken.
   `loadInitial` seeds `ui.hideEnded` from it.

Live sessions are never dropped by age. An idle terminal session untouched for
a month is still a real process, and hiding it would be a lie about what is
running.

## What we ruled out, and why

**A cutoff on `GET /api/sessions`.** This was the original plan and it is
wrong. The sidebar splits sessions into ACTIVE and HISTORY by status and pages
HISTORY with `offset: visible.length`; dropping old rows server-side would
empty the HISTORY list and make old sessions unreachable by scrolling, in
direct conflict with the spec's goal of opening any historical session and
continuing it. It would also desynchronise that offset arithmetic from the
server's own filtering.

**Retention in the indexer** — deleting rows from SQLite. Loses history
irreversibly, and does not even work: the `.jsonl` transcripts stay on disk,
so the next scan re-indexes everything it just deleted.

**Per-status filter chips** for all four states. Rejected in canvas 2b: the
readout is already dense, nobody wants to hide `working`, and four chips
invite the reading that this filters the sidebar too.

**`localStorage` for the toggle.** It is a view preference, so a per-browser
store was the obvious home — but `map_ended_max_age_days` is the same kind of
preference and already lives in server settings, and splitting the map's two
declutter controls across two stores buys nothing. Settings also travel
between browsers on the same machine, which for a locally-run tool is what a
user expects.

## Consequences

- The cutoff is stored server-side but applied client-side. A setting that
  only affects one client's rendering is not a query parameter.
- `statusCounts` keeps counting suppressed ended sessions, so the readout says
  "suppressed", not "zero" — it is the thing you click to bring them back.
  Cluster labels do the opposite and count what is drawn.
- `hideEnded` is a per-planet render flag, not a filter. Hidden planets stay
  in the scene model so they can fade out over .5s, and so toggling never
  renumbers the golden-angle spiral and teleports every other planet.
- **Suppressing a planet has to unmount its title, not just hide it.** A
  planet's label is a drei `<Html>`, i.e. content portalled into a plain DOM
  overlay — `group.visible = false` hides the meshes under the group and says
  nothing about it. Hiding the ended planets therefore left their titles
  floating over empty space, which is precisely the clutter the toggle exists
  to remove. `Planet` now fades the span with the hide tween and unmounts it
  (via `useLingering`) once the fade is out. The same applies one level up: a
  cluster whose every planet is suppressed drops its label rather than
  printing `NAME · 0` over nothing, and a label still on screen anchors above
  the topmost planet that is actually DRAWN.
- The toggle writes optimistically: the flip drives a half-second fade on
  every ended planet, so waiting for the save round trip before starting it
  would make the button feel stuck. A rejected save puts the toggle back and
  raises a toast, rather than leaving the map showing a preference the server
  never took.
- `buildSceneModel` takes `nowMs` as a parameter. It stays pure; `useSceneModel`
  owns the clock and re-reads it once a minute.
- The sidebar, its paging, and the API are untouched. History remains complete
  and searchable, which is what the `MAP ONLY · HISTORY LIST UNCHANGED`
  caption promises when the toggle is on.
