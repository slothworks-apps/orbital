---
id: the-composer-becomes-a-tiptap-editor
title: The composer becomes a Tiptap editor that speaks markdown
type: adr
status: in-force
domain: web
related:
  - 2026-09-29-composer-rich-editor-design
  - the-composer-stays-a-textarea-for-markdown
  - composer-highlighting-and-completion
tags:
  - detail-panel
---
# The composer becomes a Tiptap editor that speaks markdown

This supersedes [[the-composer-stays-a-textarea-for-markdown]].

What was asked for is formatting as you type: `- ` becomes a bullet, the
line indents, wrapped text aligns under it, `**word**` comes out bold. The
textarea-plus-mirror approach could only colour the markdown. A textarea
cannot indent a single line or align wrapped text under a bullet, and the
mirror cannot change glyph widths. That shipped as a working prototype and
was discarded as not being the feature.

**Chosen: Tiptap 3 with its markdown extension.** It brings the input rules
(`- `, `1. `, `# `, `**…**`) and list behaviour (Enter splits an item, Tab
nests it), and it parses and serialises markdown. The composer keeps its
string-in, string-out contract, so drafts, the send path and the
transcript are untouched.

**Ruled out: CodeMirror 6.** It formats in place but keeps the markers
visible, and its list handling is text continuation, not list structure. It
would have been as large a rewrite of the composer as Tiptap, for less of
what was asked. The user was indifferent to whether markers stay visible,
so the structural editor wins.

The cost, accepted: the textarea's free behaviour has to be rebuilt on the
editor — the send and newline keys, completion positioning, paste of images,
the locked state. Most of the composer's tests change how they type. The
earlier idea's worry about contenteditable (Enter, paste, IME) is what
ProseMirror handles for us: composition and paste are its own, and Enter is
a keymap entry.

## Markdown library

**Chosen: the official `@tiptap/markdown`, with its text encoding and its
parser tuned** (`web/src/lib/composerMarkdown.ts`). Both candidates were run
through the round trip spec § 5 asks for, in jsdom, before any UI was built.

Both got the structure right — bullet, ordered and nested lists, headings,
fences, inline code, `/command`, `@path`, Czech. Both garbled the literal
text, which is what the agent actually reads:

- `@tiptap/markdown` backslash-escaped every `*`, `_` and `` ` `` (`2 * 3`
  went out as `2 \* 3`), entity-encoded `<`, `>` and `&` (`x > y` became
  `x &gt; y`), parsed `<div>` into the schema, dropped a link's URL and a
  table's whole content, and wrote consecutive blank lines as `&nbsp;`.
- `tiptap-markdown` (community; markdown-it and prosemirror-markdown) had
  the same escaping and entity encoding, and on top of that joined a soft
  line break into one line (`line one\nline two` came back as `line one line
  two`), garbled a table into `ab12` and wrote a hard break as `\`.

Neither was usable as shipped, so the choice was which one to fix. The
official one: it is on Tiptap's own version train, its parser is `marked`
(which can be given an instance of its own and have tokenizers switched off),
and the escaping lives in one method. Three changes make it pass: a `marked`
of its own with GFM, HTML, links and link definitions off, so anything outside
the schema stays text and comes back byte for byte; a text encoder that
escapes a character only where reading it back would change its meaning; and
empty paragraphs written as blank lines. The encoder replaces a method the
package's types mark private, so `composermarkdown.test.ts` is what notices
an upgrade that renames it.

One normalisation is accepted: `_italic_` goes out as `*italic*`, and a `* `
bullet as `- `. Same meaning, different bytes.
