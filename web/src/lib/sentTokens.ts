/**
 * The sent turn's token tint (spec: 2026-09-20-composer-design § The transcript
 * side; canvas 9e SENT: "tint holds in the transcript").
 *
 * A rehype plugin, the same shape as `rehypePathLinks`, and for the same
 * reason: a user turn is rendered as markdown, so the only way to tint a run
 * inside it without giving up the markdown is to rewrite the tree between parse
 * and render. Tokenising the raw string instead would mean choosing between
 * tints and fenced code in a user's own message.
 *
 * The tint is DISPLAY-ONLY — spans, no buttons, no hover, no cursor change. It
 * says "this was parsed", never "press this" (canvas 9a), and it is quieter than
 * the composer's live tint (9e: `.08` fill against the field's `.13`).
 *
 * Classes rather than inline style so the values live in `theme.css` next to
 * every other design constant; the elements are built here, so there is no
 * `className` string for Tailwind's scanner to find and a utility would not be
 * emitted.
 */

import { tokenizeComposer } from './composerTokens'
import type { HastElement, HastNode, HastParent, HastRoot, HastText } from './pathLinks'

export type { HastRoot } from './pathLinks'

/**
 * JUDGEMENT CALL: every position-0 slug is tinted in the transcript, because
 * there is no catalog to check it against.
 *
 * The composer tints a command only on an exact catalog match, and it can: it
 * has a live session, so `GET /api/commands` can answer. A history turn has no
 * session behind it (it may be from another machine, another install, a plugin
 * since uninstalled), and fetching a catalog per rendered message to decide
 * whether an old `/deploy` was real would be both expensive and wrong — the
 * answer would be about today's install, not about the turn. So the transcript
 * reads the shape and trusts it. A slug that was never a command reads as one
 * for one line of one old message; the alternative is untinting turns that
 * genuinely were commands, which is the worse of the two.
 *
 * Only `has` is ever called on this — `tokenizeComposer` reads nothing else.
 */
const EVERY_COMMAND = { has: () => true } as unknown as ReadonlySet<string>

/** For every text node after the first: not position 0, so no command can match. */
const NO_COMMANDS: ReadonlySet<string> = new Set<string>()

/** Same exclusions as `rehypePathLinks`: code is quoted, links are taken. */
const SKIP_TAGS = new Set(['code', 'pre', 'a', 'script', 'style'])

function isParent(node: HastNode): node is HastParent | HastElement {
  return Array.isArray((node as HastParent).children)
}

function span(className: string, children: HastNode[]): HastElement {
  return { type: 'element', tagName: 'span', properties: { className }, children }
}

/**
 * Splits one text node into tinted spans, or null when there is nothing to
 * tint. `atStart` is true only for the document's first text node, which is the
 * only place a command slug can sit (the position-0 rule).
 */
function splitTextNode(node: HastText, atStart: boolean): HastNode[] | null {
  const tokens = tokenizeComposer(node.value, atStart ? EVERY_COMMAND : NO_COMMANDS)
  if (!tokens.some((token) => token.kind !== 'text')) return null

  const out: HastNode[] = []
  for (const token of tokens) {
    if (token.kind === 'text') {
      out.push({ type: 'text', value: token.text })
      continue
    }
    if (token.kind === 'command') {
      const element = span('orbital-sent-command', [{ type: 'text', value: token.text }])
      element.properties!.dataToken = 'command'
      out.push(element)
      continue
    }
    const element = span('orbital-sent-mention', [{ type: 'text', value: `@${token.path}` }])
    element.properties!.dataToken = 'mention'
    out.push(element)
    if (token.suffix) {
      // Its own span so the `:line` can be muted (9e) — and outside the ring,
      // which the canvas draws around the path alone.
      const suffix = span('orbital-sent-suffix', [{ type: 'text', value: token.suffix }])
      suffix.properties!.dataTokenSuffix = 'true'
      out.push(suffix)
    }
  }
  return out
}

/**
 * Walks the tree in document order. `state.seenText` is what makes "position 0"
 * mean the start of the MESSAGE rather than the start of every paragraph.
 */
function walk(node: HastParent | HastElement, state: { seenText: boolean }): void {
  const children = node.children
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]
    if (child.type === 'element') {
      if (SKIP_TAGS.has((child as HastElement).tagName)) {
        state.seenText = true
        continue
      }
      walk(child as HastElement, state)
      continue
    }
    if (child.type === 'text') {
      const atStart = !state.seenText
      state.seenText = true
      const replacement = splitTextNode(child as HastText, atStart)
      if (replacement) {
        children.splice(i, 1, ...replacement)
        i += replacement.length - 1
      }
      continue
    }
    if (isParent(child)) walk(child, state)
  }
}

/** Rehype plugin tinting a sent turn's command slug and resolved mentions. */
export function rehypeSentTokens() {
  return (tree: HastRoot): void => {
    walk(tree, { seenText: false })
  }
}
