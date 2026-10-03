---
id: 2026-09-19-file-viewer-design
title: File viewer — pressable paths, file over the app
status: done
type: spec
domain: web
related:
  - clickable-file-paths-in-the-transcript
  - 2026-09-18-transcript-images-design
  - a-code-span-that-is-a-path-is-pressable
tags:
  - detail-panel
  - transcript
---
# File viewer — pressable paths, file over the app

Canvas: `Feature - File viewer.dc.html` (artboards 8a–8e; 8e carries the
exact metrics, colours and state table — treat it as the source of truth
for every value not repeated here). Scope is the whole of
[[clickable-file-paths-in-the-transcript]]'s preview target: pressable
paths in tool rows, in expanded INPUT values and in assistant prose, and
a read-only viewer over the app. "Open in editor" and "reveal in Finder"
stay with the Electron wrapper and are not part of this.

Reading, never editing. The viewer is a window, not a workspace. Content
is a snapshot of the moment it opened — no watch, no reload, no diff.

## Server

### `server/src/files/preview.ts`

`readFilePreview(cwd: string, rawPath: string): PreviewResult` — a pure
function over the filesystem, injected nowhere, testable with a tmpdir.

Resolution order, refusals first:

1. `expandHome(rawPath)` (the API-boundary rule,
   [[tilde-expands-at-the-api-boundary]]); a relative path resolves
   against `cwd`.
2. An empty `cwd` has no sandbox → `outside`.
3. `realpathSync` the candidate (symlinks resolved before any check).
   Missing file → `not_found`. The resolved path must sit under
   `realpathSync(cwd)` + separator → otherwise `outside`. Directories →
   `not_found`.
4. `stat.size > FILE_PREVIEW_MAX_BYTES` (10 MB) → `too_large` with the
   measured size, without reading the content.
5. Binary sniff: a NUL byte in the first 8 KB → `binary` with the size
   and a media type guessed from the extension (fallback `binary`).
   Sniffing, not extension, decides — a UTF-8 `.dat` opens (8d-D).
6. Otherwise `ok` with the content, size, `mtimeMs` and line count.

```ts
type PreviewResult =
  | { kind: 'ok'; content: string; size: number; mtimeMs: number; lines: number }
  | { kind: 'not_found' }
  | { kind: 'outside' }
  | { kind: 'too_large'; size: number }
  | { kind: 'binary'; size: number; mediaType: string }
```

### Route

`GET /api/files?session=<id>&path=<raw>` in `routes.ts`, next to the
images route, hand-validated like everything else there:

- missing/empty `session` or `path` → `400 { error: 'missing_params' }`
- unknown session id → `404 { error: 'not_found' }`
- then `readFilePreview(row.cwd, path)` mapped 1:1:
  `ok` → `200 { content, size, mtimeMs, lines }` ·
  `not_found` → `404 { error: 'not_found' }` ·
  `outside` → `403 { error: 'outside_cwd' }` ·
  `too_large` → `413 { error: 'too_large', size }` ·
  `binary` → `415 { error: 'binary', size, mediaType }`

The `:line` suffix never travels to the server — the client strips it
and keeps it for scrolling. No new `RouteContext` fields; the session
lookup is the same three-liner the revive route uses.

## Web

### Wire + state

- `api.filePreview(sessionId, path)` returns a discriminated union
  mirroring `PreviewResult`: it reads non-2xx bodies itself (403/404/
  413/415 are expected states carrying `size`/`mediaType`, not errors)
  instead of throwing through the shared `request` helper. Refusals are
  viewer states, never toasts; only a network-level failure surfaces as
  an error.
- URL: the viewer is part of the existing query-param scheme
  ([[selected-session-lives-in-the-url-query]] stays in force):
  `?session=<id>&file=<path>&line=42`. `sessionUrl.ts` grows the two
  params, `pushState` on open and close, `popstate` drives both ways,
  and a load with `file` present opens the viewer once sessions settle.
- Store: `ui.fileViewer: { path: string; line: number | null } | null`
  plus `openFile(path, line?)` / `closeFile()`. The viewer always
  belongs to the selected session. A path button whose file is the one
  currently open renders the OPEN state (8e) — dimmed, no underline
  emphasis, pressing it is a no-op.

### The pressable path — `PathButton`

One component used by all three sites. A real `<button>` in tab order
(⏎/space opens), `stopPropagation` on press, cursor `pointer`. Resting:
`#e8eef8` ink, dotted underline `rgba(150,205,255,.3)`, offset 2px, the
`:line` suffix in `.6` muted ink. Hover: pill `rgba(150,205,255,.12)`,
pad `1px 5px`, radius 4, negative margin `0 -5px` so row metrics hold,
ink `#f2f9ff`, solid underline `oklch(85% .12 205 / .8)`, transition
`.12s ease` (faster than the row's `.16s` — the smaller target answers
first). Active fill `.18`, focus ring `0 0 0 2px oklch(85% .12 205 / .55)`.
While the path is hovered or focused the row's own hover styling is
suppressed — the two targets never both look armed (8e "press vs.
toggle").

Where paths come from:

- **Tool rows.** `file_path` / `notebook_path` string inputs of the
  tools that carry them (the `FILE_PATH_TOOLS` set plus NotebookEdit).
  The collapsed label's path span becomes the button; the row's own
  click still expands and collapses, and pressing the path never
  toggles the row (8a). The collapsed row header becomes two sibling
  interactive elements — a nested `<button>` inside the expand button
  is invalid HTML.
- **Expanded INPUT.** The same fields' values inside the pretty-printed
  input render as `PathButton`s (8a's INPUT frame); everything else in
  the JSON stays text.
- **Assistant prose.** A rehype plugin over text nodes (skipping
  `pre` and existing `a`; inline `code` per the next item): a run of path characters with at
  least one `/` and a known text extension, optionally `:line` or
  `:line:col` (line kept, column ignored, both part of the hit area).
  False positives are cheap — the viewer refuses politely; false
  negatives are the expensive kind (8b's own copy).
- **Inline code spans** (added 2026-09-30,
  [[a-code-span-that-is-a-path-is-pressable]]): a span whose whole
  content is one such path becomes a path button inside the chip. A span
  where the path is only a part (`cat web/src/App.tsx`) stays text, as
  do fenced blocks.
- **Image paths** (added 2026-10-03): `.png`, `.jpg`, `.gif`, `.webp`,
  `.svg` and the rest of `IMAGE_EXTENSIONS` are pressable in every site
  above, but open the transcript images' Lightbox in place rather than
  this viewer — the viewer shows text, and an image named by a path is a
  file on disk, not an image block. The bytes come from
  `GET /api/files/image?session=&path=`, confined by the same
  `resolveInsideCwd` and size cap as the read below, typed by extension
  (`415 not_image` for anything else, so it never becomes a second text
  read), served `no-cache` and, for SVG, under a sandboxing CSP. Not on
  the mobile relay's allowlist. The lightbox is not part of the URL.
- **Not pressable:** known-binary extensions (`.woff2`, `.pdf`, `.zip`,
  …) stay text everywhere.

### The viewer — `web/src/panels/FileViewer.tsx`

Built on the Lightbox's infra: `useEscapeLayer` + `usePresence` +
`createPortal`, `role="dialog"`, backdrop `rgba(2,4,9,.82)` blur 6,
backdrop `.14s`, surface `.18s cubic-bezier(.2,.9,.25,1)` 98%→100%, no
slide; esc, ×, and backdrop click all close. Focus returns to the path
that opened it; the transcript never unmounts, so its scroll offset
holds (acceptance 8-3).

Surface: markdown 980×760, source 1040×780, both capped
`min(86vw, 1100px) × 86vh`, radius 14, border `rgba(150,205,255,.22)`,
shadow `0 40px 120px rgba(0,0,0,.7)`. Header (pad `16 18 14`): dim
directory + bright basename (14px mono), `:42` chip (accent `.12` fill,
`.4` border) only when a line target exists, meta line 10.5px mono
`size · lines · modified <relative> · language · line N of M`. Footer
(pad `10 18`): `esc` keycap · `closes · read-only snapshot` · right side
`opened from <source> · <session title> · <HH:MM opened>`.

Body:

- **Markdown** (`.md`/`.markdown`): the transcript's pipeline
  (`ReactMarkdown` + `remarkGfm` + the `Code`/`Pre` overrides) at
  reading size — 660px measure centred, 15px/1.75 body, 26px/700 h1,
  18px block gap, 34px top inset.
- **Source** (everything else): shiki per-line tokens (language from
  the extension, `highlight.ts`'s lazy loader), rendered as rows —
  56px gutter well `rgba(4,8,16,.4)` with right-aligned 11.5px numbers
  in `.32` ink, 18px left inset, 12.5px/22px body. Target line: wash
  `rgba(150,205,255,.07)` + inset 2px accent rail + number in
  `oklch(88% .1 205)`, scrolled so it sits at ⅓ of the body height, no
  flash, no pulse; wash and rail persist while the file is open. No
  line target → top of file, nothing highlighted.
- **Degrade tier:** over `HIGHLIGHT_MAX_BYTES` (1 MB) or
  `HIGHLIGHT_MAX_LINES` (20 000) the body is one plain escaped `<pre>`
  — no shiki, no ReactMarkdown, no per-line rows (numbers and line
  targets are what make big files expensive). The file still opens.
- **Loading:** header is real from the first frame (the path is known
  client-side, meta says `reading…`); the skeleton — four bars at the
  line rhythm, `.07` fill, 1.4s sweep staggered 100 ms — appears only
  after 120 ms (`LOADING_SKELETON_DELAY_MS`).
- **Refusals** share one frame (8d): centred 16px outline glyph, 10px
  tracked mono label, one 11px sentence, 10px gaps, neutral ink, no
  red, no retry. `OUTSIDE SESSION FOLDER` — "Orbital only reads inside
  <cwd>."; `NO LONGER ON DISK`; `TOO LARGE TO PREVIEW` — "<measured>
  over the <ceiling> ceiling."; `BINARY FILE` — "<mediaType> — nothing
  to read as text."

Text in the viewer selects; keystrokes do nothing.

## Deviations from the canvas

- **The ceiling is two-tier, not 2 MB.** Agreed in review: the limit
  protects the render path, not the server, so over 1 MB / 20 000 lines
  the viewer degrades to a plain `<pre>` instead of refusing, and only
  over `FILE_PREVIEW_MAX_BYTES` (10 MB) does it refuse. 8d-C's "6.4 MB
  refuses" example therefore opens (degraded) in the built version; the
  canvas's own `sizeCeilingMb` prop already ranges to 10.
- The refused-missing frame's "The agent read it at 14:02." sentence
  needs the opening row's timestamp, which prose-opened paths don't
  have; the sentence is omitted when no timestamp is at hand.
- `too_large` reports size only, not the canvas's line count — counting
  lines in a file refused for being ≥10 MB means reading it.

## Testing

- `preview.ts` (tmpdir fixtures): relative + absolute + tilde resolve;
  `..` and symlink escapes → `outside`; empty cwd → `outside`; missing
  file and directory → `not_found`; >10 MB → `too_large` with size (and
  without reading); NUL sniff → `binary` with media type; UTF-8 `.dat`
  → `ok`; line count.
- Route: param validation, unknown session, each kind's status code,
  no traversal shape reaches the fs.
- Path matcher (pure function): matches with/without `:line`/`:line:col`,
  requires slash + known extension, binary extensions refused.
- Web: `sessionUrl` round-trips `file`/`line`; store open/close;
  MessageView prose links (a code span only when it is exactly one
  path, never a fenced block); ToolRow — path
  press opens without expanding, row press expands without opening,
  INPUT values pressable; FileViewer — markdown vs source vs degrade
  by size and by lines, target line marked, each refusal state from its
  status code, esc closes, OPEN-state path button.
