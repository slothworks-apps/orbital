---
id: 2026-10-23-phone-text-preview-design
title: Phone text preview — source in colour, markdown as a document
type: spec
status: done
domain: remote
related:
  - 2026-10-05-mobile-next-design
  - 2026-09-19-file-viewer-design
tags:
  - mobile
  - files
  - markdown
---
# Phone text preview — source in colour, markdown as a document

The phone's text preview (canvas 10d, third phone) shows every file as
monochrome numbered rows. The desktop file viewer already highlights source
(8c) and renders markdown (8b). This brings both to the phone.

Design: Claude Design, `Feature - Phone text preview.dc.html`, artboards
10d·a–d (the four phones) and 10d·e (the parts).

## Scope

- **For:** anyone who reads, on the phone, a file a session named — mostly
  the plans, specs and notes an agent writes as markdown.
- **Where it lives:** on by default. It replaces the monochrome rows; there
  is nothing beside it to keep.
- **What someone notices after updating:** source files are in colour; a
  `.md` opens as a formatted document with a two-segment switch in the
  header to see its source.
- **What can be set:** nothing persistent. Wrap and the Rendered/Source mode
  live as long as the preview is open.

## Behaviour

1. **Source in colour.** Rows are tokenized with the same shiki highlighter
   and theme as the desktop source view (`tokenizeCode`, `languageFromPath`).
   Plain rows render at once and the colours swap in when shiki lands. A
   file longer than `PHONE_HIGHLIGHT_MAX_LINES` stays plain: tokenizing
   blocks the main thread, and a phone is slower than the Mac.
2. **Markdown opens Rendered.** react-markdown with remark-gfm, the same
   pipeline as the transcript, at the 10d·e "Rendered — sized for 390"
   values. Fenced code is highlighted and scrolls inside its own box; a table
   scrolls inside its frame; the page never scrolls sideways. Task boxes are
   read-only.
3. **The switch.** `Aa` / `</>` in the header row, markdown only. The choice
   is not remembered. Switching keeps the place: the top visible block maps
   to its first source line, and back.
4. **A line opens Source.** A `.md` opened with a `:line` opens in Source,
   that line placed ⅓ down and marked as 8e. The same applies to a link
   inside the document that carries a line.
5. **Wrap only in Source.** In Rendered the Wrap button is removed, not
   disabled (a dimmed control on the phone means "needs the Mac").
6. **Links.** A link to a web address opens outside Orbital. A relative link
   is read against the markdown file's own directory and opens the phone's
   file screen for that path (an image opens the image viewer). A link to the
   same file with a line switches to Source on that line. Images inside the
   markdown appear as a tappable path, not inline.
7. **Copying.** Line numbers are drawn by CSS, so a selection never carries
   them.

## The phone

This feature is the phone. It uses only what the preview already fetches,
so it needs no route, no `MAC_FEATURES` gate, and works against any Mac.
It ships over the air; the native shell does not change.

## Out of scope

Raw HTML blocks (shown as text), footnotes, math, diagrams, find, editing.

## Deviation from the canvas

10d·e lists a seven-hue palette as "the same as 8c". 8c as built uses shiki's
`github-dark-default` tokens, and the phone uses the same highlighter, so
the phone and the desktop match each other rather than the canvas swatches.
