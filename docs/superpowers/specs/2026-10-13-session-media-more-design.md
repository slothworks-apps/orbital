---
id: 2026-10-13-session-media-more-design
title: Session media — subagents' images and images written to disk
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
wrote to disk that no reply ever named.

## Why the earlier exclusions are reversed

The first spec left out a subagent's own images (idea [[media-from-subagents]])
and a `Write` the agent never mentions, which it called "the noisy case". In
practice the screenshots that matter are often exactly these: a subagent
driving a browser, or a script saving a frame the agent never talks about. The
user asked for every screenshot to be in Media. The noise is handled the way
tool images already are: these items sit under the same **Hide tool images**
switch.

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
- Hide tool images hides a subagent's `tool` and `written` items, as it does
  the parent's. Paths a subagent names in its reply stay, as the parent's do.
  (The idea proposed hiding every subagent item; a named path is the agent
  choosing to show something, so it is treated the same wherever it comes from.)

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
  That is the price of not parsing shell; the switch hides it.

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

## Caption

In the maximised view and the phone viewer, following 24e's source line:

- a subagent's item: **Subagent · <name>**;
- a `written` item: **Written by the agent**, with ⚙ TOOL beside it as a
  tool frame has, since the switch treats it as one.

Tiles tag a `written` item ⚙ like a tool frame. No new design: the existing
tag, caption and switch. The switch keeps its label, **Hide tool images**; it
now also hides written images. Nothing marks an item as new (`why-orbital`).

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
list. The phone's gallery and viewer read `web/src/lib/media`, so Hide tool
images, the ⚙ tag and the caption behave as on the Mac. A subagent's item
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
- Web, pure: written items are hidden and counted with tool images, never
  stacked into a tool run, and are what a press on their path opens.
