/**
 * File-path detection lives in `@orbital/shared/paths`, where the server
 * reads the same paths for a session's media (spec
 * 2026-10-09-session-media-design § Path detection moves to `shared/`). It
 * is re-exported here so the web keeps one import site; the rehype plugin
 * below is the web's own.
 *
 * An inline code span is pressable too, but only when the path is the whole
 * span (adr `a-code-span-that-is-a-path-is-pressable`).
 */
import {
  codeSpanPath,
  findPathMatches,
  findPathMentions,
  isPressablePath,
  type PathFinder,
  type PathMatch,
} from '@orbital/shared/paths'

export {
  codeSpanPath,
  findMediaPaths,
  findPathMatches,
  findPathMentions,
  hasTextExtension,
  isImagePath,
  isMediaPath,
  isPdfPath,
  isPressablePath,
  mediaPathsInReply,
} from '@orbital/shared/paths'
export type { PathFinder, PathMatch } from '@orbital/shared/paths'

// ---------------------------------------------------------------------------
// rehype plugin
// ---------------------------------------------------------------------------

// Minimal structural hast types — enough for the walk below, without adding
// a dependency on `@types/hast` (react-markdown's own copy is a transitive
// implementation detail).
export interface HastText {
  type: 'text'
  value: string
}
export interface HastElement {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children: HastNode[]
}
export interface HastParent {
  type: string
  children: HastNode[]
}
export type HastNode = HastText | HastElement | HastParent
export interface HastRoot {
  type: 'root'
  children: HastNode[]
}

/**
 * Inside these, a path stays text: a block is quoted material, links are
 * taken. Inline `code` is not here — {@link codeSpanPath} decides it whole.
 */
const SKIP_TAGS = new Set(['pre', 'a', 'script', 'style'])

function isParent(node: HastNode): node is HastParent | HastElement {
  return Array.isArray((node as HastParent).children)
}

/** The `<a data-path data-line>` element the markdown `a` override recognizes. */
function pathLinkElement(match: PathMatch, inCode = false): HastElement {
  return {
    type: 'element',
    tagName: 'a',
    properties: {
      // hast's camelCase `data*` properties serialize to `data-*`
      // attributes, which is how `MessageView`'s `a` component override
      // tells these apart from authored links.
      dataPath: match.path,
      ...(match.line !== null ? { dataLine: String(match.line) } : {}),
      // The button sits inside a code chip, which already sets the type
      // and the box.
      ...(inCode ? { dataCode: '' } : {}),
      // A path no press can open — wrapped only when the plugin was asked
      // for every mention (`plain`): the override draws it as text, never
      // as a link.
      ...(isPressablePath(match.path) ? {} : { dataPlain: '' }),
    },
    children: [{ type: 'text', value: match.text }],
  }
}


function linkCodeSpan(code: HastElement, find: PathFinder): void {
  const [only] = code.children
  if (code.children.length !== 1 || only.type !== 'text') return
  const match = codeSpanPath((only as HastText).value, find)
  if (match) code.children = [pathLinkElement(match, true)]
}

function splitTextNode(node: HastText, find: PathFinder): HastNode[] | null {
  const matches = find(node.value)
  if (matches.length === 0) return null
  const out: HastNode[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.index > cursor) out.push({ type: 'text', value: node.value.slice(cursor, match.index) })
    out.push(pathLinkElement(match))
    cursor = match.index + match.length
  }
  if (cursor < node.value.length) out.push({ type: 'text', value: node.value.slice(cursor) })
  return out
}

function walk(node: HastParent | HastElement, find: PathFinder): void {
  const children = node.children
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]
    if (child.type === 'element') {
      const tagName = (child as HastElement).tagName
      if (SKIP_TAGS.has(tagName)) continue
      // Reached only outside `pre`, so any `code` here is an inline span.
      if (tagName === 'code') {
        linkCodeSpan(child as HastElement, find)
        continue
      }
      walk(child, find)
      continue
    }
    if (child.type === 'text') {
      const replacement = splitTextNode(child as HastText, find)
      if (replacement) {
        children.splice(i, 1, ...replacement)
        i += replacement.length - 1
      }
      continue
    }
    if (isParent(child)) walk(child, find)
  }
}

/**
 * Rehype plugin wrapping every prose path match in an `<a data-path>` the
 * markdown `components.a` override renders as a `PathButton`. An inline
 * code span that is exactly one path gets the same link inside it; text in
 * `pre` and existing `a` elements is never touched.
 *
 * `plain: true` also wraps the paths no press can open, marked `data-plain`,
 * for a reader that long-presses them (the phone, spec 2026-10-05-mobile-next
 * § 2). Without it — the desktop — those stay bare text.
 */
export function rehypePathLinks(options: { plain?: boolean } = {}) {
  const find = options.plain ? findPathMentions : findPathMatches
  return (tree: HastRoot): void => {
    walk(tree, find)
  }
}
