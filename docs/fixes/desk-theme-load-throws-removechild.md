---
id: desk-theme-load-throws-removechild
title: Loading the app with the Desk theme throws removeChild from a map label
type: fix
status: backlog
domain: map
related:
  - leaving-needs-input-throws-removechild
tags:
  - map
  - desk
---

# Loading the app with the Desk theme throws removeChild from a map label

## What happens

With `map_theme` set to `desk`, every page load logs an uncaught
`NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be
removed is not a child of this node`. The Desk renders and works; the
Planets theme loads without the error.

## Where it was seen

2026-10-25, in the browser build served by a throwaway server, on `main`
(origin/main at the time) as well as on the context-menu branch — so not
caused by that change. Three reloads, three errors.

With `Node.prototype.removeChild` wrapped, the failing call removes a drei
`<Html>` wrapper (`<div style="position: absolute; transform: none;
pointer-events: none;">`) from the map's label root (`<div style="position:
absolute; top: 0px; left: 0px;">`) after the node had already been detached
(`parentNode` null). Its content is a right-aligned mono column
(`transform: translate(-100%, -50%)`), which looks like a sun's or the
limit sun's label on the Planets map.

## Likely cause

The page first renders the Planets map (the default theme until the settings
arrive), then switches to the Desk and unmounts the r3f canvas. drei's
`<Html>` roots are torn down with the canvas before React's commit removes
their wrappers — the same family as
`leaving-needs-input-throws-removechild`. Not confirmed.

## Where to start

Hold the map's renderer until the settings have loaded, so a Desk user never
mounts the Planets canvas at all; or find which `<Html>` label unmounts its
own node first.
