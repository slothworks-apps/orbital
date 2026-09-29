---
id: the-composer-stays-a-textarea-for-markdown
title: Markdown in the composer rides the textarea and mirror, not CodeMirror
type: adr
status: superseded
domain: web
related:
  - 2026-09-29-composer-markdown-design
  - 2026-09-20-composer-design
  - composer-highlighting-and-completion
  - the-composer-becomes-a-tiptap-editor
tags:
  - detail-panel
---
# Markdown in the composer rides the textarea and mirror, not CodeMirror

Full markdown support in the composer could come two ways.

**CodeMirror 6 with its markdown mode.** It brings real bold and larger
headings, and list continuation comes built in. But it replaces the
field outright: the slash/mention completion, image paste, the Enter/⌘Enter
keymap, per-session drafts and the New Session dialog's field would all be
rebuilt on its API. The bundle would grow by roughly 150 kB.

**The existing textarea and mirror, with `remark` for parsing (chosen).**
`remark-parse` and `remark-gfm` already ship for the transcript. The mirror
only needs ranges to colour, and list editing is a few small pure functions.
Nothing that works today is rewritten.

The cost is that highlighting is colour only. The field is proportional
sans, and a weight or size change would pull the mirror out of line with the
caret. That is enough for the goal, which is to see the structure of a
prompt while writing it, not to preview its rendering.

The earlier [[composer-highlighting-and-completion]] idea ruled out
contenteditable for the same reason: Enter handling, paste and IME
composition stop being free.

> Superseded by [[the-composer-becomes-a-tiptap-editor]]: colouring was not the feature that was asked for.
