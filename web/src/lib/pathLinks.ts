/**
 * File-path detection for assistant prose and tool inputs (spec:
 * 2026-09-19-file-viewer-design § The pressable path).
 *
 * Prose needs a pattern, not a parser: a run of path characters with at
 * least one `/` and a known text or image extension, optionally followed by `:line`
 * or `:line:col` (line kept, column ignored, both part of the hit area).
 * False positives are cheap — the viewer refuses politely; false negatives
 * are the expensive kind (canvas 8b).
 *
 * An inline code span is pressable too, but only when the path is the whole
 * span (adr `a-code-span-that-is-a-path-is-pressable`).
 */

/**
 * Extensions the viewer can show as text — a whitelist, because "not an
 * image" is unknowable from a name while "is a text format we know" is a
 * list. Known-binary extensions (`.woff2`, `.pdf`, `.zip`, …) are absent so
 * those paths stay plain text everywhere; images are pressable through
 * {@link IMAGE_EXTENSIONS} instead and open in the lightbox, not the viewer.
 */
const TEXT_EXTENSIONS = new Set([
  // code
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc',
  'cpp', 'hpp', 'cs', 'php', 'pl', 'lua', 'r', 'scala', 'dart', 'ex',
  'exs', 'erl', 'hs', 'clj', 'edn', 'zig', 'sql', 'prisma', 'graphql',
  'gql', 'proto', 'sh', 'bash', 'zsh', 'fish', 'ps1',
  // docs
  'md', 'markdown', 'txt', 'rst', 'adoc', 'log', 'csv', 'tsv',
  // config + markup
  'json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'properties', 'gradle', 'tf', 'html', 'htm', 'xml', 'css',
  'scss', 'sass', 'less', 'lock', 'editorconfig', 'gitignore',
])

/**
 * Extensions a press opens in the lightbox, served by `/api/files/image` —
 * the server's `IMAGE_FILE_CONTENT_TYPES` lists the same set. `.svg` is text
 * on disk but an image to the reader, so it sits here (judgement call).
 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'])

function extensionOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? null : base.slice(dot + 1).toLowerCase()
}

/** True when the path's basename carries an extension from the TEXT whitelist. */
export function hasTextExtension(path: string): boolean {
  const ext = extensionOf(path)
  return ext !== null && TEXT_EXTENSIONS.has(ext)
}

/** True when the path names an image the lightbox can show. */
export function isImagePath(path: string): boolean {
  const ext = extensionOf(path)
  return ext !== null && IMAGE_EXTENSIONS.has(ext)
}

/** True when a press can open the path — as text in the viewer, or as an image. */
export function isPressablePath(path: string): boolean {
  return hasTextExtension(path) || isImagePath(path)
}

export interface PathMatch {
  /** Offset of the whole hit area (path + any `:line[:col]` suffix) in the input. */
  index: number
  /** Length of the whole hit area. */
  length: number
  /** The matched text verbatim — what the button shows. */
  text: string
  /** The path alone, suffix stripped — what travels to the server. */
  path: string
  /** Parsed `:line`, or null when the match carried none. */
  line: number | null
}

/** One path segment: word chars plus the punctuation real file names use. */
const SEGMENT = String.raw`[\w.@+~-]+`
/** A run with at least one `/` — an optional leading segment then `/segment`s. */
const PATH_RUN = new RegExp(`(?:${SEGMENT})?(?:/${SEGMENT})+`, 'g')
/** Optional `:line` or `:line:col` immediately after the path. */
const LINE_SUFFIX = /^:(\d+)(?::\d+)?/

/**
 * An extension a file name could carry: a letter, then up to nine letters
 * or digits. What keeps `1/2.5` or `v1.2/3.0` from reading as a path when
 * every extension counts ({@link findPathMentions}).
 */
const NAMED_EXTENSION = /^[a-z][a-z0-9]{0,9}$/

/** True when the path's basename carries something that reads as a file extension. */
function hasNamedExtension(path: string): boolean {
  const ext = extensionOf(path)
  return ext !== null && NAMED_EXTENSION.test(ext)
}

/** Every path-shaped run in `text` whose extension a press can open. */
export function findPathMatches(text: string): PathMatch[] {
  return scanPaths(text, isPressablePath)
}

/**
 * Every path-shaped run in `text` with a file extension, pressable or not —
 * for a reader that does something with a path it cannot open (the phone's
 * long-press copy, spec 2026-10-05-mobile-next § 2). The desktop never asks.
 */
export function findPathMentions(text: string): PathMatch[] {
  return scanPaths(text, hasNamedExtension)
}

function scanPaths(text: string, accept: (path: string) => boolean): PathMatch[] {
  const matches: PathMatch[] = []
  PATH_RUN.lastIndex = 0
  for (let m = PATH_RUN.exec(text); m !== null; m = PATH_RUN.exec(text)) {
    // Sentence punctuation: `.` is a path character, so a match at the end
    // of a sentence swallows the full stop — trim trailing dots before the
    // extension check so `web/src/App.tsx.` still reads as a `.tsx` hit.
    const path = m[0].replace(/\.+$/, '')
    // A candidate preceded by another slash is the tail of a `//` URL run
    // (`https://…`), not a file path.
    if (m.index > 0 && text[m.index - 1] === '/') continue
    if (!accept(path)) continue

    const suffix = LINE_SUFFIX.exec(text.slice(m.index + path.length))
    const hit = suffix ? path + suffix[0] : path
    matches.push({
      index: m.index,
      length: hit.length,
      text: hit,
      path,
      line: suffix ? Number(suffix[1]) : null,
    })
    PATH_RUN.lastIndex = m.index + hit.length
  }
  return matches
}

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

/** What the walk matches with: pressable paths only, or every path mention. */
type Finder = (text: string) => PathMatch[]

/**
 * The match an inline code span stands for, or null. Only a span that is
 * one path and nothing else qualifies: `` `web/src/App.tsx:42` `` is a
 * reference, while `` `cat web/src/App.tsx` `` is a command that happens to
 * contain one, and stays quoted material.
 */
export function codeSpanPath(text: string, find: Finder = findPathMatches): PathMatch | null {
  const trimmed = text.trim()
  const matches = find(trimmed)
  if (matches.length !== 1) return null
  const [match] = matches
  return match.index === 0 && match.length === trimmed.length ? match : null
}

function linkCodeSpan(code: HastElement, find: Finder): void {
  const [only] = code.children
  if (code.children.length !== 1 || only.type !== 'text') return
  const match = codeSpanPath((only as HastText).value, find)
  if (match) code.children = [pathLinkElement(match, true)]
}

function splitTextNode(node: HastText, find: Finder): HastNode[] | null {
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

function walk(node: HastParent | HastElement, find: Finder): void {
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
