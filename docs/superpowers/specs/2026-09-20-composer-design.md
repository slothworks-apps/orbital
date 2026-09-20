---
id: 2026-09-20-composer-design
title: Composer — highlighting, completion, image intake
status: done
type: spec
domain: web
related:
  - composer-highlighting-and-completion
  - images-in-the-transcript-and-composer
  - 2026-09-18-transcript-images-design
  - 2026-09-19-file-viewer-design
tags:
  - detail-panel
  - shortcuts
---
# Composer — highlighting, completion, image intake

Canvas: `Feature - Composer.dc.html` (artboards 9a–9e; 9e carries the
metrics/colour/state tables — the source of truth for every value not
repeated here). Scope is the whole of
[[composer-highlighting-and-completion]] plus half 2 of
[[images-in-the-transcript-and-composer]] (composer intake).

One control, two homes: the reply composer in `DetailPanel` and the
New Session dialog's FIRST PROMPT field are the same component with the
same behaviour. The composer's accent throughout is `oklch(85% .12 205)`
(the panel-interaction accent, not the brand `oklch(80% .13 210)`).

Out of scope (canvas SCOPE): argument hints inside a command, markdown
preview, code-block highlighting in the prompt, bash `!` mode,
fuzzy/subsequence matching (prefix only), recents/usage ranking,
mouse-hover preselect, non-image attachments, capture/cropping/reorder,
composing from the main view, any setting.

## Server

### Command catalog — hybrid SDK + filesystem

Two sources, one route:

- **`server/src/commands/catalog.ts`** — `collectCommands({ claudeDir,
  cwd })`: filesystem scan returning `{ name, description, source }[]`.
  Sources: user `~/.claude/commands/*.md` (flat, frontmatter optional)
  and `~/.claude/skills/*/SKILL.md` (name = directory; the nested
  `skills/synced/<uuid>/<skill>/SKILL.md` level is handled, `synced`
  itself is never listed); project `.claude/{commands,skills}` under
  `cwd`; plugins = `plugins/installed_plugins.json` ∩ `settings.json`
  `enabledPlugins`, reading `<installPath>/skills/*/SKILL.md` and
  `<installPath>/commands/*.md`, names `plugin:skill`. The
  `~/.claude/agents` namespace is excluded. Injectable roots for tests.
- **Runner** keeps each session's live query handle and exposes
  `commands(sessionId): Promise<SlashCommand[]> | null` — backed by the
  SDK's `query.supportedCommands()` (cache the result per session;
  replace the cache when the SDK's slash-commands push event is seen in
  the pump, if it surfaces there). Null when the session has no live
  query.

`GET /api/commands?session=<id>` (or `?cwd=<dir>` — the dialog has no
session yet; `expandHome` applies): with a live query, the SDK list is
the truth and the fs scan only attributes `source` by name match —
anything unmatched is `source: 'built-in'`; without one, the fs scan
alone is the answer (no built-ins — offering a command the CLI may not
honour is worse than omitting it). Response: `{ commands: [{ name,
description, source }] }`, sorted by name; `source` is one string —
`'user' | 'project' | 'built-in' | 'plugin:<name>'`. Names carry no
leading slash (the SDK's own spelling; the merge matches on it), a
skill is named by its directory, collisions dedupe with the CLI's
precedence (project shadows user shadows plugin), and an empty SDK
description falls back to the scanned one. The SDK's
`commands_changed` push replaces the per-session cache as it arrives. The `?cwd=` form is no wider
a surface than `POST /api/sessions`, which already accepts an arbitrary
cwd; [[api-token-guards-the-local-port]] is the umbrella fix.

### Path completion — `GET /api/files/complete`

`?session=<id>|?cwd=<dir>` plus `&prefix=<typed>`. Split the prefix
into directory + base; resolve and confine the directory exactly like
`readFilePreview` (the realpath confinement moves to a shared helper in
`server/src/files/`); readdir, keep entries whose name starts with the
base (dotfiles only when the base starts with `.`), directories first
then files, alphabetical, capped at `FILE_COMPLETE_MAX = 50`. Entries:
`{ name, dir: boolean, size?: number }`. Outside the sandbox or a
missing directory → `{ entries: [] }`, never an error.

### Attachments — `POST /api/sessions/:id/attachments` and `POST /api/attachments`

Multipart (`@fastify/multipart`, new dependency), one file per request.
The sessionless route exists because the dialog uploads before its
session does — Launch is where the refs first travel — and the session
check guards nothing anyway: the store is content-addressed and
global, an upload is a capped write-only put. One shared handler, two
mounts.
The image store grows `putBytes(mediaType, buffer)` (which `put`
delegates to) and `read(ref): { mediaType, base64 } | null`. Media type
whitelist is the store's own (png/jpeg/gif/webp — the refusal is
`putBytes` returning null, never a second list in routes.ts) → `415 {
error: 'not_image', mediaType }`; `ATTACHMENT_MAX_BYTES` = 5 MB → `413
{ error: 'too_large', size }`, where `size` is exact up to twice the
ceiling and flagged `truncated: true` beyond (reporting a real size
means reading the file; the route stops at a 2× wall rather than
report a truncated length as exact). A zero-byte file is `400
empty_file`. Success: `201` with the `ImageRefEntry`. Unknown session
404.

### Send path

`POST /api/sessions/:id/messages` body grows `attachments?: string[]`
(refs, each validated against the images-route regex; invalid → 400).
`Runner.send(id, text, attachments?)` and `Runner.start({ ...,
attachments? })` (dialog + revive) pass them to `userMessage`, which
builds the content array: one image block per ref — `{ type: 'image',
source: { type: 'base64', media_type, data } }` via `images.read(ref)`
(a pruned ref is skipped silently) — then the text block only when text
is non-empty. "An empty prompt enqueues nothing" becomes "empty prompt
*and no attachments* enqueues nothing". Base64 exists on exactly this
one hop, as decided in the idea doc.

## Web

### The component — `web/src/panels/Composer.tsx`

Extracted from `DetailPanel`, mounted there and in `NewSessionDialog`.
Differences between mounts are exactly three (canvas 9d): ⏎ sends in
the panel / newlines in the dialog (⌘⏎ launches; the popup owns ⏎
while open in both); the popup opens above in the panel / below in the
dialog (8px gap, width = the well's); the drop target is the panel /
the dialog surface. Hint copy: `⏎ send · ⇧⏎ newline · ⌘V paste image`
vs `⏎ newline · ⌘⏎ start session · ⌘V paste image`.

The well keeps today's chrome (10px radius, `.18` border,
`rgba(4,8,16,.6)` fill) and gains the focus state from 9a: border
`oklch(85% .12 205 / .5)` + `0 0 0 3px` accent `.1` glow.

### Highlighting — mirrored layer

The textarea's text goes transparent (caret keeps the accent colour);
an `aria-hidden` div behind it renders the same text with token spans,
both sharing font, size, line-height, padding and wrapping. Tokens
(9a/9e): command slug — filled `rgba(150,205,255,.13)`, ink `#f2f9ff`,
only at position 0 of the field; mention — `.06` fill + `inset 0 0 0
1px rgba(150,205,255,.18)` ring, ink `#dfeeff`, `:line` suffix in
muted `.6`; both padding `1px 5px` cancelled by `0 -2px` margins,
radius 4px, applied with **no transition** (0 ms). Neither token takes
hover, cursor change or focus ring — the tint says "parsed", never
"press". `/co` mid-sentence is prose. An unrecognised command stays
plain ink; the hint line carries one muted sentence (`no command
/comand — sends as typed`) in the NOT IN CACHE voice.

Tokenizer is a pure exported function (`web/src/lib/composerTokens.ts`)
over `(text, knownCommands)`. Command tint = exact catalog match at
position 0. Mention tint is the receipt for a *resolved* name: applied
on popup accept, or once a hand-typed complete path is confirmed via a
debounced `files/complete` probe.

**Deviation from the canvas:** token glyphs stay in the field's own
font (sans 13.5/1.62), not mono — a mirrored textarea cannot keep caret
alignment across a font change, and the canvas's own rule ("fill versus
ring, not colour") carries the two kinds without it.

### Completion popup

The portal/flip/reposition mechanics extract from `ui/Select` into a
shared hook (`usePopupPosition`); Select's behaviour must not change
(its tests guard it). The popup itself is new (`CompletionPopup`):
focus stays in the textarea (`aria-activedescendant` wiring, listbox
rows `role="option"`); opens on `/` at position 0 and `@` anywhere,
within one frame; prefix-filters as you type (rows swap instantly,
selection resets to row 0); ↑↓ move and **wrap at both ends**; ⏎/Tab
accept — replacing the typed fragment and adding one trailing space;
Esc closes the popup only (escape layer — a second Esc is the panel's);
⌫ past the `/`/`@` closes; no match closes rather than showing an empty
shell. 6 rows × 40px then scroll (`auto`, never smooth). Open `.12s
cubic-bezier(.2,.9,.25,1)` with a 4px rise, close `.09s ease`.

Rows per 9b: commands — name (mono 12) + description (10.5/1.35) +
source badge (mono 9, right: `project .claude` / `user ~/.claude` /
`plugin: <name>` / `built-in`); files — dir/file mark, name, parent
folder, size or `DIR · N ITEMS`, directories first with an accent `/`.
Accepting a directory inserts it and keeps the popup open, now listing
inside it — the only case ⏎ does not close. Selected row:
`rgba(150,205,255,.14)` fill, inset 2px accent rail, ✓. Header and
footer rails per 9b.

Sources: commands from `api.commands(sessionKey)` fetched on popup
open (sessionKey = session id in the panel, cwd in the dialog); files
from `api.filesComplete(sessionKey, prefix)` per keystroke, debounced.

### Image intake

- **Paste**: `clipboardData.files` images on ⌘V.
- **Drop** (9c): `dragenter` with image files arms the drop state —
  panel/dialog border accent `.45` + inset ring `.12`, transcript dims
  to `.35`, the well becomes the marker (2px dashed accent `.5`, `.07`
  fill, 96px, 1.2s pulse, `DROP TO ATTACH` + accepted types/ceiling);
  80ms leave-grace so crossing children never flickers; a drag with no
  image files never arms. Typed text is kept under the marker.
- **Client pre-check** mirrors the server facts (type whitelist, 5 MB)
  and refuses without uploading: the refusal is one mono line replacing
  the hint line in place (in `.16s`, holds 4s, out `.2s`), naming the
  measured fact (`capture.png · 12.4 MB over the 5 MB ceiling` /
  `application/pdf — mention the path instead`); multiple refusals in
  one drop collapse (`2 files weren't images`), never stack. No chip is
  created.
- **Upload**: raw `fetch` + `FormData` (the JSON `request` helper
  cannot carry it) to the attachments route, one per file,
  AbortController per chip.
- **Chips** (9c/9d): in the well above the text — 48px, radius 8,
  `.16` border on `.05` fill, 36px thumb (local `createObjectURL`
  preview at once), name mono 11 (`Clipboard image` for pastes — never
  a fake filename — or the dropped file's name), meta mono 9.5, × 18px.
  Uploading: thumb at `.5`, `uploading N %` where the size sits, 2px
  progress rail (accent `.7` on `.1`, width `.2s linear`; under 200ms
  total the rail never appears). Failed: fill `.03`, thumb `.45`,
  `didn't upload`, a small bordered `retry` left of × — the one retry
  in Orbital; after two failed retries the word goes away, the chip
  stays removable. Ceiling `MAX_ATTACHMENTS = 6`; chip enter `.14s`
  (opacity + 98%→100%), × exit `.1s` opacity, send removes with no
  animation.
- **Send** stays live during uploads: a send with pending uploads waits
  for them (the queued turn fires when the last settles; a failed chip
  blocks nothing — it simply isn't included until retried). Send is
  enabled when there is text *or* at least one chip that is uploaded
  or still uploading (a failed chip alone does not arm it). Text and
  chips clear together; the hint line returns to its resting copy.
- **Launch** is the same rule in the dialog, one step stricter: the
  refs travel in the launch request itself, so Launch stays live during
  uploads and then WAITS for them (`takeForSend()` empties the well in
  the same frame, the request goes out when the last upload settles).
  Closing the dialog drops the chips and aborts what was still
  uploading; chips a launch already took are unaffected. The footer
  summary counts them, ahead of the session's shape — `1 image ·
  Sonnet 4.5 · acceptEdits · WORK` (9d-D shows `1 image · spawns a new
  planet in WORK`; the count is prepended to 4b's existing caption
  rather than replacing it).

### Store + wire

- `api.commands(sessionOrCwd)`, `api.filesComplete(sessionOrCwd,
  prefix)`, `api.uploadAttachment(sessionId | null, file)` (raw fetch;
  `null` is the dialog and picks the sessionless route —
  [[attachments-upload-without-a-session]]),
  `api.sendMessage(id, text, attachments?)`.
- `sendPrompt(id, text, attachments?)` — the optimistic message
  carries `images` (the uploaded entries) plus local-only provenance
  `{ name, source }` per image; WS dedup extends its match to image
  refs (same bytes → same sha) and the replacement keeps the local
  captions. `launchSession` body grows `attachments`.

### The transcript side

- **Captions** (9c): a user turn's thumbnails gain a 9px mono caption
  underneath (`Clipboard image · 284 KB` / `after-390.png · 196 KB`)
  when provenance is known — i.e. on the optimistic message and its
  WS replacement in the same client. History reloads have no
  provenance (an SDK image block carries none) and render captionless,
  exactly as today. ImageThumb's existing geometry is unchanged — 9c's
  165×107 mock is one sample's aspect fit, not a new cap.
- **Sent tint holds** (9e SENT): `MessageView` user turns tint a
  position-0 command (`.08` fill, ink `rgba(220,235,255,.85)`) and
  mentions (hairline) — display-only, no validation, not pressable.

## Deviations from the canvas

- Token glyphs in the field's font, not mono (mirror/caret constraint;
  see Highlighting).
- `ATTACHMENT_MAX_BYTES` is 5 MB, not 10 — the Anthropic API caps an
  image source at ~5 MB, so a 9 MB upload would fail a turn later in
  the SDK; refusing at intake is the honest server fact.
- Built-in commands appear only for sessions with a live SDK query
  (`supportedCommands()` is the CLI's own list); ended/terminal
  sessions and the dialog get the filesystem catalog without them.
- The two-up sent thumbnail keeps transcript images' geometry;
  only the caption line is new.

## Testing

- Catalog: fs scan over fake roots (user/project/plugin/synced
  nesting, missing dirs), source attribution + built-in fallback when
  merged with an SDK list; route with `session` vs `cwd`.
- Files complete: prefix split, confinement (outside → empty),
  dotfiles rule, dirs-first order, cap.
- Attachments route: multipart happy path, 413/415, unknown session;
  the sessionless route's own happy path and one refusal, proving the
  shared handler; store `putBytes`/`read` round-trip.
- Runner: content array — images before text, text-only, image-only,
  empty-both enqueues nothing; revive and start carry attachments;
  pruned ref skipped.
- Web: tokenizer table (position-0 rule, unknown command, mentions,
  `:line`); mirror renders tokens without shifting metrics (assert
  same text content + span classes, not pixels); popup — open/filter/
  wrap/accept/Tab/Esc-depth/⌫-close/no-match-close/directory-continues;
  paste and drop via the `makeDataTransfer` pattern (folder never
  arms); chip states incl. retry cap; refusal line collapse; send
  waits for uploads; sendPrompt optimistic images + dedup by ref;
  dialog mount (⏎ newline, ⌘⏎ launch, popup below, footer count,
  paste→chip→launch carries the refs, the DIALOG arms and the scrim
  does not, refusal in place of the dialog hint, a launch waits for an
  upload in flight, closing drops the chips);
  MessageView captions + sent tint.
