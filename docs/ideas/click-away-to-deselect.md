---
id: click-away-to-deselect
title: Deselect by clicking empty space
status: backlog
type: idea
domain: web
related:
  - selected-session-lives-in-the-url-query
tags:
  - space-map
---
# Deselect by clicking empty space

Clicking the map's empty space does nothing. Escape is the only way to close a
selection, through `App`'s outermost escape layer.

Left-drag pans (3px `DRAG_THRESHOLD_PX` separating a drag from a click,
`draggedRef` swallowing the trailing click a drag-release produces) and
left-click on a planet selects, via `Planet`'s own `onClick`. Click-away is
the missing third.

## Use R3F's own hook, not a DOM handler

The trap, worth recording before anyone writes the obvious version: a `click`
handler on the container fires for planet clicks too. `Planet`'s
`event.stopPropagation()` stops propagation *among R3F objects* — the native
event still bubbles to the container, so a naive handler would deselect the
planet it had just selected.

R3F answers this exactly: `<Canvas onPointerMissed={…}>` fires for a click
that intersected nothing. That is "clicked outside a planet", with no
hit-testing to hand-roll.

It needs the `draggedRef` guard `handleSelect` already uses — releasing a pan
over empty space must not deselect — and that ref is already reset on
`pointerdown` and read after `click`, which is the ordering this wants too.

## Middle-button pan: ruled out

Panning with the middle button was considered alongside this and **dropped on
purpose**: a trackpad has no middle button, and Orbital is a Mac tool. One
gesture set that works everywhere beats a mouse-only shortcut, even an
additive one. Left-drag stays the pan.

## Also

Clearing `selectedId` already drops `?session=` from the URL
([[selected-session-lives-in-the-url-query]]), so nothing is needed there. It
does make a selection easy to lose by accident, which argues for keeping the
click-away strict — an exact click, the 3px threshold honoured — rather than
anything looser.
