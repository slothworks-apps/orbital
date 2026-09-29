---
id: 2026-09-29-composer-markdown-design
title: Composer — markdown highlighting and list editing
status: superseded
type: spec
domain: web
related:
  - 2026-09-20-composer-design
  - one-syntax-palette-for-all-code
  - the-composer-stays-a-textarea-for-markdown
tags:
  - detail-panel
---
# Composer — markdown highlighting and list editing

A prompt is markdown already: the composer sends what is typed, and the agent
reads markdown well. What the composer lacks is any sign of the structure
while you type it. A list is grey prose until it lands in the transcript, and
every bullet and number is typed by hand. The goal is a better view of the
prompt being written, not a rich-text editor.

The field stays the `<textarea>` over an `aria-hidden` mirror
(see [[the-composer-stays-a-textarea-for-markdown]] for why).

## Highlighting

- A pure function in `web/src/lib/composerMarkdown.ts` parses the text with
  `remark-parse` + `remark-gfm`, the same grammar `react-markdown` renders
  the transcript with, so the composer recognises exactly what the message
  will show. It returns styled ranges (`start`, `end`, style) from node
  positions.
- Recognised: list markers (`-`, `*`, `+`, `1.`, `1)`, and the task box
  `[ ]`/`[x]`), ATX headings, strong, emphasis, strikethrough, inline code,
  fenced and indented code blocks, links, and the blockquote marker `>`.
- **Colour only.** The field is proportional sans. Bold, italic or a larger
  size changes glyph widths, and the mirror then no longer lines up with the
  caret (composer spec, "How the highlight stays in lockstep"). The one
  exception is `line-through` on strikethrough, which does not change widths.
- Colours come from the syntax palette the transcript's code already uses
  ([[one-syntax-palette-for-all-code]]), so the composer matches the
  transcript's colours.
- The command and mention tokens keep their treatment and win where they
  overlap a markdown range. Markdown colouring nests inside plain text runs
  only.
- Parsing runs on every change. Prompts are short; if a measured cost shows
  up, memoise on the text, as the tokens already are.

## List editing

Pure functions in `web/src/lib/composerLists.ts`. They take the text and the
selection and return the edit to apply, or `null` when the key is not theirs.

- **Newline on a list line.** This is the composer's newline key: Shift+Enter
  in the panel (`composer.newline`), and Enter in the dialog, where Enter is
  the newline. It continues the construct at the same indent: `- ` → `- `,
  `3. ` → `4. `, `1) ` → `2) `, `- [x] ` → `- [ ] `, `> ` → `> `. A caret
  in the middle of an item splits it, and the tail moves into the new item.
- **Newline on an empty item** (marker only) removes the marker and ends the
  list. It does not insert a line.
- **Tab / Shift+Tab on a list line** indents or outdents the item by one
  nesting level (the marker's content offset, as CommonMark nests). Off a
  list line, Tab keeps its default behaviour.
- The completion popup keeps first refusal on every key, Tab included.
- Edits go through `document.execCommand('insertText')` (with the
  selection set first), so ⌘Z undoes an inserted marker like typing.
  Setting `value` would wipe the native undo stack.
- Renumbering the rest of a list after an insert is out of scope. Markdown
  renders `1. 1. 1.` correctly anyway.

## Testing

Pure functions only: list continuation, termination, numbering, task items,
quotes, indent and outdent, mid-line splits; highlight ranges for each
construct, and that a `/command` or `@mention` inside markdown keeps its
token. No styling tests.

## Deviations

- **Strong and emphasis show only through their delimiters.** The palette
  (`github-dark-default`) paints `markup.bold` and `markup.italic` in the
  foreground ink and lets weight and slant carry them, and the mirror can
  carry neither. So `**`, `_`, `~~`, backticks, code fences and a link's
  brackets and destination are dimmed to the theme's `comment` grey, and the
  words stay prose ink. The other slots take the theme's own markdown
  scopes: list markers and task boxes `#ffa657`, the quote `>` `#7ee787`,
  headings and code `#79c0ff`, link text `#a5d6ff` (`MARKDOWN_INK` in
  `panels/Composer.tsx`).
- **The mirror opts out of scroll anchoring and re-syncs its scroll after
  each render.** Once the mirror holds element spans, Chromium's scroll
  anchoring could move its `scrollTop` a line away from the field's while
  typing fast past the field's maximum height. `overflow-anchor: none` and a
  layout effect that copies the field's `scrollTop` close that; it was not
  in the spec because it only showed up in the browser.
- **A newline with the selection over the marker is left to the browser.**
  A caret or selection that starts inside the marker is not asking to
  continue the list, so the native newline runs.

> Superseded by [[2026-09-29-composer-rich-editor-design]]. Implemented, then discarded: it coloured the markdown instead of formatting it.
