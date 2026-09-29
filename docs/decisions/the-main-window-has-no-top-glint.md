---
id: the-main-window-has-no-top-glint
title: The main window's top edge has no glint of its own
type: adr
status: in-force
domain: desktop
related:
  - 2026-09-23-detached-session-windows-design
tags:
  - window-chrome
---
# The main window's top edge has no glint of its own

The desktop main window used to draw `TopGlint` across its whole top edge
(in `App`), so it read as the same family as a detached session window.
The sidebar and the detail panel now each draw their own `TopGlint`, and
with the window's on top of them the top of the screen carried three
blue glints. That was too many.

**Chosen: the main window draws none.** The panels' glints stay; they
already mark the window as Orbital's. A detached session window is
unaffected: its glint is the detail panel's own.
