---
id: the-hole-subsumes-map-declutter
title: The corner hole is the one answer to "where did my ended session go"
status: in-force
type: adr
domain: sessions
related:
  - map-ended-declutter
  - 2026-09-18-tag-clusters-design
tags:
  - space-map
  - tags
  - settings
---
# The corner hole is the one answer to "where did my ended session go"

## The problem

The tag-clusters map (canvas 4a/4b, spec `2026-09-18-tag-clusters-design`)
gives ended sessions a destination: the bond is cut after a delay and the
body falls into the corner hole. That overlapped both existing declutter
mechanisms from [[map-ended-declutter]] — the `map_ended_max_age_days`
cutoff that silently dropped old ended planets, and the `map_hide_ended`
toggle on the ENDED readout. Three controls would have answered the same
question three different ways.

## The decision

Absorption subsumes both:

- `map_release_ended_after_minutes` (default `120`, `never` available)
  replaces `map_ended_max_age_days`. Same shape — stored server-side,
  applied client-side in `mapSessions`, so the sidebar's HISTORY list and
  its offset paging never change — but the session now *goes* somewhere
  visible instead of silently not being drawn.
- `map_hide_ended` is removed and the ENDED readout segment reverts from a
  toggle-button to plain text. Hiding is the hole's job; an instant-hide
  override would compete with the release delay for the same meaning.

Old settings rows are left in existing databases (nothing reads them);
fresh databases no longer seed them.

## Scope decisions that came with it

- **Absorption is map-only.** `map_dismissed_at` on `sessions` records a
  manual drag into the halo; the timed release is *derived* client-side
  from `lastAt + delay` and never written. The sidebar, search, `?tag=`
  filter and detail panel ignore both. Any new activity (a sent message,
  the indexer seeing the transcript grow) clears the stamp.
- **Only idle/ended bodies can be dragged in**; a working session is
  repelled by the halo and springs back. The map never hides a running
  process — the same principle that kept live sessions out of the age
  cutoff.
- **Undo is a 10s toast** on manual absorption only. A timed fall needs no
  undo: the setting governs it and the session is one click away in the
  sidebar.
- **The hole stays a constant 50px-equivalent** (canvas open question 3)
  and its label count is `index total − bonded bodies`, fed by the new
  `GET /api/sessions/count`.
- The canvas trigger rows for **lineage over limit**, **pinned sessions**
  and **tag removed** are dropped: no lineage-limit or pin concept exists,
  and under [[one-tag-per-session]] a session always resolves to a tag, so
  "untagged floats free" cannot occur.

## Consequences

- The default time an ended session stays on the map fell from 1 day to
  2 h. Deliberate: the map is for what is happening, the hole for what
  happened, and the sidebar remains complete either way.
- `statusCounts` still counts released-but-falling sessions as ended, so
  the readout matches what is momentarily on screen.
- Clicking the hole opens the sidebar's HISTORY (`revealHistory()`), which
  keeps the sidebar the only history browser rather than growing a second
  one behind the hole.
