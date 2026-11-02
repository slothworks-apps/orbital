---
id: a-code-span-that-is-a-path-is-pressable
title: An inline code span that is exactly one path is pressable
status: in-force
type: adr
domain: web
related:
  - 2026-09-19-file-viewer-design
  - clickable-file-paths-in-the-transcript
  - 2026-11-02-bare-file-names-and-path-menu-design
tags:
  - transcript
  - detail-panel
---
# An inline code span that is exactly one path is pressable

## The problem

The file viewer spec made paths in assistant prose pressable but skipped
everything inside `code`, on the grounds that code is quoted material. In
practice the assistant writes almost every path it reports as an inline code
span — `` `docs/decisions/x.md` ``, `` `web/src/App.tsx:42` `` — so the rule
left exactly the paths people want to open as inert text. The prose matcher
was catching the rare bare path and missing the common one.

## The decision

An inline code span becomes a path button when its whole content, trimmed,
is one path match (same matcher as prose: a slash, a whitelisted text
extension, an optional `:line[:col]`). The link goes *inside* the `code`
element, so the chip keeps its look and the button adds the path's usual
underline and hover.

A span whose whole content is one **bare file name** — no `/`, an extension
a press can open, an optional `:line[:col]`: `` `findAll.ts` ``,
`` `findAll.ts:42` `` — is pressable too (spec
`2026-11-02-bare-file-names-and-path-menu-design`). Its link is marked bare,
and where it points is decided only when it is pressed: the server looks the
name up in the session's trees, one match opens, several open a chooser, none
says so. A Mac without the lookup opens the name as written.

Still text:

- a bare name in running prose. `Node.js`, `Next.js`, `Vue.js` carry an
  extension the matcher accepts and would be underlined in every sentence
  about them; in prose a path still needs a `/`. The assistant writes file
  names in code spans almost always, so the span alone catches the case that
  matters, and a span is already the author saying "this is a literal".
- a span where the path is only a part — `` `cat web/src/App.tsx` ``,
  `` `web/a.ts web/b.ts` ``. That is a command or a list, genuinely quoted;
  picking a path out of it would make half a chip pressable.
- fenced blocks (`pre`), whatever they hold.

## What was ruled out

- **Checking at render time that a bare name exists**, or keeping a file
  index per tree on the web. A bare name means nothing until it is resolved,
  but resolving every one in every message rendered would cost a listing per
  message and memory per repository; a press is rare, so it resolves there.

- **Checking that a path exists before linking.** It would cost a route
  and a round trip per message, and a file deleted since would silently
  stop being a link in an old transcript. The viewer already refuses a
  missing file politely, which is the same bargain prose paths made: false
  positives are cheap, false negatives are the expensive kind.
- **Matching paths anywhere inside a code span**, like prose does. It would
  catch commands too, and a code chip with one pressable word in the middle
  reads as broken rather than as a link.

## Consequences

The canvas (`Feature - File viewer.dc.html`, 8a–8e) draws prose, row and
input paths but not a path inside a code chip; the `code` variant of
`PathButton` takes only the ink and a hit pad that fits the chip's padding,
and leaves the rest to the chip. If Claude Design draws this case, the
variant follows the artboard.
