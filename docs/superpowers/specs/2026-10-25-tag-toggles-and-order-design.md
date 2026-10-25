---
id: 2026-10-25-tag-toggles-and-order-design
title: Tag chips toggle, tags keep an order the user sets, and New Session creates a tag
type: spec
status: done
domain: sessions
related:
  - one-tag-per-session
  - desk-mats-order-by-tag-anchors
  - why-orbital
  - tag-order-shared-across-a-group
tags:
  - tags
  - sidebar
  - mobile
---
# Tag chips toggle, tags keep an order the user sets, and New Session creates a tag

**Status: done**, agreed in conversation 2026-10-25, drawn in Claude Design (§ Design) and built the same day.

## Problem

- The session list's tag row behaves like radio buttons: a click shows that
  one tag only. More than one tag needs ⌘-click on the Mac or a long press on
  the phone, and nobody finds either one. Going back to everything takes a
  separate **All** chip.
- Tags come in a fixed order: the default tag first, then the rest in the
  order they were created. The user cannot put the tags they use most at the
  front.
- New Session offers only the tags that already exist. Starting work under a
  new tag means leaving the dialog for Settings → Tags & rules and then
  coming back.

## 1. Tag chips toggle

On the Mac (sidebar) and on the phone (session list):

- A click or tap on a tag chip toggles it, and any number can be on at once.
  The list shows sessions that hold **any** of the selected tags, as the
  multi-select already does today.
- The **All** chip goes away. Nothing selected means every session.
- While at least one tag is on, a **Clear** chip sits at the end of the row
  and turns them all off. It is not there when nothing is selected.
- On the Mac, ⌘-click shows that one tag alone: it turns every other tag
  off. That keeps the radio filter's one-click switch from one tag to
  another, which a plain toggle turns into two clicks.
- A long press on the phone loses its special meaning and does nothing.
- The phone's All chip carried the count of live sessions. That count goes
  away with it, and every tag chip keeps its own count.

## 2. Tags have an order the user sets

- Every tag gets a stored position, and the default tag gets one like any
  other. It can move anywhere in the order and no longer leads by rule.
- `GET /api/tags` returns tags by position. Every list of tags follows that
  order: the sidebar chips, Settings → Tags & rules, the New Session tag
  chips, the detail panel's tag picker and the phone's chips.
- **The map is not affected.** Planet clusters and desk mats stay where
  their anchors put them ([[desk-mats-order-by-tag-anchors]]).
- **Reordering in Settings → Tags & rules:** each tag row gets a grip and is
  dragged by it (§ Design).
- **Reordering in the sidebar:** a tag chip can be dragged sideways along
  the row and dropped between two others. A press that does not move stays
  a click, so it toggles the chip. Clear cannot be dragged and nothing can
  be dropped after it.
- The phone does not reorder. It shows the order the Mac set.

### Server

- Migration: a `position` integer column on `tags`. Existing rows are
  backfilled in today's order (default first, then by id), so nothing moves
  after the update.
- A new tag takes the last position.
- `PUT /api/tags/order` with `{ ids: number[] }` writes positions from the
  array index. The request must name every tag exactly once; otherwise it
  answers 400 and changes nothing. It is not on the phone's allowlist.
- Every tag-list consumer reads the order from the server's response. None
  of them sorts on its own.

## 3. New Session creates a tag

- The desktop New Session dialog's TAG field is a row of chips, not a
  dropdown. It gets a last chip, **+ New tag**, and clicking it turns that
  chip into a name field in place.
- Enter creates the tag with the next free swatch hue (§ Design) and
  selects it. Escape, leaving the field or an empty name backs out.
- A name that already exists, compared case-insensitively, selects the
  existing tag instead of failing. The dialog checks this against the tags
  it already holds. `POST /api/tags` is unchanged, so Tags & rules keeps
  its own handling of duplicates.
- The new tag counts as picked by hand: it overrides a rule match and is
  remembered for the next launch, like any manual pick.
- The phone's New Session has no tag picker, so nothing changes there.
- The website's demo leaves + New tag out: its fake server keeps only the
  tags it starts with.

## 4. Every window follows a change at once

The Mac announces every change of the tag list on the hub topic `tags`
(`TAGS_TOPIC` in `shared/src/tags.ts`). That covers a tag made, renamed,
recoloured, moved on the map or deleted, and the order set. The frame says
only that the list changed. Every desktop window and every phone then reads
`GET /api/tags` again, so a drag on the Mac reorders an open phone's chips
too. A phone with several Macs reads its merged list again.

- A paired device may watch the topic. It is on `MEMBER_ALLOWED_TOPICS`,
  and it says no more than `GET /api/tags`, which the phone already reads.
- An older client does not subscribe, and an older Mac never publishes. A
  phone on an older Mac reads the list on connect, as before.
- A failed save of the order reads the list again rather than putting back
  the one from before the drag. Another change may have landed meanwhile,
  and a list the server refused as stale is replaced by the server's.

## Phone

- **Built for the phone:** § 1 (toggle chips, no All, Clear) in
  `web/src/mobile/screens/SessionListScreen.tsx`.
- **Reaches it anyway:** § 2's order arrives through `GET /api/tags`, which
  is already on the allowlist. An older Mac sends today's order, which is
  still a valid order, so nothing needs a `MAC_FEATURES` gate.
- **Left out on purpose:** reordering on the phone (a sideways drag
  conflicts with scrolling the chip row; the design's hold-to-drag was
  declined) and creating tags in New Session
  (the phone has no tag picker).
- With several Macs in a group, each Mac's tags keep their own order, and
  the groups follow each other as the merge already lays them out.
- **Built for the phone too:** § 4. The phone follows a change of the tag
  list while it is open.

## Scope

- **Who:** everyone who uses tags to split their sessions.
- **Where:** on by default and replacing the old behaviour. There is no
  option to keep radio-style chips: toggle plus Clear does everything
  radio did, one click more at most.
- **What someone notices after updating:** the All chip is gone, a click no
  longer clears the other tags, Clear appears at the end of the row, tags
  can be dragged, and New Session has + New tag. The tag order stays as it
  was until the user changes it.
- **Settings:** none. The order lives with the tags themselves.

## Design

Drawn in Claude Design, `Feature - Tag chips.dc.html` (80a sidebar, 80b phone,
80c New Session, 80d Tags & rules, 80e parts). What it settles:

- **Drag** is a pointer drag, not the browser's drag-and-drop: a press
  becomes a drag after 4 px, the item stays behind at 35 % and a lifted copy
  on the dropdown panel colour follows the pointer. A 2 px bar in body ink
  at 85 % marks the gap — upright between chips, flat between cards. A drop
  in place shows no bar, and Escape cancels. Nothing animates.
- **Filtering animates the list** (80a, 80b): rows that drop out fade where
  they stand and the rest glide into place. It is the view transition the
  sidebar already runs for pinning, with the same 320 ms panel motion, on the
  Mac and on the phone. It is skipped under reduced motion and where the
  browser has no view transitions.
- **Clear** is the resting chip in muted ink with no dot. On the phone it is
  pinned to the right edge of the scrolling row over a fade.
- **Active filter chips** in the sidebar take the neutral pressed look, not
  their hue.
- **New Session's TAG row** is 26 px chips. The name field is the active chip
  with an empty dot, and it grows with the name. Leaving the field cancels,
  like Escape. While it is open the TAG caption reads `· Enter creates · esc
  cancels` or `· already a tag · Enter picks it`, and after a tag is made
  `· new tag · no rules yet`.
- **A new tag's hue** is the first 1e swatch no tag wears yet, in New Session
  and in Tags & rules alike.
- **The grip** is the Desk mat's dot grid, on the tag cards and on the rule
  rows. Only the grip starts a drag, so a click on a card still selects it.

Two things in the design were not taken:

- **Reordering on the phone** (80b, hold 350 ms then drag). Left out, as § Phone says:
  the phone reads the order.
- **One order for the whole group** of Macs. That rests on Shared settings,
  which is not built yet. Each Mac keeps its own order
  ([[tag-order-shared-across-a-group]]).

## Tests

- Server: the migration backfill keeps today's order; `PUT /api/tags/order`
  accepts a full permutation, refuses a partial or duplicated one, and a new
  tag lands last.
- Pure logic: the gap under the pointer in a wrapping row and in a column
  (`dropSlot`), the reorder index math, and the next free hue.
- No tests for chip rendering or the Clear chip's presence.

## Left to the builder

- Where the selection-change logic lives (the existing `toggleTag` covers
  it).
