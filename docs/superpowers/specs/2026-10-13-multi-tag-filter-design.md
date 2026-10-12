---
id: 2026-10-13-multi-tag-filter-design
title: Filter sessions by multiple tags
type: spec
status: done
domain: sessions
tags:
  - tags
  - mobile
---

# Filter sessions by multiple tags

Sessions tagged with one of many selected tags now appear. A plain click selects only that tag; ⌘-click (or ctrl-click off macOS) adds or removes it from the selection. An empty selection shows all sessions. OR semantics: a session passes if it has any of the selected tags.

## Interaction

### Desktop (web/src/panels/Sidebar.tsx)

**Plain click:** Select only that tag (as before). "All" clears the selection.

**⌘-click/ctrl-click:** Add or remove that tag from the selection. Multiple tags stay selected until clicked again or "All" clears them.

**Empty selection:** Shows all sessions (same as "All").

### Phone (web/src/mobile/screens/SessionListScreen.tsx)

**Tap:** Select only that tag; tapping the only selected tag again clears the filter, as before.

**Long-press (500ms):** Add or remove that tag from the selection. Multiple tags stay selected until cleared by tapping "All".

## State

**Desktop & Phone (web/src/store/store.ts):** 
- Changed `filterTagId: number | 'all'` to `filterTagIds: number[]`
- Empty array = all (equivalent to former 'all')
- Update all consumers of the filter state

## API

**Client (web/src/lib/api.ts):**
- `SessionListParams.tags?: number[]` (was `tag?: number`)
- Sent to server as comma-separated list: `tag=1,3`

**Server (server/src/api/routes.ts):**
- `GET /api/sessions?tag=1,3` (single tag `tag=1` still works)
- Splits comma-separated tags and applies OR semantics
- Backward-compatible with older clients sending single tag

## Phone

The phone filters locally in `groupSessions` without calling the server. It supports the same interaction as before: tap for single tag, long-press for multi-tag selection. The phone does not call the server with tag params — filtering is local.

## Tests

- `matchesSidebarFilters`: Tests OR semantics for multiple tags (web/src/test/store.test.ts)
- `groupSessions`: Tests OR semantics for phone filtering (web/src/test/mobilelist.test.ts)
- Store setter: Tests the new filterTagIds state in web/src/test/store.test.ts
