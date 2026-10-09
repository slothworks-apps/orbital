---
id: 2026-10-09-session-media-design
title: Session media — every image and PDF of a session, in one place
status: draft
type: spec
domain: web
related:
  - 2026-09-18-transcript-images-design
  - 2026-09-19-file-viewer-design
  - 2026-10-05-mobile-next-design
  - 2026-10-03-api-token-and-named-files-design
  - clickable-file-paths-in-the-transcript
  - media-from-subagents
  - why-orbital
tags:
  - images
  - transcripts
  - mobile
---
# Session media — every image and PDF of a session, in one place

The transcript already shows image attachments and tool screenshots as
thumbnails under their messages. It opens one image at a time in the 7c
lightbox, and image paths the agent writes are links. What is missing is a
way to see everything visual a session received or produced without scrolling
the transcript for it, like the "Media" view of a messenger chat.

The design is the Claude Design file `Feature - Media.dc.html`, artboards
24b–24i. This spec covers what the canvas does not settle: where the items
come from, the routes and the phone.

## What counts as media

An item is an image or a PDF from one of three sources:

| source | what it is | where the bytes live |
|---|---|---|
| `you` | an image the user attached or pasted (Orbital composer or the CLI) | image store, by `ref` |
| `tool` | an image block in a tool result (Playwright screenshots, `Read` of a `.png`, …) | image store, by `ref` |
| `agent` | an image or PDF path the agent wrote in the text of a reply | the file on disk, now |

- Only the main session's transcript. A subagent's own tool images do not
  reach it, and that is deliberate (idea [[media-from-subagents]]). When a
  subagent's screenshot matters, the main agent usually names its path in a
  reply, and that path is an `agent` item.
- A path counts as `agent` only in the **text of an assistant reply**,
  outside code blocks, by the same scan that makes it a link today. A path in
  a tool's input (`Write out/x.png`, `Read shot.png`) is not an `agent`
  item. `Read` of an image is already a `tool` item through its result block,
  and a `Write` the agent never mentions stays out, because it is the noisy
  case.
- Image extensions are the ones `pathLinks.ts` already treats as images.
  PDF (`.pdf`) is new. Code, markdown and every other text file are never
  media.
- The same path named twice in one reply is one item. Named again in a later
  reply, it is a second item: it belongs to both moments.
- Paths are resolved against the cwd the reply was written in (adr
  [[a-file-link-resolves-against-the-cwd-it-was-written-in]]). An absolute
  path outside the project (`/tmp/x.png`) is included, because the transcript
  naming it is exactly what `resolveForSession` already accepts.

## What the user sees

As drawn in 24b–24h, briefly:

- **Header readout ▦** next to the session's folder and branch. It is
  absent when the session has no media, and it carries no count. It opens
  a glance popover with the latest 8 tiles and **Open gallery** (⇧⌘M,
  matched on `e.code` so it works on Czech QWERTZ).
- **Gallery** (24d) takes over the panel body (Transcript ⇄ Media). It
  shows items newest first in a 3-column square-crop grid, with 5 columns in
  the detached window. Consecutive tool images from one tool run stack into
  one tile (⚙ ×n).
- **Hide tool images** is one per-session switch, kept in `localStorage`
  by session id. It applies to the popover, the gallery and paging.
- **Maximised view** (24e) is the 7c lightbox with ‹ › / ← → paging
  across the visible items, a filmstrip, and a caption with the source and
  time. **Show in transcript** closes it, shows the Transcript, scrolls to
  the message and fades a hairline on it once. PDFs show every page: ↑ ↓ or
  scroll moves through pages, ← → moves to the next item.
- **Reply thumbnails** (24f A): a reply that names images or PDFs gets one
  row of thumbnails under its text, in the order named and de-duplicated.
  The paths in the text stay links. Clicking any thumbnail in the transcript
  (attachment, tool or reply) opens the maximised view on that item, so the
  user can page on from there.
- **Gone files** (24f C): an `agent` item whose file is missing shows
  NO LONGER ON DISK at its footprint. A file that comes back simply shows
  again.

Calm (`docs/why-orbital.md`): nothing moves when an item arrives, there is no
"new" marker and no unread count.

### Where this departs from the canvas

- The canvas captions a gone file "named 14:24 · gone at 14:31". Knowing
  *when* it went would need Orbital to remember when it last saw the file,
  which is new persisted state for a caption. The caption is instead
  **"named 14:24 · not on disk now"**.
- "changed since 14:24" stays: the file's `mtime` is later than the
  reply's timestamp. No copy is kept.

## Data

### Path detection moves to `shared/`

`scanPaths`, the extension sets and `isImagePath` move from
`web/src/lib/pathLinks.ts` to `shared/`, with `isPdfPath` added. The rehype
plugin stays in `web/`. The server and the web must agree on which strings
are paths, or a thumbnail would appear under a reply that the gallery does
not list.

### `GET /api/sessions/:id/media`

The server builds the list from the parsed transcript it already caches for
paging (`transcriptMessages`), on the branch the messages route presents. It
does not persist anything new. `MediaItem` lives in `@orbital/shared/media`, so
the web and the phone read the same type. Per item:

```ts
type MediaItem = {
  id: string                 // stable: `${messageId}:${index}`
  kind: 'image' | 'pdf'
  source: 'you' | 'tool' | 'agent'
  messageId: string          // for Show in transcript
  ts: string                 // the message's timestamp
  ref?: string               // you/tool: image store ref
  path?: string; cwd?: string// agent: as named, and the cwd it resolves against
  w?: number; h?: number     // images, when known
  toolRun?: string           // tool: the tool_use id, for stacking
  disk?: 'present' | 'missing' | 'changed'  // agent only
}
```

- Image blocks inside assistant messages have no source and are left out;
  `agent` items are by path only.
- Oldest first on the wire. The web reverses it for the gallery.
- `disk` is read with one `stat` per `agent` item when the route answers.
  Nothing polls: the web asks again when the popover or the gallery opens,
  and when a new message arrives on the session's WS topic while either is
  open.
- PDF page counts are not computed on the server. pdf.js reports them when
  it opens the file.
- Pagination is not needed. The list carries references, not bytes, and a
  session with thousands of images is still a small JSON.

### Bytes of named files

`GET /api/files/image` keeps its path and also serves `application/pdf` (`IMAGE_FILE_CONTENT_TYPES` grows a
PDF entry), with the same `resolveForSession` / `readInSandboxes` bounds, the
same sandbox CSP and `nosniff`. Its size limit for PDFs is the text
preview's 10 MB.

### pdf.js

`pdfjs-dist` is loaded with a dynamic `import()` the first time a PDF is
shown, so the map's first paint does not pay for it. The worker is bundled by
Vite. First-page thumbnails are rendered at 2× the tile size and kept in an
in-memory LRU keyed by path + `mtime`.

### Show in transcript

The transcript is paged. When the target message is not in the loaded
window, the panel pages back until it is, then scrolls to it the way the
compaction badge's reveal does (`TranscriptView.tsx`, `data-compaction-id`),
with a `data-message-id` instead. If paging reaches the start without
finding it (the message was rewound away), the dialog closes and the
transcript stays where it was.

## Phone

**Built for the phone too**, as 24g draws it:

- **Entry:** first row of the existing ⋯ session sheet (10i), absent when
  there is no media.
- **Gallery:** a pushed screen with the same tiles, stacks and switch.
- **Viewer:** the existing phone `ImageViewer` (10d) pages through the
  media list instead of one message's images, and gains the source line
  and **Show in chat**.
- **PDF:** rendered on the phone with pdf.js. Pages scroll vertically and
  swipe ↔ moves to the next item. This replaces the "No preview on the
  phone" state (10e) for PDFs.

How it reaches the phone:

- `GET /api/sessions/:id/media` is added to `server/src/remote/allowlist.ts`.
- `FileAs` in `shared/src/remote/messages.ts` gains `'pdf'`, so `file_get`
  can return a PDF as bytes. `as: 'image'` refuses a PDF with 415 and
  `as: 'pdf'` refuses an image the same way. The limit is the desktop route's 10 MB, not the
  phone text preview's 512 KB. `ref` items already travel through
  `blob_get`.
- An older Mac answers `file_get` with `as: 'pdf'` by failing schema
  validation. The phone treats any non-200 answer as "can't show this here"
  (today's 10e state), so a new phone against an old Mac degrades instead of
  breaking. An old phone never sends `'pdf'`.
- The relay is blind to message contents and needs no change. Whether the
  `shared/` schema change still warrants a relay bump is decided when the
  versions are asked about.

This bumps the desktop (minor) and the phone app version (minor). No native
change, so no store build.

## Not in scope

Video, annotation, download/share, search, a cross-session media library,
media on the map, and media from subagents' own transcripts.

## Tests

- **Path detection** (`shared/`): PDF recognised; code and markdown never
  media; paths inside code blocks skipped; de-duplication within a reply;
  trailing punctuation.
- **Media list builder** (server, pure): the three sources from a fixture
  transcript; tool-run grouping by `tool_use` id; `agent` items only from
  assistant text, not from tool inputs; cwd carried per item; `disk`
  states against a temp directory.
- **Route** `GET /api/sessions/:id/media`: 404 for an unknown session,
  token required.
- **Bytes route**: a PDF inside the cwd is served as `application/pdf`; a
  PDF outside the cwd that the transcript does not name is 403; over the
  limit is 413.
- **Phone reader**: `as: 'pdf'` returns bytes within bounds and 403 outside,
  as the image case does.
- Paging and Show in transcript are verified by hand against the canvas,
  not pinned in tests.
