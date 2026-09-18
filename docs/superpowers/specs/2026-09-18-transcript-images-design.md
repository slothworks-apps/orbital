---
id: 2026-09-18-transcript-images-design
title: Transcript images — rendering half
status: done
type: spec
domain: web
related:
  - images-in-the-transcript-and-composer
tags:
  - detail-panel
  - transcript
---
# Transcript images — rendering half

Canvas: `Feature - Transcript images.dc.html` (artboards 7a–7d). Scope is
half 1 of [[images-in-the-transcript-and-composer]]: render the images that
already flow through sessions. The composer's paste/drop intake is half 2
and touches none of this except the store it will reuse.

Two bugs this fixes on the way: an `image` block is silently dropped by
both converters today, and a tool_result whose content is an array gets
`JSON.stringify`ed whole — megabytes of base64 in the message store and in
a `<pre>`.

## Image store (server)

`server/src/images/store.ts` — `createImageStore(dir)`, default dir
`join(CONFIG.dataDir, 'images')`.

- `put(mediaType, base64)` → `ImageRefEntry | null`. Entry:
  `{ ref: string; w: number | null; h: number | null; bytes: number }`.
- Content-addressed: `ref = <sha256-of-bytes>.<ext>`, ext from a media-type
  whitelist (`image/png|jpeg|gif|webp`). Write-if-absent — the same
  screenshot pasted twice is one file, and the route can honestly say
  `immutable`.
- Dimensions sniffed from the bytes (PNG IHDR, JPEG SOF scan, GIF header,
  WebP VP8/VP8L/VP8X) so the client can reserve the box before decode
  (7a acceptance: ±0 px layout shift). Unknown format details → `null`
  dims, the entry still stands.
- Unknown media type or undecodable base64 → `null`; the caller drops the
  block, which is today's behaviour.
- Cap in the errors-table spirit: writing past `IMAGE_STORE_MAX_BYTES`
  (512 MB — judgement call) prunes oldest-by-mtime until under. A pruned
  ref 404s; the web draws the placeholder.

## Wire shape

`ChatMessage.images?: ImageRefEntry[]` in `server/src/types.ts` and
`web/src/lib/types.ts`, mirrored field-for-field like `command`/`isError`.
Never bytes, never base64.

Both converters take the store as an optional trailing parameter —
`entriesToMessages(entries, images?)`, `sdkToChatMessages(msg, nextSeq,
images?)` — so tests can pass a fake and purity stays testable. Production
always passes the real one (routes' GET messages; `Runner` via its deps).

- A user-turn `image` block becomes its own message:
  `{ id, role: 'user', images: [entry] }`, no text.
- A tool_result whose `content` is an array: `text` = the text blocks
  joined with newlines, `images` = the image blocks' entries.
  `JSON.stringify` remains only as the fallback for an array carrying
  neither text nor image blocks.
- No store passed → image blocks drop (unchanged behaviour), but the
  tool_result text join above still applies.

## Route

`GET /api/images/:ref` — ref must match
`^[a-f0-9]{64}\.(png|jpg|gif|webp)$` (no traversal possible), content-type
from the extension, `Cache-Control: public, max-age=31536000, immutable`,
404 when the file is gone.

## Web

Types mirror, plus:

- **`ImageThumb`** (`web/src/panels/ImageThumb.tsx`) — a `<button>` wrapping
  `<img src="/api/images/<ref>" loading="lazy">`. The box is reserved from
  the stored `w`/`h` (aspect-ratio; height caps 120px user turn / 96px tool
  result, width cap 349px, two-up cap 171px — canvas 7d). Hover: border one
  step up + 3px accent halo, `.16s ease`, cursor `zoom-in`, no scale.
  Focus ring `oklch(85% .12 205 / .7)`. `onerror` (pruned ref) swaps to the
  NOT IN CACHE placeholder: same footprint, 14px outline glyph, mono label,
  not clickable — housekeeping, not an error (7b-B).
- **User turns** (`MessageView`): image-only turn — the thumbnail IS the
  bubble: right-aligned, radius `12 12 4 12`, tag-hue border
  `oklch(80% .13 210 / .3)`. Text + image — the image sits 8px under the
  bubble, right edge aligned, neutral border `rgba(150,205,255,.18)`,
  radius 8. Two or more — one wrapping row, 6px gap. No empty bubble, no
  caption, no filename row.
- **Tool results** (`ToolRow`): an image result renders as the row's body,
  exactly like a `<pre>` output block — same 7px shell, hairline divider,
  8/10px body padding; thumb 96px, radius 6, border `rgba(150,205,255,.12)`,
  with a mono readout beside it (10.5px): dimensions · size. Folding rules
  unchanged — images never force a run open.
- **`ui/Lightbox`** — new, built on the same `useEscapeLayer` +
  `usePresence` + `createPortal` infra as `Dialog`. `Dialog` itself is
  form-dialog chrome (fixed widths, ruled header) and the canvas draws a
  bare lightbox, so reusing the component literally would fight 7c; the
  idea doc's real point — overlay, Escape ranking, focus return — lives in
  the shared infra, and that is what is reused. Chrome per 7c: backdrop
  `rgba(2,4,9,.82)` + blur 6, image `min(85vw aspect-fit, 85vh, natural)`
  (never upscaled), radius 12, border `rgba(150,205,255,.22)`, one mono
  caption line (source · dimensions · size · esc hint), × top-right.
  Backdrop fade `.14s`, image `.18s cubic-bezier(.2,.9,.25,1)` 98%→100%.
  No zoom, no pan, no gallery arrows.

## Deviations from the canvas

- The tool-result readout shows dimensions · size only. The canvas's
  filename and context lines (`step-2.png`, `viewport 390 · onboarding/2`)
  need data an image block does not carry.
- Caption sources: `pasted image` for user turns, the tool name for
  results; the canvas's `Clipboard image` / `Dropped file` distinction
  arrives with half 2, which is where it becomes knowable.
- Per-row durations in 7b's mock belong to the folding spec's out-of-scope
  list, not here.
- The "thumbnails downscaled and cached at 2×" note is not implemented —
  the browser's decoder handles thumbnail-size paints; revisit only if a
  long transcript full of screenshots measurably janks.

## Testing

- Store: ref shape and idempotence (same bytes → same ref, one file),
  dimension sniffing per format, unknown media type → null, cap prunes
  oldest first.
- Parser + runner: user image block → `images` message with no base64
  anywhere; tool_result array → joined text + refs, stringify fallback
  intact; no store → image blocks drop.
- Routes: ref validation (traversal shapes 404/400), content-type,
  immutable header, 404 on missing file.
- Web: ImageThumb renders the route URL and reserved box; error state
  swaps to placeholder and stops being a button; MessageView image-only
  turn has no bubble; ToolRow image body renders; Lightbox opens on click,
  closes on Escape.
