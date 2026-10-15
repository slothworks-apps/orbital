---
id: 2026-10-13-session-media-more-design
title: Session media — subagents' images, images written to disk, whole tiles and a Sources filter
status: done
type: spec
domain: web
related:
  - 2026-10-09-session-media-design
  - media-from-subagents
  - subagents-in-transcripts
  - a-file-link-resolves-against-the-cwd-it-was-written-in
  - why-orbital
tags:
  - images
  - subagents
  - mobile
---
# Session media — subagents' images and images written to disk

A follow-up to [[2026-10-09-session-media-design]]. A session's gallery lists
two more kinds of item: what its subagents produced, and images a tool call
wrote to disk that no reply ever named. With them in the grid, a tile shows
the whole image with a caption, and a **Sources** filter replaces Hide tool
images (canvas `Feature - Media tiles`, 26a–26e).

## Why the earlier exclusions are reversed

The first spec left out a subagent's own images (idea [[media-from-subagents]])
and a `Write` the agent never mentions, which it called "the noisy case". In
practice the screenshots that matter are often exactly these: a subagent
driving a browser, or a script saving a frame the agent never talks about. The
user asked for every screenshot to be in Media. The noise is handled by the
Sources filter: each kind is its own row, and can be turned off.

## Subagents' items

- Read from each subagent's own transcript on disk,
  `<session>/subagents/agent-<x>.jsonl`, joined to the parent through its
  `agent-<x>.meta.json` `toolUseId` ([[subagents-in-transcripts]]). Disk, not
  the in-memory `SubagentTranscripts`, so the list survives a restart.
- Inside a subagent's transcript the same rules apply as in the main one:
  `tool` items from tool_result images, `agent` items from paths in its reply
  text, `written` items as below.
- Each carries `subagent: { toolUseId, name }`. `name` is the moon's name:
  the `Agent` call's `description`, else its `subagent_type`.
- `messageId` is the parent's `Agent` tool_use row, so **Show in transcript**
  goes to where the subagent was launched. The id is `<toolUseId>/<id in the
  subagent's transcript>`.
- Only subagents whose `Agent` call is on the branch the panel presents: a call
  a rewind took away takes its subagent's media with it.
- The lists are merged by timestamp, each list keeping its own order; the main
  transcript's item goes first on a tie.
- In the Sources filter every subagent item is under **Subagents**, whatever
  it is underneath (a screenshot, a named path, a saved file), as the idea
  proposed: turning Subagents off hides all of a moon's output, and **Tools**
  stays the parent's own tool frames.

## Written images

A tool call's input that writes an image is a `written` item:

| tool | where the path is |
|---|---|
| `Write` | `file_path`, when it is an image path |
| an MCP screenshot tool (`mcp__…__…screenshot…`: Playwright, Chrome DevTools) | `filename`, `filePath`, `file_path` or `path` |
| `Bash` | every image path in the command text, by the shared `scanPaths` + `isImagePath` |

- Also the image paths a screenshot tool's **result text** names, when its
  result carries no image (Playwright saving to its output directory says
  where).
- The detection is `writtenImagePaths` in `@orbital/shared/paths`, so the web
  can ask for the list again when such a call arrives.
- Counted only while the file **is on disk now**, resolved against the cwd the
  call was made in (adr [[a-file-link-resolves-against-the-cwd-it-was-written-in]]),
  within the same bounds as `agent` items. A missing file is no item, not a
  NOT ON DISK tile: a `Bash` command naming a path proves nothing about the
  file, so a missing one is not something that was lost. `written` items carry
  no `disk`.
- De-duplicated:
  - against an `agent` item naming the same file (same resolved path) in the
    same turn — between one user row and the next — which stands instead;
  - against itself: one file written several times in a turn is one item,
    the first;
  - against the call's own result: a screenshot whose result already carried
    the image is that `tool` item.
- A `Bash` command that only reads an image (`open out/a.png`) is counted too.
  That is the price of not parsing shell; turning off Saved by the agent hides it.
- Scratch folders count like any other path: Playwright's `.playwright-mcp/`
  is where most of these screenshots land, and they are why this exists.

## Wire format

`MediaItem` (`@orbital/shared/media`) gains:

```ts
source: 'you' | 'tool' | 'agent' | 'written'
subagent?: { toolUseId: string; name: string }
```

`tool` is set on `written` items too (the tool that wrote it).

### An older phone meeting a newer Mac

The phone runs ahead of the Mac, but an older phone can still meet a newer
Mac. `written` is a new value; a shipped phone reads `source` only in
comparisons (`=== 'tool'`, `=== 'agent'`) and in `mediaSourceLabel`'s switch,
and nothing validates the list against a schema. So a shipped phone shows a
`written` item as a plain image tile loaded by its `path` (the same
`file_get` an `agent` item uses), with no source words in the caption, and
does not hide it under Hide tool images. It does not crash and nothing
vanishes, so the new value goes on the wire as is rather than being folded
into `tool` (which would have lied about it carrying an image store ref and
stacked it into tool runs). Subagent items use the existing sources, so a
shipped phone shows them as ordinary items without the subagent's name.

## Tiles

Canvas 26a, 26d. A tile holds the whole image, fitted into its square and
never cropped or upscaled; the bars are the tile's own near-black. A
full-page capture becomes a thin strip, which says "very tall page" before it
is opened.

One caption line under each tile (`mediaTileCaption`):

- the file name when the item has a path, in brighter ink, cut **from the
  front** — saved files differ at the end (`…T14-25-41.png`);
- else where it came from, muted: Attached by you, the tool
  (`Playwright · browser take screenshot`), Named in a reply, Saved by the
  agent, or the moon's name;
- a stack names its tool;
- a subagent's caption leads with the moon's hollow dot, neutral, never the
  tag hue.

The tooltip carries the full name, the source and the time. Tags stay: ⚙ on
the parent's own tool frames (⚙ ×n on a stack), PDF · n, the time top-right
in the gallery, hidden on a NOT ON DISK tile. A subagent's frames and saved
images carry no ⚙: their row in the filter is not Tools. The phone's tiles
are the same, at its size, with the time top-right too.

The source words in the maximised view and the phone viewer follow 26d A:
**From moon <name>** for a subagent's item, **Saved by the agent · not
mentioned in a reply** for a `written` one, ⚙ TOOL only beside a parent's
tool frame.

## Sources filter

Canvas 26a–26c. It replaces Hide tool images. The button says the state:
**Sources: All** at rest, **Sources: 4 of 5** in the filled chip once
narrowed, **Sources: none** when it leaves nothing; the count line reads
`MEDIA · 12 of 19` while filtered.

- Five rows, in order: Attached by you, ⚙ Tools, Named in a reply, Saved by
  the agent, Subagents. One row for all tools and one for all moons, their
  names listed under it (26e), so the list never grows with the session.
- Each row shows its total, so you see what you are hiding. A row with no
  items cannot be toggled and counts as on, so the button never says
  narrowed when nothing is hidden.
- The list stays open while you toggle; Escape or a press outside closes it.
  On the Mac, hovering a row swaps its count for **only**, and ⌥-click does
  the same; **Show all** resets. The phone opens the list as a bottom sheet
  with a checkbox per row and Show all, no only.
- The same filter in the glance, the gallery, the maximised view and the
  phone. Paging and the counter see only what is shown; an item opened from
  the transcript stays reachable while its source is off, until the reader
  moves off it.
- When it hides everything: one line, `Nothing from these sources · n
  hidden`, and Show all — never a blank grid.
- An item from a hidden source raises the total and nothing else.
- Kept per session and **per device**, in `localStorage`, as Hide tool images
  was. A session that had Hide tool images on starts with Tools and Saved by
  the agent off. Sharing it between the Mac and the phone would need a server
  setting, a route on the allowlist and a `MAC_FEATURES` gate; left out.
- A source a newer Mac sends that this client does not know is always shown.

## Server

- `sessionMedia(ctx: SessionMediaContext, sessionId): MediaItem[] | null` in
  `server/src/media/sessionMedia.ts` builds a session's whole list, oldest
  first, null for an unknown session. `GET /api/sessions/:id/media` calls it;
  so does anything listing media across sessions.
- `mediaCandidates(messages)` (pure, no disk) and `locateMedia(candidates,
  locate)` in `server/src/media/items.ts` split the old `mediaItems`, so what
  is read from a transcript can be cached apart from the `stat`s done per
  request.

### Performance

`SubagentMedia` keeps each subagent's candidates under the stamps of its
transcript and meta file. A request lists the subagents directory and stats
two files per subagent; only a subagent whose file moved is parsed again. The
main transcript comes from the parsed-transcript cache the messages route
already uses. File `stat`s stay per request, as before.

## Phone

The phone sees the new items through the same `GET /api/sessions/:id/media`,
already on the allowlist; no new route, no `file_get` kind, so no
`MAC_FEATURES` row — against an older Mac the items simply are not in the
list. The phone's gallery and viewer read `web/src/lib/media`, so the
Sources filter, the tiles, the ⚙ tag and the captions behave as on the Mac;
the filter lives on the phone, not shared with the Mac (§ Sources filter). A subagent's item
opened from the phone's gallery pages with the rest; Show in chat goes to the
`Agent` call's row.

## Not in scope

PDFs a tool call writes (only images count as written), video, and media named
in a background task's output.

## Tests

- Server, pure: written detection for `Write`, a screenshot tool and `Bash`;
  a missing file is no item; de-duplication against the turn's `agent` item,
  within a turn and against the call's result image; a screenshot's result
  text.
- Server: `sessionMedia` merges a subagent's items by time, tags them and
  drops a subagent whose call is off the branch; the route lists a subagent's
  item and a written image from files on disk.
- Web, pure: each item's source row, a subagent's under Subagents; the
  filter's label and count, a row with no items counting as on; captions;
  reading the stored filter back, including Hide tool images; written items
  never stacked into a tool run, and what a press on their path opens.
