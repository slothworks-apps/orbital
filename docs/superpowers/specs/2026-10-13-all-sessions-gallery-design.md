---
id: 2026-10-13-all-sessions-gallery-design
title: The gallery of every session — the media of all sessions in one place
status: done
type: spec
domain: web
related:
  - 2026-10-09-session-media-design
  - media-from-subagents
  - why-orbital
tags:
  - images
  - mobile
---
# The gallery of every session

Each session has had its own media gallery since
[[2026-10-09-session-media-design]]. With many sessions, finding "that
screenshot from yesterday" means guessing which session it was in. This
gallery shows the images and PDFs of all sessions together, grouped by
session and filterable by tag. It reuses the session gallery's tiles and
maximised view.

## What the user sees

### Desktop

- **Entry.** A ▦ button in the sidebar's header, beside «, in the header's
  `IconButton` style. Also **⌘⇧A** ("Media of all sessions", in View
  in the menu and in Settings → Shortcuts), which opens and closes it.
- **The gallery** is a full-window layer over the map. Its header has the
  title, the tag chips (All, then every tag), ⚙ Hide tool images (shown
  once a tool image is loaded) and ×. Escape or × closes it.
- **Tag chips.** A plain click shows that one tag. ⌘-click adds a tag or
  removes it, with OR semantics. **All** clears the filter. This is the
  same behaviour as the sidebar's chips in the multi-tag filter PR. It is
  implemented here on its own, with the same `Chip` change (`onClick`
  receives the event).
- **The grid** uses the session gallery's tiles (`MediaTileButton`): square
  crops, tool runs stacked (⚙ ×n), PDF tags, and NOT ON DISK. A session's
  tiles sit under a one-line heading with its name, and each tile's hover
  title starts with that name. Sessions come by recency of activity, and
  each one's items newest first.
- **Infinite scroll.** The next page loads while the bottom of the grid is
  in view. It loads again after a short page, because the bottom is then
  still in view.
- **Hide tool images** is one switch for this view, kept in `localStorage`
  under `orbital.media.hideTool.*all`.
- **Maximised view.** A tile opens the existing view (`MediaViewer`) in
  *pool* mode. It pages across everything loaded and wraps at the ends. It
  pages in the opposite order to the grid, so › moves forward in time, as
  in a session's own view, and a stack opened on its first frame walks
  through the rest. The caption names the item's session, cut to 60
  characters. **↗ Open session** takes the place of Show in transcript:
  it selects the session and closes the gallery.

Calm (`docs/why-orbital.md`): no unread or "new" marker and no counts on
the grid. Nothing arrives while the gallery is open: what loaded stays put
until it is opened again, and nothing animates in.

### Phone

See § Phone.

## Data

### `GET /api/media`

```
GET /api/media?limit=60&tag=1,3&cursor=<next>
→ { items: AllMediaItem[], next: string | null }
```

- `AllMediaItem` (`@orbital/shared/media`) is a `MediaItem` plus
  `sessionId`, `sessionTitle` and `tagIds` (the session's effective tags,
  as `GET /api/sessions` reports them). `id` stays the item's id within
  its session. The client keys items as `sessionId/id`.
- **Order.** Sessions by `COALESCE(last_at, 0)` descending, then `id`
  descending. Within a session, newest item first. This is the walk, not
  a global sort by item time. A true sort would mean parsing every
  transcript, and grouping by session reads better anyway.
- **Which sessions.** The ones in configured Claude directories, without
  harness drafting conversations — the same set the session list has.
- **Paging.** The server walks sessions in batches of 25 and builds each
  one's list with the one per-session function, `sessionMedia(ctx, id)`
  (`server/src/media/sessionMedia.ts`). It stops when the page is full
  (default 60, at most 200). It also stops after reading 100 sessions, so
  a stretch of sessions without media cannot make one request read every
  transcript. A short or empty page with a `next` is normal, and the
  client follows it.
- **Cursor.** base64url of `[lastAt, sessionId, rest]`: the walk position
  of the last session reached, and how many of its items (the oldest) are
  still to come. Counting from the old end keeps a boundary inside a
  session stable while that session gains items. A session that moves to
  the top during scrolling is not met again in that walk. Reopening starts
  from the top. A cursor that does not decode is a 400.
- **`tag`.** A comma list of tag ids with OR semantics, the same
  convention as `GET /api/sessions?tag=` in the multi-tag filter PR.
  Sessions without any of the tags are skipped before their transcript is
  read.
- **Caching.** Each session's list is held in a `StampedCache` of 1000
  entries, under its transcript's stamp and its pending rewind. Scrolling
  and reopening do not parse an unchanged transcript again. A list is
  references only, a few hundred bytes an item. A named file's `disk` state
  is as fresh as that read. A tile whose file has gone since then draws
  itself as gone when it fails to load. The per-session route stays
  uncached and always fresh.
- Image bytes are served by the existing routes (`/api/images/:ref`,
  `/api/files/image`), read in the item's own session.

### One per-session function

`sessionMedia(ctx: SessionMediaContext, sessionId)` is a thin extraction
of what `GET /api/sessions/:id/media` did: row, presented transcript,
`mediaItems` with `locateOnDisk`. It returns oldest first, or null for an
unknown session. Both routes call it through one `mediaCtx` built in
`registerRoutes`, so a richer builder (subagent media, written files)
reaches both.

## Phone

**Built for the phone too.**

- **Entry.** A ▦ button in the session list's header, left of Settings. It
  opens a base screen, `gallery`, the way Settings does.
- **Screen** (`AllMediaScreen`). The header has ‹ and *Media · All
  sessions*. Below it: tag chips (a tap shows one tag, a tap on the one
  shown goes back to All) and ⚙ Hide tool images. The grid is three
  columns with the phone gallery's `PhoneTile`, under a heading with each
  session's name. Infinite scroll works as on the Mac.
- **Viewer.** A tap opens the existing `MediaPager` (image viewer, PDF
  viewer and gone page) over the grid, which stays mounted, so back finds
  it scrolled where it was. The pager pages across the loaded items and
  stops at either end. Its foot names the session, and **↗ Open session**
  takes the place of Show in chat and opens that session.
- **Back.** `back()` closes the viewer first (`galleryItem`), then
  returns to the list.
- **Reaching the Mac.** `GET /api/media` is on the allowlist
  (`server/src/remote/allowlist.ts`). The bytes go through `blob_get` and
  `file_get`, which every supported Mac already serves.
- **An older Mac.** The phone updates first. `MAC_FEATURES.allMedia` is
  `0.30.0`, the first Mac release that serves the route. Against an older
  Mac, or before the Mac's hello, the ▦ button is not shown at all. If
  another release ships 0.30.0 first, this flag moves to the release
  that carries this change.
- Multi-select on the phone's chips (a hold to add) is left out here. The
  multi-tag filter PR adds it to the session list, and the gallery can
  take the same gesture once that has merged.

## Tests

- Server, pure (`server/test/allMedia.test.ts`). Order and session fields.
  Every page size walks every item exactly once. Sessions without media
  are skipped. Reading stops once the page is full. The scan cap answers
  short and the walk goes on. The tag filter (OR) skips untagged
  transcripts. A session gaining items between pages, or moving to the
  top, neither repeats nor loses an item. The cursor round-trips and
  refuses garbage. `?tag=` parsing.
- Route (`routes.test.ts`). Order across sessions, paging by cursor with
  no duplicates or gaps, the tag filter, 400 on a bad cursor.
- Allowlist: `GET /api/media` with its query string, and nothing else
  under it.
- Web, pure. `pickTag`, `joinPage`, sections (grouping, stacking, hidden
  tool-only sessions) and the paging order. The keymap gains a check that
  no chord is bound twice where both could fire.
- Phone. The `allMedia` gate in `macSupports`, and `back()` from the
  gallery and its viewer.
- The overlay, the viewer's pool mode and infinite scroll were checked by
  hand against a real `~/.claude`, in a browser. The phone screen was
  type-checked, not run on a device.
