---
id: 2026-09-24-sessions-end-only-by-hand-design
title: Sessions end only by hand — lineage out, the hole becomes a trash
type: spec
status: done
domain: sessions
related:
  - a-session-ends-only-when-the-user-ends-it
  - the-hole-subsumes-map-declutter
  - 2026-09-18-tag-clusters-design
  - 2026-09-20-pinned-sessions-design
  - 2026-09-21-session-autoheal-design
  - 2026-09-23-end-session-design
tags:
  - server
  - web
  - space-map
  - settings
---

# Sessions end only by hand — lineage out, the hole becomes a trash

Agreed with Tomin on 2026-09-24. The reasoning is in
[[a-session-ends-only-when-the-user-ends-it]].

## The problem

- **Lineage is visual noise.** Clear links the new session to the old one
  (`parent_id`). That link feeds the ancestor dots in the detail header, the
  orb preview in the Clear dialog, and the `lineage_depth` setting with its
  illustration and "+N in history". Nobody uses any of it to decide
  anything.
- **Sessions end on their own.** The Runner ends an idle Orbital session
  after `ended_after_idle_minutes`. After a server restart, every session
  without a process reads `ended`, and autoheal has to guess which ones to
  bring back.
- **Ended sessions linger.** An ended planet stays on the map for
  `map_release_ended_after_minutes` (2 h) and then falls into the corner
  hole. The fall does not play reliably, and the hole keeps getting in the
  way.

## The behaviour

### 1. A session ends only when the user ends it

- New column `sessions.ended_at INTEGER` (epoch ms, `NULL` = not ended).
- `statusOf` (`server/src/api/shape.ts`) becomes: the Runner's status if it
  holds a process → the terminal registry's status → for a terminal session
  (`source !== 'web'`), `ended` as today → for an Orbital session, `ended` if
  `ended_at` is set, otherwise `idle`. `ended_at` means something only for
  sessions Orbital can run; a terminal session nobody is running is simply
  over.
- `ended_at` is **written** by: `POST /api/sessions/:id/end`,
  `POST /api/sessions/:id/clear` (on the old session), and the trash (§ 3).
  Nothing else writes it. A process that exits on its own, a crash or a
  server restart does not end a session.
- `ended_at` is **cleared** by: delivering a message to the session
  (`deliverToSession`, which already revives it), and the new
  `POST /api/sessions/:id/reopen` (the trash's Undo).
- Terminal sessions are unchanged. Their status still comes from the
  registry, and a terminal session whose CLI has exited reads `ended`.

### 2. Idle processes sleep; the idle timer no longer ends anything

- The Runner's idle timer becomes a sleep timer. When it fires, it stops the
  `claude` process and does **not** write `ended_at`. The session reads
  `idle` and revives on the next message through the existing resume path.
- The delay is a named constant in the Runner. It is not a setting, because
  the user cannot see the difference between a sleeping session and an idle
  one.
- The `ended_after_idle_minutes` setting goes away: its Settings row, its
  seed in `database.ts`, its `PATCH /api/settings` branch,
  `setIdleTimeoutMs`, `parseIdleTimeoutMs` and `IDLE_NEVER`.
- The Runner's "stop the process" and "the user ended this" split apart.
  The routes stamp `ended_at`, and the Runner only stops processes.

### 3. The map: ended means gone, the hole becomes a trash

**Ended planets leave at once.** An ended session that is not pinned is not
on the map. It fades out where it is, with no timer and no fall. What goes
away: `map_release_ended_after_minutes` (its Settings row and seed),
`releaseDelayMs`, `RELEASE_NEVER` and the timed branch of `absorptionFor`.

**Pinned sessions are unchanged.** A pinned ended session stays on the map.
The pin still means "keep this here".

**The trash** replaces the hole in the same corner. Dropping a body on it
ends the session:

| dragged session | on drop |
|---|---|
| Orbital, `idle` | ended at once (`POST …/end`), 10 s toast with Undo → `POST …/reopen` |
| Orbital, `working` / `needs_input` | the End session confirmation dialog opens; Cancel leaves it running |
| terminal (any status) | refused: it springs back and the trash says it cannot end terminal sessions |

- A refused drop gets its own drop state next to today's `none` /
  `eligible` / `armed` in `Hole.tsx`. The hint text changes as soon as the
  terminal body is over the trash, and the trash signals it visually.
- Dropping a pinned session ends it and clears the pin, as dragging into the
  hole does today. Undo reopens it and re-pins it.
- Clicking the trash still opens the sidebar's HISTORY.
- `map_dismissed_at` goes away completely. "Hide from the map without
  ending" no longer exists, because the trash now means End. That removes the
  column, `PUT /api/sessions/:id/dismissed`, the indexer's
  clear-on-activity `CASE`, the dismissal branch of `absorptionFor`, and the
  store's optimistic dismissal action.
- `GET /api/sessions/count` stays only if the trash's new design keeps a
  count label. If it does not, the endpoint goes.

**Show the trash** is a new Appearance setting, `map_show_trash`, default
`true`. When it is off, the trash is not drawn and there is no drag-to-end
gesture. The End session button in the detail header is still there.

### 4. Lineage goes

- Migration drops `sessions.parent_id`. It leaves `schema.ts`, `shape.ts`
  (`parentId`), `web/src/lib/types.ts` and both sandboxes.
- `GET /api/sessions/:id` returns `{ session }` without `lineage`.
  `api.getSession`'s type follows.
- `POST /api/sessions` stops accepting `parentId`. Clear stops writing it.
  Clear otherwise works as before: it ends the old session and starts a new
  one, inheriting tags and permission mode by the existing settings.
- Web: the lineage dots in `UtilityStrip`, the lineage cache and
  `invalidateLineage` in `DetailPanel`, `onCleared`'s lineage purpose in
  `ClearDialog` (drop the prop if nothing else needs it),
  `LineagePreviewOrbs` and the "lineage keeps last N" line, the
  `lineage_depth` Settings row with `LINEAGE_STEPS`, `CHAIN_ORBS`, the
  chain illustration and `droppedFromMap`.
- The `lineage_depth` seed goes. Old settings rows stay in existing
  databases, and nothing reads them (as in [[the-hole-subsumes-map-declutter]]).

### 5. Restart: nothing is resumed eagerly

- Autoheal stops spawning processes. At boot, every row with a non-NULL
  `runner_status` gets its flag cleared. If the flag was `working`, the row
  also gets `interrupted_at`, as today. All those sessions read `idle` and
  revive on the next message.
- What goes away: `planAutoheal`'s heal/expire split, `AUTOHEAL_CAP`,
  `AUTOHEAL_NEVER_CEILING_MS`, and the boot-time resume in `index.ts`.

### 6. Migration of existing data

In one migration:

- add `ended_at`;
- set `ended_at = COALESCE(last_at, <now>)` for every `source = 'web'` row
  that is not currently owned (`runner_status IS NULL`). Otherwise every
  historical Orbital session would show up on the map as idle. Terminal rows
  do not need it (§ 1);
- drop `parent_id` and `map_dismissed_at`.

## Claude Design brief

Visual placement belongs to Claude Design. Brief for a new artboard in
`Orbital.dc.html`, next to the hole (4a/4b):

> The corner black hole becomes a **trash**: dropping a planet on it ends the
> session. Same corner, same drag interaction. We need:
> 1. the trash at rest, and while an idle Orbital planet is dragged toward
>    it (eligible) and over it (armed, release ends);
> 2. a **refused** state: a terminal session's planet is over the trash;
>    the hint text reads that terminal sessions cannot be ended from
>    Orbital, plus a visual "no";
> 3. whether the trash keeps a count label and what it counts (today:
>    sessions the map does not draw). Clicking it still opens HISTORY;
> 4. the Undo toast after an idle session is dropped in ("`<title>` ended ·
>    Undo");
> 5. a "Show trash" toggle row in Settings → Appearance;
> 6. how an ended planet leaves the map when it was ended from the
>    detail header (a fade in place, no fall).
>
> Constraints: the trash must not look like a destination for the timed
> fall; there is none now. Working/needs-input drops open the existing End
> session dialog (23a), so no new dialog is needed.

## Tests

- `statusOf`: runner vs registry vs `ended_at` vs idle, and a terminal row with no registry entry reads `ended` without `ended_at`.
- Routes: `/end` and `/clear` stamp `ended_at`; `/reopen` clears it (404
  for an unknown id); a delivered message clears it; `/clear` no longer
  writes a parent; `GET /api/sessions/:id` has no `lineage`.
- Runner: the sleep timer stops the process and leaves the session `idle`,
  not `ended`.
- Boot: owned rows are released without a resume, and `working` rows get
  `interrupted_at`.
- Migration: unowned rows get `ended_at`; owned rows do not.
- Trash drop rules: pure function from (source, status) to
  `end` / `confirm` / `refuse`.
- `absorptionFor` (or its successor): ended + unpinned → gone; ended +
  pinned → drawn; live → drawn.

## Docs to update when built

- [[the-hole-subsumes-map-declutter]] → `superseded` by
  [[a-session-ends-only-when-the-user-ends-it]].
- [[2026-09-21-session-autoheal-design]]: note that eager resume is gone
  (§ 5).
- [[2026-09-20-pinned-sessions-design]]: the pin's timer exemption becomes
  "pinned ended sessions stay on the map".
- This spec → `done`, the ADR → `in-force`.

## Built

Built on 2026-09-24. Where the code differs from the text above:

- The Runner's `end` is named `stop`: it only stops a process, ending is
  the `ended_at` stamp the routes write. `hasRun` answers whether an id was
  ever started, stopped ones included, for the launch route's collision
  check.
- `POST /api/sessions/:id/end` accepts `{ unpin: true }`, which clears the
  pin in the same write that stamps `ended_at`. The trash's drop of a pinned
  session sends it; as two requests the map got an ended-but-pinned row in
  between and the planet faded back in.
- The API session carries `endedAt`; the detail panel's ended footnote
  reads it, falling back to `lastAt` for terminal sessions.
- The fade (§ 3) is timed on the client from when the tab sees the
  transition to ended (`leavingSince`). A session already ended when the
  page loads is simply not drawn; it does not fade.
- The code keeps the name `Hole` (component, constants); only the user-facing
  copy says trash.
- The refused-drop colour uses `--color-warning` until Claude Design gives
  it one.
