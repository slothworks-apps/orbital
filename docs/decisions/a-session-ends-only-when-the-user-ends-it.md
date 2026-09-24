---
id: a-session-ends-only-when-the-user-ends-it
title: A session ends only when the user ends it
status: in-force
type: adr
domain: sessions
related:
  - 2026-09-24-sessions-end-only-by-hand-design
  - the-hole-subsumes-map-declutter
  - 2026-09-21-session-autoheal-design
tags:
  - server
  - space-map
---
# A session ends only when the user ends it

## The problem

A session's status was derived: no process in the Runner meant `ended`. So a
session "ended" whenever its process went away. That happened when the idle
timer fired, when the server restarted or when the SDK generator finished.
Ended sessions then lingered on the map for a release delay and fell into a
corner hole, and Clear chained sessions into a lineage the UI drew in three
places. The map showed a lot of history the user had never asked to close.

## What we decided

- **"Ended" is a record, not the absence of a process.** `sessions.ended_at`
  is written only by the user's explicit actions (End, Clear, the trash)
  and cleared when the session is used again. Without it and without a
  process, a session is `idle`.
- **Processes sleep instead of ending.** The idle timer still stops idle
  `claude` processes, so a forgotten session does not hold a process for
  days. It no longer ends the session, and revival on the next message
  already exists. The delay is a constant: the user cannot see whether an
  idle session's process is asleep, so there is nothing for them to set.
- **Ended leaves the map at once**, pinned sessions excepted. The release
  timer and its setting go away.
- **The hole becomes a trash.** Dropping a body on it means End: idle ends
  at once with Undo, working/needs-input asks first, terminal is refused.
  Hiding without ending (`map_dismissed_at`) goes away. Once "ended" means
  "in history", hiding and ending are the same wish. The trash can be
  turned off in Appearance.
- **Lineage is removed**, `parent_id` included.
- **Autoheal stops resuming at boot.** Restarts no longer end anything, so
  there is nothing to heal. Mid-turn kills are still marked `interrupted`.

## What we ruled out

- **Keeping processes alive until the user ends the session.** It is simpler,
  but a dozen forgotten sessions would hold a dozen `claude` processes
  indefinitely.
- **Removing the hole outright.** It would lose the drag gesture, which is
  quicker than opening a session to press End. Tomin wanted it as a trash,
  with a setting to hide it.
- **Letting the trash end working sessions without asking.** An accidental
  drag would interrupt a running turn. Those drops open the End dialog.
- **Keeping `parent_id` unused.** Nothing reads or writes it after this
  change, so it is dropped rather than left to look meaningful.

## Consequences

- Every existing unowned row is stamped `ended_at` by the migration.
  Otherwise all history would reappear on the map as idle.
- A server restart is invisible on the map: sessions stay idle, and at most
  their next message pays for a resume.
- Settings lose `lineage_depth`, `ended_after_idle_minutes` and
  `map_release_ended_after_minutes`, and gain `map_show_trash`.
