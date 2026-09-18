---
id: sidebar-collapsed-state-should-survive-reload
title: The sidebar's collapsed state should survive a reload
status: done
type: idea
domain: web
related:
  - resizable-detail-panel
tags:
  - shortcuts
---
# The sidebar's collapsed state should survive a reload

`ui.sidebarCollapsed` is per-page-load store state, so a user who collapses
the sidebar gets it back open on every reload. The mechanism to fix it is
already built and proven twice: a settings key with an optimistic store
write (the ENDED toggle's `map_hide_ended`, the panel's
`detail_panel_width` from [[resizable-detail-panel]]).

One key (`sidebar_collapsed`), one `DEFAULT_SETTINGS` row, seed
`ui.sidebarCollapsed` from it in `loadInitial` the way `map_hide_ended`
seeds `ui.hideEnded`, and PATCH in `setSidebarCollapsed` with the same
rollback shape as `setHideEnded`.
