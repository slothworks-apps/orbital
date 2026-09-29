/**
 * The composer's document model and its markdown, both ways (spec:
 * 2026-09-29-composer-rich-editor-design § 1; ADR
 * the-composer-becomes-a-tiptap-editor § Markdown library).
 *
 * The composer hands its caller markdown and the agent reads that markdown
 * raw, so the one invariant here is that what the user typed goes out as they
 * typed it. `@tiptap/markdown` gets the structure right — lists, nesting,
 * headings, fences — but, as shipped, it protects its own round trip at the
 * expense of the text: every `*`, `_` and `` ` `` is backslash-escaped, `<`,
 * `>` and `&` become HTML entities, raw HTML is parsed into the schema (or
 * dropped), and a link or a table outside the schema loses its URL or its
 * whole content. Three changes turn that around:
 *
 * 1. Its own `marked` instance, CommonMark only (no GFM) and with the HTML,
 *    link and link-definition tokenizers switched off. Anything the composer
 *    has no node for (a link, a table, a tag) is then plain text on the way
 *    in, and comes back out byte for byte.
 * 2. A text encoder that escapes only where the character would otherwise
 *    change meaning on the way back: a run that re-lexes as plain text goes
 *    out untouched, and a line that would re-open as a block (`# `, `> `,
 *    `- `, `1. `, a fence) has its marker escaped. `2 * 3 * 4` stays `2 * 3 *
 *    4`; only a literal `*word*` gets its backslashes.
 * 3. Empty paragraphs serialise to nothing rather than `&nbsp;`, and the
 *    trailing blank lines a closing block leaves are trimmed.
 */

import { markInputRule, type Editor, type Extensions, type JSONContent } from '@tiptap/core'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import HardBreak from '@tiptap/extension-hard-break'
import Paragraph from '@tiptap/extension-paragraph'
import Bold from '@tiptap/extension-bold'
import Italic from '@tiptap/extension-italic'
import { Marked, type Token, type marked } from 'marked'
import { Fragment, Slice } from '@tiptap/pm/model'
import type { Schema, ResolvedPos } from '@tiptap/pm/model'

/**
 * A `marked` of the composer's own. The shared default instance would collect
 * every editor's tokenizers (the manager registers them on whatever instance
 * it is given), and the switched-off tokenizers must not leak into anything
 * else that parses markdown with it.
 */
function composerMarked(): Marked {
  // Returning `undefined` from a tokenizer override means "no match here" —
  // `false` would fall back to the original.
  const none = () => undefined
  return new Marked({
    gfm: false,
    tokenizer: {
      html: none,
      def: none,
      tag: none,
      link: none,
      reflink: none,
      autolink: none,
    },
  })
}

/** `&amp;`, `&#38;`, `&#x26;` — a literal one would be decoded on the way back. */
const ENTITY = /&(?=(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});)/g

/** What opens a block at the start of a line, and which character to escape. */
const BLOCK_OPENERS: Array<{ test: RegExp; at: (line: string) => number }> = [
  // ATX heading, blockquote, bullet, fence.
  { test: /^ {0,3}(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|```|~~~)/, at: (l) => l.search(/\S/) },
  // Ordered item: the delimiter after the number is what makes it a list.
  { test: /^ {0,3}\d{1,9}[.)](?:\s|$)/, at: (l) => l.search(/[.)]/) },
  // Thematic break.
  { test: /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/, at: (l) => l.search(/\S/) },
]
/** A setext underline turns the line ABOVE it into a heading. */
const SETEXT = /^ {0,3}(?:=+|-+)\s*$/

/**
 * The manager's text encoder, which it calls for every text node it writes
 * out. The stock one escapes every markdown character and entity-encodes the
 * rest; it is private in the package's types, so it is replaced on the
 * instance, and the round-trip tests are what notice if an upgrade renames it.
 */
interface TextEncoderHook {
  encodeTextForMarkdown(text: string, node: JSONContent, parentNode?: JSONContent): string
}

type ManagerOptions = ConstructorParameters<typeof MarkdownManager>[0]

function composerManager(options: Omit<NonNullable<ManagerOptions>, 'marked'>): MarkdownManager {
  const lexer = composerMarked()
  const manager = new MarkdownManager({
    ...options,
    // The manager uses the instance API only (`Lexer`, `defaults`, `use`),
    // which a `Marked` has; its type asks for the module's default export.
    marked: lexer as unknown as typeof marked,
  })
  ;(manager as unknown as TextEncoderHook).encodeTextForMarkdown = (text, node, parentNode) => {
    const inCode =
      parentNode?.type === 'codeBlock' || (node.marks ?? []).some((m) => m.type === 'code')
    if (inCode) return text
    const siblings = parentNode?.content ?? []
    const index = siblings.indexOf(node)
    const atLineStart = index <= 0 || siblings[index - 1]?.type === 'hardBreak'
    return escapeLineStarts(escapeInline(lexer, text), atLineStart)
  }
  return manager
}

function escapeInline(lexer: Marked, text: string): string {
  // Entities go last: their own backslash must not be escaped again.
  const entities = (s: string) => s.replace(ENTITY, '\\&')
  if (!/[\\*_`]/.test(text)) return entities(text)
  const tokens: Token[] = lexer.Lexer.lexInline(text, lexer.defaults)
  const plain = tokens.every((t) => t.type === 'text') && tokens.map((t) => t.raw).join('') === text
  if (plain) return entities(text)
  const out = text
    // A backslash only escapes punctuation, or breaks the line at its end.
    .replace(/\\(?=[!-/:-@[-`{-~]|$)/gm, '\\\\')
    .replace(/[*`]/g, '\\$&')
    // An intraword underscore cannot open or close emphasis.
    .replace(/_/g, (m, i: number, s: string) =>
      /[\p{L}\p{N}]/u.test(s[i - 1] ?? '') && /[\p{L}\p{N}]/u.test(s[i + 1] ?? '') ? m : '\\_',
    )
  return entities(out)
}

function escapeLineStarts(text: string, atLineStart: boolean): string {
  return text
    .split('\n')
    .map((line, i) => {
      if (i === 0 && !atLineStart) return line
      if (i > 0 && SETEXT.test(line)) return escapeAt(line, line.search(/\S/))
      const opener = BLOCK_OPENERS.find((o) => o.test.test(line))
      return opener ? escapeAt(line, opener.at(line)) : line
    })
    .join('\n')
}

const escapeAt = (line: string, at: number) => `${line.slice(0, at)}\\${line.slice(at)}`

/**
 * `Markdown` with the composer's manager. The stock `onBeforeCreate` builds
 * its own manager and refuses to run twice, so this one is a copy of it that
 * builds ours instead — including the initial `contentType: 'markdown'` parse.
 */
const ComposerMarkdown = Markdown.extend({
  onBeforeCreate() {
    const manager = composerManager({
      indentation: this.options.indentation,
      extensions: this.editor.extensionManager.baseExtensions,
    })
    this.storage.manager = manager
    this.editor.markdown = manager
    this.editor.getMarkdown = () => manager.serialize(this.editor.getJSON())
    const { content, contentType } = this.editor.options
    if (contentType === 'markdown' && typeof content === 'string') {
      const json = manager.parse(content)
      if (json.content?.length) this.editor.options.content = json
    }
  },
})

/** An empty paragraph is a blank line, never `&nbsp;` sent to the agent. */
const ComposerParagraph = Paragraph.extend({
  renderMarkdown: (node, h) => (node.content?.length ? h.renderChildren(node.content) : ''),
})

/**
 * Emphasis as CommonMark reads it: the delimiters hug the text. Tiptap's own
 * rules accept whitespace just inside them, so typing `2 * 3 * 4` turned
 * ` 3 ` italic; a run that opens or closes on a space is not emphasis, and
 * stays the characters that were typed.
 */
const emphasis = (delimiter: string) => {
  const d = delimiter.replace(/[*]/g, '\\*')
  const c = delimiter[0] === '*' ? '*' : '_'
  return new RegExp(`(?:^|\\s)(${d}(?!\\s)((?:[^${c}]*[^\\s${c}]))${d})$`)
}

const ComposerBold = Bold.extend({
  addInputRules() {
    return ['**', '__'].map((d) => markInputRule({ find: emphasis(d), type: this.type }))
  },
})

const ComposerItalic = Italic.extend({
  addInputRules() {
    return ['*', '_'].map((d) => markInputRule({ find: emphasis(d), type: this.type }))
  },
})

/**
 * The hard break without its keys. Its own ⇧⏎ and ⌘⏎ would pre-empt the
 * composer's: ⇧⏎ means a new paragraph in the panel, and ⌘⏎ belongs to
 * whoever listens further out (spec § 2). The composer inserts a break
 * itself where the table says so.
 */
const ComposerHardBreak = HardBreak.extend({
  addKeyboardShortcuts: () => ({}),
})

/**
 * Everything that decides what the document can hold and how it reads and
 * writes markdown — the editor adds its behaviour (keys, tokens, placeholder)
 * on top. The formatting in scope is spec § 1's list; links, underline and
 * strike are out.
 */
export function composerSchemaExtensions(): Extensions {
  return [
    StarterKit.configure({
      link: false,
      underline: false,
      strike: false,
      paragraph: false,
      hardBreak: false,
      bold: false,
      italic: false,
    }),
    ComposerParagraph,
    ComposerBold,
    ComposerItalic,
    ComposerHardBreak,
    ComposerMarkdown,
  ]
}

/** The editor's content as the markdown the composer hands out. */
export function composerMarkdown(editor: Editor): string {
  // A closing list or block leaves blank lines behind it; the text ends where
  // the text ends.
  return editor.getMarkdown().replace(/\n+$/, '')
}

/** Markdown in, editor JSON out — the parse `setContent` would do. */
export function parseComposerMarkdown(editor: Editor, markdown: string): JSONContent {
  const json = editor.markdown?.parse(markdown) ?? { type: 'doc', content: [] }
  // An empty document still needs its one paragraph for the caret.
  return json.content?.length ? json : { type: 'doc', content: [{ type: 'paragraph' }] }
}

/**
 * HTML that carries structure of its own: a page's paragraphs, lists and
 * emphasis. What a code editor puts next to its plain text is only styled
 * spans in a `<div>` or `<pre>` — colour, not structure — so it does not count.
 */
const STRUCTURED_HTML = /<(?:p|ul|ol|li|h[1-6]|blockquote|strong|em|b|i|code|table)[\s>]/i

/**
 * The clipboard's plain text when it should be pasted as markdown, or null
 * when ProseMirror's own paste should run — HTML from a page is reduced to
 * the schema by ProseMirror, which keeps its structure better than the page's
 * plain-text rendering would.
 */
export function clipboardMarkdown(data: DataTransfer | null): string | null {
  // A clipboard carrying only a file (the image intake's shape) has no text.
  if (!data || typeof data.getData !== 'function') return null
  const text = data.getData('text/plain')
  if (!text) return null
  const html = data.getData('text/html')
  return html && STRUCTURED_HTML.test(html) ? null : text
}

/**
 * Plain text off the clipboard, read as markdown (spec § 1: "pasting plain
 * text that is markdown parses it into formatting"). Null leaves the paste to
 * ProseMirror — inside a code block, where text is code.
 *
 * One paragraph pastes open, so it flows into the line the caret is on;
 * anything with blocks pastes as blocks.
 */
export function markdownPasteSlice(
  editor: Editor,
  schema: Schema,
  text: string,
  $context: ResolvedPos,
): Slice | null {
  if ($context.parent.type.spec.code) return null
  const json = editor.markdown?.parse(text)
  if (!json?.content?.length) return null
  const fragment = Fragment.fromJSON(schema, json.content)
  const single = fragment.childCount === 1 && fragment.firstChild?.type.name === 'paragraph'
  return single ? new Slice(fragment, 1, 1) : new Slice(fragment, 0, 0)
}
