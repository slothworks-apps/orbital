---
id: fold-the-header-strip-when-the-branch-joins
title: Fold the header strip behind ⋯ when a worktree branch joins the path
type: idea
status: backlog
domain: web
related:
  - 2026-09-23-end-session-design
tags:
  - web
  - detail-panel
---

# Fold the header strip behind ⋯ when a worktree branch joins the path

End session made the detail header's row 1 six buttons wide on the desktop
build: stats · pin · clear · end ‖ detach · collapse. The path in front of
them still keeps enough width today. Once a worktree branch label sits next
to the path, it does not: with all six buttons and the branch, the path is
left with about 110 px and already truncates to `…/auth-service`.

Claude Design has worked this out already, in `Feature - Header
actions.dc.html`:

- **23c** compares five ways to hold six actions next to path + branch.
  The recommendation is **form 5, adaptive**: show all six buttons while
  path and branch fit, and fold to four when they do not — pin · end · ⋯ ‖
  collapse. The ⋯ menu holds stats (with the readout inline), clear, a
  hairline, then detach (the browser build hides the detach row). Only two
  forms, never five buttons, so the code needs one breakpoint instead of a
  priority list. Pin and End never move, so they stay where the hand
  expects them.
- **23d** is the motion for that fold: buttons collapse width and margin
  on one curve while the ⋯ grows on the same clock; a ResizeObserver on
  the path cell decides, with hysteresis so the strip does not flicker at
  the edge; no motion at mount or while a tooltip or the menu is open;
  reduced motion gets a short cross-fade.

Not built with End session because the header has no branch label yet.
Pick this up together with the branch label; read 23c form 5 and 23d from
the canvas at that point, not from this summary.
