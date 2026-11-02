import type { ApiSession } from './types'
import { workingDirOf } from './types'

/**
 * Which rows a path's context menu draws (spec
 * 2026-11-02-bare-file-names-and-path-menu-design § The context menu; canvas
 * `Feature - Path menu glyphs` 1b). Pure, so the menu only draws it.
 */

export type PathAction =
  | { kind: 'copy' }
  | { kind: 'copy-relative' }
  /** `id` off the session's `ides`. */
  | { kind: 'editor'; id: string; name: string }
  | { kind: 'finder' }
  | { kind: 'mention' }

export interface PathMenuFacts {
  /** The file was located, so a relative path for it is known. */
  relative: boolean
  /** The editors that have the file's workspace open, last used first. */
  editors: readonly { id: string; name: string }[]
  /** Show in Finder is on offer: the desktop app, a session on this Mac. */
  finder: boolean
  /** The session has a composer here to mention the file in. */
  mention: boolean
}

/**
 * Three groups, in the table's order (1b): the copies; the editors and
 * Finder; Mention in reply. An empty group is left out, so the separator the
 * menu draws between groups only ever stands between two that have rows — the
 * browser with no editor gets three rows and one hairline.
 */
export function pathMenuGroups(facts: PathMenuFacts): PathAction[][] {
  const copies: PathAction[] = [{ kind: 'copy' }]
  if (facts.relative) copies.push({ kind: 'copy-relative' })
  const elsewhere: PathAction[] = facts.editors.map((editor) => ({ kind: 'editor', id: editor.id, name: editor.name }))
  if (facts.finder) elsewhere.push({ kind: 'finder' })
  const reply: PathAction[] = facts.mention ? [{ kind: 'mention' }] : []
  return [copies, elsewhere, reply].filter((group) => group.length > 0)
}

/**
 * Whether an editor whose workspace is `workspaceRoot` can open `path`
 * (canvas `Feature - IDE bridge` 20d, "only when it'd work"). A relative path
 * is one the session wrote about its own `cwd`, which sits inside the
 * workspace by construction — so only an absolute path is checked.
 */
export function insideWorkspace(path: string, workspaceRoot: string): boolean {
  if (!path.startsWith('/')) return true
  return path === workspaceRoot || path.startsWith(`${workspaceRoot}/`)
}

/**
 * The editors that can open `path`, in the session's order (last used first).
 * Only for a session on this device: another device's editor is not here to
 * send a path to.
 */
export function editorsFor(
  session: Pick<ApiSession, 'machine' | 'ides'> | undefined,
  path: string,
): { id: string; name: string }[] {
  if (!session || session.machine) return []
  return (session.ides ?? [])
    .filter((editor) => insideWorkspace(path, editor.workspaceRoot))
    .map((editor) => ({ id: editor.id, name: editor.ideName }))
}

/** `path` relative to the deepest of `roots` it lies under, or null when it lies under none. */
export function relativeUnder(path: string, roots: readonly string[]): string | null {
  let best: string | null = null
  for (const raw of roots) {
    const root = raw.replace(/\/+$/, '')
    if (root === '' || !path.startsWith(`${root}/`)) continue
    if (best === null || root.length > best.length) best = root
  }
  return best === null ? null : path.slice(best.length + 1)
}

/**
 * The trees a session's paths are relative to: the working tree it works in
 * now, the trees its running subagents work in, and its home (spec
 * 2026-10-07-live-working-tree-design § 2). Each is a working-tree root in
 * git and the directory itself outside it — the roots Copy relative path
 * measures against.
 */
export function treeRoots(session: Pick<ApiSession, 'cwd' | 'workingDir' | 'otherTrees'>): string[] {
  return [workingDirOf(session), ...(session.otherTrees ?? []).map((tree) => tree.root), session.cwd]
}

/**
 * The mention Mention in reply inserts: `@path`, with `:line` when the link
 * carried one. Relative to the session's working directory — what the CLI
 * and the composer's own completion resolve a mention against — and absolute
 * when the file lies outside it. A path never located stays as written.
 */
export function mentionOf(path: string, line: number | null, workingDir: string): { text: string; path: string } {
  const relative = path.startsWith('/') ? relativeUnder(path, [workingDir]) : null
  const mentioned = relative ?? path
  return { text: `@${mentioned}${line !== null ? `:${line}` : ''}`, path: mentioned }
}
