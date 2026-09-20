---
id: images-in-the-transcript-and-composer
title: Show images in the transcript, with a full-size preview, and let the composer take them
status: done
type: idea
domain: web
related:
  - clickable-file-paths-in-the-transcript
tags:
  - detail-panel
  - transcript
---
# Show images in the transcript, with a full-size preview, and let the composer take them

An image pasted into a session should appear in the transcript as a thumbnail,
and open at full size in a dialog. Today none of that exists — and it is worse
than merely missing.

## What happens now

Both converters handle exactly `text`, `tool_use` and `tool_result`:
`sdkToChatMessages` for live messages (`server/src/runner/runner.ts`) and
`entriesToMessages` for history (`server/src/transcript/parser.ts`). An
`image` block matches none of those branches and is **silently dropped**, so a
screenshot pasted into a terminal session simply is not in Orbital's transcript.

And a tool that *returns* an image is worse than dropped. Both converters do:

```ts
text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
```

so the image's whole base64 payload becomes the row's text, which `ToolRow`
then prints into a `<pre>`. That is megabytes of base64 in the store and on
screen. Fixing it is part of this work, not a separate errand.

The composer, meanwhile, sends a string end to end: `sendPrompt(id, text)` →
`POST /api/sessions/:id/messages` → `Runner.send()` → `userMessage()`, which
builds `content: [{ type: 'text', text }]`. There is nowhere for an attachment
to ride.

> Half 1 (rendering) shipped 2026-09-18 — see
> [[2026-09-18-transcript-images-design]]. Half 2 (composer intake)
> shipped 2026-09-20 with [[2026-09-20-composer-design]]: paste + drop
> in both fields, multipart attachments routes (session-scoped and
> sessionless — [[attachments-upload-without-a-session]]), refs on the
> message, image blocks built server-side.

## Two halves, and the first stands alone

1. **Render what is already there.** `ChatMessage` grows an image kind, both
   converters keep `image` blocks instead of dropping or stringifying them,
   `MessageView` and `ToolRow` draw a thumbnail, and clicking it opens the
   full size. No change to the send path at all, and it immediately fixes the
   base64-in-a-`<pre>` case.
2. **Take images in.** Paste (`clipboardData.files`) and drop on the composer;
   the POST body carries attachments beside the text; `userMessage()` builds a
   content array rather than a single text block.

## Where the bytes live — decided

**Orbital's own wire carries a reference; the bytes are served over HTTP.**
Base64 exists at exactly one hop, server → SDK, where it is unavoidable.

The mechanism, in both directions:

- A **content-addressed store** under `CONFIG.dataDir`: `images/<sha256>.<ext>`,
  written once, idempotent. The hash *is* the id, so the same screenshot
  pasted twice — or an image a tool read three times — is one file, and the
  route can answer `Cache-Control: immutable` honestly.
- **Outbound.** When a converter meets an image block it decodes it into that
  store and emits `{ kind: 'image', ref }` — never the data. The browser
  renders a plain `<img src="/api/images/<ref>">`, which buys lazy loading,
  HTTP caching and off-heap decoding for free, and costs the store nothing.
- **Inbound.** The composer POSTs the file itself (multipart, not base64 in
  JSON) to an attachments route that returns its hash; the message then
  carries `attachments: [hash]`, and `userMessage()` builds the image block
  server-side by reading that one file.

Why this and not base64 on the wire: Orbital re-reads transcripts constantly —
the indexer scans them, the watcher tails them, `GET /messages` parses them —
so a multi-megabyte line is a cost paid over and over, on every history page
and every WS reconnect, in a store that already holds 200 messages per
session. A ref is a few dozen bytes and never grows.

Two honest limits of the decision. What the **CLI** writes into its own
`.jsonl` is not Orbital's to control — a pasted image lands there as base64
either way; this keeps it out of Orbital's wire, store and renderer, which is
the part we own. And the image store needs a cap in the same spirit as the
errors table's newest-1000 guard, or it grows forever.

It also lands where other work is already going: the same route generalises to
the file viewer in [[clickable-file-paths-in-the-transcript]], and a light
wire is what the claude.ai bridge would want if sessions are ever mirrored.
## Two smaller calls

- **The dialog is `ui/Dialog`.** The overlay, Escape ranking and focus return
  are already solved by it and the escape layer — a bespoke lightbox would
  re-solve all three worse. Note that page zoom is disabled app-wide
  (`web/CLAUDE.md`), so if the big preview ever needs zoom it must do it
  itself; out of scope for a first pass.
- **The canvas has nothing to transcribe.** No artboard shows an image in the
  transcript, so the thumbnail frame and the dialog chrome are judgement calls
  and should be marked as such in the code.
