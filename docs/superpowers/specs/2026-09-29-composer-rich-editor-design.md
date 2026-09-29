---
id: 2026-09-29-composer-rich-editor-design
title: Composer — a Tiptap editor that formats markdown as you type
status: done
type: spec
domain: web
related:
  - 2026-09-20-composer-design
  - 2026-09-29-composer-markdown-design
  - the-composer-becomes-a-tiptap-editor
  - command-completion-is-not-anchored-to-position-0
tags:
  - detail-panel
---
# Composer — a Tiptap editor that formats markdown as you type

## Why

A prompt with structure — a list of steps, a heading, a code snippet — is
easier to write and to check when it looks like what it is. The earlier
attempt ([[2026-09-29-composer-markdown-design]]) kept the `<textarea>` and
only coloured the markdown. That is not what was asked for. Typing `- ` should
turn the line into a bullet, `1. ` into a numbered item, and `**word**`
should come out bold, the way Notion or Google Docs behave. A textarea cannot
indent one line or align wrapped text under a bullet, so the field becomes a
rich-text editor ([[the-composer-becomes-a-tiptap-editor]]).

What goes out does not change: the composer hands its caller **markdown**,
the agent receives markdown, and the transcript already renders user turns
as markdown (`MessageView`, `react-markdown` + `remark-gfm`).

## 1. Editor and format

- Tiptap 3 (`@tiptap/react`, `@tiptap/starter-kit`) with the official
  `@tiptap/markdown` extension for parsing and serialising. The composer's
  `<textarea>` and its `aria-hidden` mirror are removed.
- Formatting in scope, all from StarterKit:
  - bullet and ordered lists, nested
  - bold, italic, inline code
  - headings, blockquote, fenced code block
  - hard break
- Markdown input rules create the formatting while typing: `- `, `* `, `1. `,
  `# `, `> `, ```` ``` ````, `**…**`, `_…_`, `` `…` ``. Keyboard: ⌘B, ⌘I,
  ⌘E (inline code), ⌘Z / ⇧⌘Z.
- Pasting plain text that is markdown parses it into formatting. Pasting
  HTML (from a browser page) is reduced to the same schema; anything outside
  it becomes text.
- Out of scope: links as a formatted mark, tables, task lists, images inside
  the text (images stay attachment chips), a toolbar, a setting to show the
  markers.
- Look: the formatted content borrows the transcript's markdown styling
  (`MessageView`'s list, code, quote and code-block treatment) so a prompt
  looks like the turn it becomes. Headings step up only slightly from the
  body size, so a heading does not blow the field up. Body text keeps the
  field's current metrics (`FIELD_METRICS`: sans 13.5px, leading 1.62).

## 2. Keys

The chords stay the keymap's (`lib/keymap.ts`): `composer.send`,
`composer.newline`, `composer.start`.

| where | Enter | Shift+Enter | ⌘Enter |
|---|---|---|---|
| panel (`enter="send"`) | sends | new paragraph; in a list, a new item | owned further out, as today |
| dialog (`enter="newline"`) | new paragraph; in a list, a new item | hard break | starts the session |

- "New paragraph / new item" is Tiptap's own Enter behaviour (split block,
  split list item; on an empty item it lifts out of the list).
- Tab / Shift+Tab inside a list item sink / lift the item. Elsewhere Tab
  keeps its default.
- The completion popup keeps first refusal on every key while it is open
  (↑↓, Enter, Tab, Escape), as today.

## 3. Completion, tokens, argument hints

- **Completion.** `CompletionPopup` stays as it is. Only its inputs change:
  the trigger and prefix come from the editor, not from textarea offsets.
  Tiptap's Suggestion utility (`@tiptap/suggestion`) finds the prefix. Two
  instances, `/` and `@`, keep today's rules: commands follow
  [[command-completion-is-not-anchored-to-position-0]], and mentions are
  paths relative to the session's cwd. Accepting a row replaces the
  trigger + prefix with the chosen text through an editor command.
- **Tokens.** `/command` and `@path` stay plain text in the document, not
  atom nodes. The markdown out is then exactly what was typed, and
  `lib/composerTokens.ts` stays the one rule for what counts as a token. A
  ProseMirror decoration plugin paints the command chip and the
  resolved-mention tint using that tokenizer's ranges. Tokens inside inline
  code or a code block are not tinted.
- **Argument hint (new).** When the caret sits right after a recognised
  `/command ` and nothing follows on that line, a ghost of the command's
  `argumentHint` is drawn after the caret in the hint ink, as the CLI does.
  It is a widget decoration, never text: it is not sent, not selectable, and
  it disappears on the first typed character.
  - Server: `collectCommands` (`server/src/commands/catalog.ts`) also reads
    the `argument-hint` frontmatter of skills and commands. The live-session
    branch of the commands route already passes the CLI's `argumentHint`
    through.
  - Web: `SlashCommand` gains `argumentHint?: string`.

## 4. Value and drafts

- `Composer` keeps its props. `value` and `onChange` are still markdown
  strings, so `DetailPanel` (store-backed `composerDrafts`) and
  `NewSessionDialog` (local state) do not change.
- The editor emits `onChange(markdown)` on each document change.
- It re-parses `value` only when the value differs from the last markdown
  it emitted: a session switch, a draft cleared after send, or an external
  reset. Never on its own keystrokes, which would reset the caret.
- Everything else keeps its behaviour:
  - image paste and drop (`useAttachments`, `useImageDrop`), with paste
    hanging off the editor's DOM
  - the IDE slot
  - the locked state (`editable: false`) and the answering state
  - the placeholder (`@tiptap/extensions` Placeholder)
  - growth up to `MAX_FIELD_PX`, then the field scrolls
  - the focus styling of the well

## 5. Testing

- **Round trip.** Pure tests on markdown → editor → markdown for:
  - bullet, ordered and nested lists, headings, quotes, fenced code, inline
    code, bold and italic
  - text with literal `*`, `_`, `#`, `` ` `` and `>` that must not be
    escaped into something else or doubled
  - `/command` and `@path` coming through untouched
  - Czech text
- **Keys.** Enter and Shift+Enter in and out of a list, in both modes.
  Enter sends in the panel and never in the dialog.
- **Existing composer tests** (`composer.test.tsx`, `composerintake.test.tsx`,
  `ideslot.test.tsx`, `compaction.test.tsx`) keep their assertions. Only the
  way text gets into the field changes: a helper that sets content through
  the editor instead of `userEvent.type` into a textarea.
- **Argument hint.** The catalog reads `argument-hint`. The ghost appears
  and disappears (decoration present / absent).
- No styling tests.

## 6. Order of work

1. Verify `@tiptap/markdown` round-trips the cases in § 5 without loss. If
   it does not, try the community `tiptap-markdown`. Record which one, and
   why, in the ADR.
2. Editor in `Composer` with formatting, keys, value/drafts, attachments,
   locked state.
3. Completion and token decorations.
4. Argument hint (server catalog + ghost).
5. Tests, then a real-browser check of both mounts.

The work that [[2026-09-29-composer-markdown-design]] described was
discarded; nothing of it is in the tree.

## Deviations

What was built differs from the sections above in these places, each for
the reason given.

- **§ 1, the markdown extension is tuned, not used as shipped.** Out of the
  box it escapes every `*`, `_` and `` ` ``, entity-encodes `<`, `>` and `&`,
  and loses links and tables; `tiptap-markdown` did the same and worse. The
  composer gives it its own `marked` (CommonMark, no HTML or links), its own
  text encoder and blank-line handling. The comparison and the reasons are in
  [[the-composer-becomes-a-tiptap-editor]] § Markdown library.
- **§ 1, emphasis input rules are stricter than Tiptap's.** Tiptap's own
  rules let whitespace sit inside the delimiters, so typing `2 * 3 * 4` made
  ` 3 ` italic. The composer's rules follow CommonMark: the delimiters have to
  hug the text. The marks' paste rules are off; pasted text is parsed as
  markdown instead.
- **§ 1, StarterKit's horizontal rule and trailing paragraph stay.** Neither
  is in the list, neither is harmful: `---` round-trips, and the trailing
  paragraph is what lets the caret leave a list or code block at the end.
  Links, underline and strike are off.
- **§ 1, quotes and headings are not borrowed from `MessageView`.** The
  transcript styles neither (a quote renders as plain text there), so the
  field gives a quote a left rule and a heading a small step up. Lists, inline
  code and code blocks use the transcript's classes (`theme.css`,
  `.orbital-composer-field`).
- **§ 1, paste of plain text vs HTML.** Plain text is read as markdown, and
  so is text whose HTML twin is only styling (a code editor's copy). HTML with
  structure (a web page) goes to ProseMirror, which reduces it to the schema.
- **§ 3, `@tiptap/suggestion` is not used.** It brings its own dismissal,
  Escape handling, item fetching and floating-ui positioning, all of which
  `CompletionPopup` and the composer already own. The one piece needed, the
  prefix finder, is `completionContext` run on the text of the block before
  the caret, with its offset mapped to a document position. Same rules,
  fewer moving parts, one dependency fewer.
- **§ 3, a mention with a `:line` suffix is painted as two spans.**
  ProseMirror wraps each differently decorated stretch of text separately, so
  the chip's ring is split by side and the seam has none.
- **§ 3, the live commands route falls back to the file's hint.** When the
  CLI knows a command but gives no `argumentHint`, the scanned file's
  `argument-hint` is used, the same way the description already falls back.
- **§ 4, the locked field and the placeholder.** A contenteditable has no
  `disabled` or `placeholder` attribute. The root carries `aria-disabled` and
  `aria-placeholder`, the placeholder is drawn by the Placeholder extension
  (shown while locked too), and the tests assert on those.
- **§ 5, the mirror's tests.** The lockstep test (field and mirror on the same
  metrics) is gone with the mirror; the token tests now look in the editor's
  own DOM. The dialog's "⏎ is not swallowed" check became "⏎ made a second
  paragraph", since the editor handles Enter itself. Everything else kept its
  assertion; only how text gets in changed (`web/src/test/composerField.ts`).
