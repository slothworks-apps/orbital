---
id: origin-filter-scopes-to-map-and-active
title: The origin filter scopes to the map and the active list, not history
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-17-session-origin-design
  - map-ended-declutter
tags:
  - sidebar
  - space-map
---
# The origin filter scopes to the map and the active list, not history

## The problem

The origin filter (`all` / `started in orbital` / `other terminals`) used to
live in `visibleSessions`, the one selector every surface derives from. One
filter, applied once, reaching the ACTIVE list, the HISTORY list, the map and
the footer count alike.

Redrawing it as a menu in the `ACTIVE` heading forced the question of what it
should actually narrow, because the heading it now sits in names one list of
the two.

## What we decided

The filter narrows **the map and the ACTIVE list**. HISTORY ignores it.

`visibleSessions` no longer applies `ui.sourceFilter`. `mapSessions` applies
it itself, so the planets and the HUD's `statusCounts` behave as before.
`Sidebar` applies it to its `active` slice only.

## Why

Three reasons, in the order they mattered.

**The question the filter answers is a question about live work.** "Which of
these can I actually drive?" is worth asking about the sessions running right
now. A finished terminal session is not read-only — `continue` resumes it as
a `source: web` session — so hiding it under an origin filter answers a
question nobody asked.

**It keeps the word honest.** Because the filter and the badge now cover only
live rows, `read-only` is true wherever it appears. Had the filter reached
HISTORY, the third option would have had to be renamed to something vaguer
(`other terminals`) to avoid lying about ended rows, and the badge and the
filter would have stopped sharing a vocabulary.

**History is what you go to when you know what you are looking for.** It is
already narrowed by tag and by search. An origin filter set five minutes ago
for a different purpose, still silently cutting the archive, is the kind of
state that makes a list look empty for no visible reason.

## What it costs

Two inconsistencies we accepted knowingly:

- **The map still filters its ended planets.** With `in orbital` selected, a
  finished terminal session disappears from the map while its row stays in
  HISTORY. The map filters everything it draws or the filter does not mean
  anything there; the list can afford the finer distinction because it has
  two headings to make it with.
- **The footer count drifts from the ACTIVE count.** `N sessions` counts what
  the tag and search filters leave, origin included. That is now the honest
  reading: it counts the sessions Orbital knows about, not the subset one list
  is showing.

## What we rejected

**Keeping it global** (the pre-existing behaviour, just with a new control).
Cheapest change, and the one we started to make. It fails on vocabulary: a
filter reaching ended rows cannot call them read-only, so the menu would have
had to say `other terminals` while the row badge said `read-only`, teaching
two names for one idea.

**Scoping it to the ACTIVE list alone**, as artboard 3a specifies ("the map
and HISTORY are untouched"). Rejected deliberately: on the canvas the sidebar
is the screen, but in the running app the map is the screen and the sidebar is
its index. A filter that visibly narrows the index while the map behind it
keeps every planet reads as a bug in the map.
