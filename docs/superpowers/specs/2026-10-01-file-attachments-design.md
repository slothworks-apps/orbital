---
id: 2026-10-01-file-attachments-design
title: File attachments — any file into a session, by path
status: done
type: spec
domain: web
related:
  - 2026-09-20-composer-design
  - attachments-upload-without-a-session
  - a-dropped-file-reaches-the-agent-by-path
  - an-ide-selection-rides-as-a-quoted-block
tags:
  - attachments
  - composer
---
# File attachments — any file into a session, by path

The composer takes images today (paste/drop → image store → base64 `image`
block). Everything else is refused with "mention the path instead". This
lifts that: drop an `.xlsx`, a `.csv`, a `.zip`, anything — the agent gets the
file and opens it itself, as it does in the CLI when a file is dragged into
the terminal.

The API has no content block for an `.xlsx`, so a non-image is never sent as
bytes. It is sent as **an absolute path the agent can read** (adr
[[a-dropped-file-reaches-the-agent-by-path]]).

## What is an image and what is a file

- **Image**: `image/png|jpeg|gif|webp` up to 5 MB — unchanged, an image chip
  and an `image` block.
- **File**: everything else, including an image over 5 MB (it rides by path
  instead of being refused).
- A folder: a file in the desktop app (its path is as useful to the agent as
  a file's); refused in a browser, which cannot upload one.

## Where the file comes from

- **Desktop app**: the preload exposes `pathForFile(file)`
  (`webUtils.getPathForFile`). When it answers with a path the chip is done
  at once — nothing is copied, nothing uploaded, no size limit.
- **Browser**, or a desktop drop with no path behind it (dragged out of a
  mail client, pasted from the clipboard): the bytes go up through the
  existing `POST /api/attachments` / `POST /api/sessions/:id/attachments`.
  The server keeps them in the **file store**:
  `CONFIG.dataDir/files/<sha256>/<name>` — the directory is content-addressed
  so the same bytes are one entry, the leaf keeps the original name so the
  agent sees `report.xlsx`, not a hash. 100 MB per file.

The upload route decides by media type and size: an image within 5 MB goes
to the image store and answers an `ImageRefEntry` as before; anything else
goes to the file store and answers `{ kind: 'file', path, name, bytes }`.
415 `not_image` is gone; 413 now means over 100 MB.

The file store is capped at 1 GB; past it the least recently written entries
go, as the image store prunes. An entry written again is touched.

## The wire into the session

The composer appends one block to the outgoing text, after what was typed
(and after an IDE selection block, if one rides):

```
<typed text>

Attached files:
- /Users/me/Downloads/report.xlsx
- /Users/me/.orbital/files/<sha>/notes.csv
```

`promptWithFiles` / `parseSentFiles` in `web/src/lib/attachedFiles.ts` are the
contract, the same way `promptWithSelection` / `parseSentSelection` are for the
IDE block. Nothing changes on the messages route, the runner or the
transcript parser: the block is plain text in the transcript, so a session
resumed in the CLI reads it the same.

`cleanTitle` on the server strips the block, so a session named from its
first prompt is not named after a path.

## Composer

- Drop arms for any drag carrying files, not only images. A drag of text or
  a tag rule still never arms it.
- A file chip has the image chip's frame; the thumbnail square shows the
  extension instead of a preview. Meta line: size.
- One limit of 6 chips across images and files.
- Refusals: `TOO LARGE TO ATTACH` (over the per-kind ceiling) and
  `CAN'T ATTACH · folder` in a browser.
- Text sent while a permission or question card is parked settles the card,
  as before. Images are dropped on that path (as before); the file list is
  part of the text, so it rides inside the answer.

## Transcript

`MessageView` reads the block back off a user turn with `parseSentFiles`:
the bubble shows what was typed, the files sit under it as receipts
(extension, name), the full path in the tooltip. A file-only turn has no
empty bubble.

## Permissions

A file outside the session's cwd is read under the session's own permission
mode: in `default` the agent asks for the Read like any other. Orbital never
pre-approves the file store.

## Not in scope

- PDFs as `document` blocks.
- Telling the user, at send time, that a desktop path vanished between drop
  and send; the agent says so when it tries to read it.
- Showing a receipt as "no longer available" once the store pruned it.

## Tests

- server: upload route splits image vs file, 413 over the ceiling; file
  store dedupe, name sanitising (`../x`, `/`, empty), pruning.
- web: `attachedFiles` round trip (with and without typed text, with an IDE
  block in front, a lookalike line mid-text not taken); `precheckFile` kinds;
  `dragCarriesFiles`; `cleanTitle` strips the block (server).
