/** Where a link inside a previewed markdown file leads (spec 2026-10-23-phone-text-preview § Behaviour 6). */
export type MarkdownLink =
  | { kind: 'web'; url: string }
  /** The previewed file itself, at a line: the preview switches to Source there. */
  | { kind: 'same'; line: number }
  | { kind: 'file'; path: string; line: number | null }
  /** A bare `#anchor`, or nothing at all — the press does nothing. */
  | { kind: 'none' }

const WEB = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:)/i
/** `notes.md:42`, `notes.md:42:7`, or GitHub's `notes.md#L42`. */
const LINE = /(?::(\d+)(?::\d+)?|#L(\d+))$/

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut >= 0 ? path.slice(0, cut + 1) : ''
}

/** Folds `.` and `..` segments; a `..` that climbs above a relative path's start is kept. */
function normalize(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else if (part !== '..' || !absolute) out.push(part)
  }
  return (absolute ? '/' : '') + out.join('/')
}

/**
 * Resolves `href`, as written in the markdown file at `filePath`, the way a
 * reader of that file means it: a relative link is read against the file's
 * own directory, not the session's.
 */
export function markdownLink(href: string | undefined, filePath: string): MarkdownLink {
  if (!href) return { kind: 'none' }
  if (WEB.test(href)) return { kind: 'web', url: href }

  let target = href
  let line: number | null = null
  const lineMatch = LINE.exec(target)
  if (lineMatch) {
    line = Number(lineMatch[1] ?? lineMatch[2])
    target = target.slice(0, lineMatch.index)
  }
  const hash = target.indexOf('#')
  if (hash >= 0) target = target.slice(0, hash)
  const query = target.indexOf('?')
  if (query >= 0) target = target.slice(0, query)
  if (!target) return { kind: 'none' }

  try {
    target = decodeURIComponent(target)
  } catch {
    // A stray `%` is just a character in the path.
  }

  const path = normalize(target.startsWith('/') ? target : dirOf(filePath) + target)
  if (path === normalize(filePath)) return line !== null ? { kind: 'same', line } : { kind: 'none' }
  return { kind: 'file', path, line }
}
