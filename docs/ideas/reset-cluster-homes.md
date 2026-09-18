---
id: reset-cluster-homes
title: A way to reset dragged cluster homes back to the automatic layout
status: backlog
type: idea
domain: web
related:
  - 2026-09-18-tag-clusters-design
tags:
  - space-map
  - tags
---
# A way to reset dragged cluster homes back to the automatic layout

Dropping a dragged body re-homes its tag's clump, persisted as
`tags.anchor_x`/`anchor_y`. The API can already clear a stored home
(`PATCH /api/tags/:id` with `anchor_x: null, anchor_y: null` — the store's
`setTagAnchor(tagId, null)` wraps it), but no UI offers it: a user who has
scattered their clumps has no way back to the deterministic circle layout
short of the API.

Candidates: a "reset layout" action beside the map's fit control, a
per-tag reset in Settings › Tags & rules, or a long-press on a cluster
label. Whichever it is, it should say what it resets (one tag vs all).
