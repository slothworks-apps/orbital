/**
 * The composer's token paint and argument hint, as ProseMirror decorations
 * (spec: 2026-09-29-composer-rich-editor-design § 3).
 *
 * `/command` and `@path` stay plain text in the document, so what goes out
 * is exactly what was typed; this plugin only paints them. The rule for what
 * counts as a token is still `tokenizeComposer`'s — it runs over each
 * textblock's text, and its offsets map onto document positions one to one
 * (a hard break is the one leaf node inside a textblock, and it reads as one
 * `\n`).
 *
 * What the paint depends on besides the text — the catalog, the confirmed
 * paths, the hints — lives in the composer's React state, so the plugin reads
 * it through a getter and is told to look again with `refreshDecorations`.
 */

import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { tokenizeComposer } from './composerTokens'

export interface TokenSource {
  /** Catalog names without their slash (`commandNameSet`). */
  known: ReadonlySet<string>
  /** Mentions the server has confirmed — the tint is that receipt. */
  resolved: ReadonlySet<string>
  /** `argumentHint` per catalog name without its slash. */
  hints: ReadonlyMap<string, string>
}

const key = new PluginKey<DecorationSet>('composerTokens')

// 9a/9e: filled slug, rgba(150,205,255,.13) under #f2f9ff ink, 4px radius.
// The padding is cancelled by an equal negative margin so a token takes the
// width of its glyphs and nothing around it moves when it is recognised. No
// transition — 9e: "meant to read as the field having always known".
const COMMAND_CLASS =
  '-mx-[5px] box-decoration-clone rounded-[4px] bg-[rgba(150,205,255,.13)] px-[5px] py-px text-[#f2f9ff] transition-none'
// 9a/9e: .06 fill + a 1px .18 ring under #dfeeff ink. A mention with a
// `:line` suffix is drawn as two spans — ProseMirror wraps each differently
// decorated stretch of text on its own — so the ring is split by side, and
// the seam between them has none.
const MENTION_FILL =
  'box-decoration-clone bg-[rgba(150,205,255,.06)] py-px text-[#dfeeff] transition-none'
const MENTION_CLASS = `${MENTION_FILL} -mx-[5px] rounded-[4px] px-[5px] shadow-[inset_0_0_0_1px_rgba(150,205,255,.18)]`
const MENTION_HEAD_CLASS = `${MENTION_FILL} -ml-[5px] rounded-l-[4px] pl-[5px] shadow-[inset_1px_1px_0_rgba(150,205,255,.18),inset_0_-1px_0_rgba(150,205,255,.18)]`
const MENTION_SUFFIX_CLASS = `${MENTION_FILL} -mr-[5px] rounded-r-[4px] pr-[5px] text-[rgba(160,190,225,.6)] shadow-[inset_-1px_1px_0_rgba(150,205,255,.18),inset_0_-1px_0_rgba(150,205,255,.18)]`
// The ghost is in the hint line's ink (9e), and is not text: it cannot be
// selected, clicked into or sent.
const HINT_CLASS = 'pointer-events-none select-none text-[rgba(160,190,225,.5)]'

/** A slug that starts a word, then exactly one space, then the caret. */
const COMMAND_BEFORE_CARET = /(?:^|\s)\/([A-Za-z0-9][A-Za-z0-9:._-]*) $/

function tokenDecorations(doc: ProseMirrorNode, source: TokenSource): Decoration[] {
  const out: Decoration[] = []
  const code = doc.type.schema.marks.code
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // A code block is code; nothing in it is a token.
    if (node.type.spec.code) return false
    const text = node.textBetween(0, node.content.size, undefined, '\n')
    let from = pos + 1
    for (const token of tokenizeComposer(text, source.known)) {
      const start = from
      from += token.text.length
      if (token.kind === 'text') continue
      // Nor is anything inside inline code.
      if (code && doc.rangeHasMark(start, from, code)) continue
      if (token.kind === 'command') {
        out.push(Decoration.inline(start, from, { class: COMMAND_CLASS, 'data-token': 'command' }))
        continue
      }
      // An unconfirmed path stays plain ink (9b: "not tinted while you are
      // still typing it").
      if (!source.resolved.has(token.path)) continue
      if (!token.suffix) {
        out.push(Decoration.inline(start, from, { class: MENTION_CLASS, 'data-token': 'mention' }))
        continue
      }
      const split = from - token.suffix.length
      out.push(
        Decoration.inline(start, split, { class: MENTION_HEAD_CLASS, 'data-token': 'mention' }),
      )
      out.push(
        Decoration.inline(split, from, {
          class: MENTION_SUFFIX_CLASS,
          'data-token': 'mention',
          'data-token-suffix': '',
        }),
      )
    }
    return false
  })
  return out
}

/**
 * The name of the recognised command the caret sits right after — `/name `
 * with nothing following it on the line — or null.
 */
export function commandBeforeCaret(state: EditorState, known: ReadonlySet<string>): string | null {
  const { selection } = state
  if (!selection.empty) return null
  const { $from } = selection
  const block = $from.parent
  if (!block.isTextblock || block.type.spec.code) return null
  const before = block.textBetween(0, $from.parentOffset, undefined, '\n')
  const after = block.textBetween($from.parentOffset, block.content.size, undefined, '\n')
  if (after.split('\n')[0] !== '') return null
  const name = COMMAND_BEFORE_CARET.exec(before.slice(before.lastIndexOf('\n') + 1))?.[1]
  return name && known.has(name) ? name : null
}

function hintDecoration(state: EditorState, source: TokenSource): Decoration | null {
  const name = commandBeforeCaret(state, source.known)
  const hint = name === null ? undefined : source.hints.get(name)
  if (!hint) return null
  return Decoration.widget(
    state.selection.from,
    () => {
      const ghost = document.createElement('span')
      ghost.className = HINT_CLASS
      ghost.contentEditable = 'false'
      ghost.setAttribute('aria-hidden', 'true')
      ghost.dataset.argumentHint = ''
      ghost.textContent = hint
      return ghost
    },
    // After the caret, and redrawn only when the hint itself changes.
    { side: 1, key: `hint:${hint}`, ignoreSelection: true },
  )
}

function build(state: EditorState, source: TokenSource): DecorationSet {
  const decorations = tokenDecorations(state.doc, source)
  const hint = hintDecoration(state, source)
  if (hint) decorations.push(hint)
  return DecorationSet.create(state.doc, decorations)
}

export function composerDecorationsPlugin(source: () => TokenSource): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => build(state, source()),
      apply: (tr, previous, _old, state) =>
        tr.docChanged || tr.selectionSet || tr.getMeta(key) ? build(state, source()) : previous,
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  })
}

/** Repaints after something the paint reads outside the document changed. */
export function refreshDecorations(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(key, true))
}
