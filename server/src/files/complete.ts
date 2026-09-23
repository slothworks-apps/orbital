import { readdirSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { resolveInsideCwd } from './preview.js'

/**
 * Path completion for the composer's `@` popup
 * (spec: 2026-09-20-composer-design § Path completion), with the editor's open
 * tabs ranked above the walk of the working tree
 * (spec: 2026-09-23-ide-bridge-design § Open files, for `@` completion).
 *
 * The session's cwd is the sandbox, held by the same `resolveInsideCwd` the
 * file viewer's read uses. Anything outside it, or a directory that is not
 * there, answers an empty list rather than an error: a popup fed by keystrokes
 * asks about half-typed paths constantly, and half of them name nothing yet.
 */

/** Six rows are visible at a time; fifty is well past what anyone scrolls
 * through before typing another character, and it keeps one `readdir` of a
 * `node_modules` from becoming a megabyte of JSON. */
export const FILE_COMPLETE_MAX = 50

/**
 * How many open tabs a bare `@` offers. Short on purpose: the list is meant to
 * be read at a glance rather than scrolled, and anything longer is better
 * reached by typing (canvas `Feature - IDE bridge` 20c).
 */
export const BARE_AT_TAB_MAX = 6

export interface CompletionEntry {
  /** The base name, which is what the row prints. */
  name: string
  dir: boolean
  /** Files only — a directory's size is a number about the inode, not about
   * what is in it, and the popup shows `DIR · N ITEMS` instead. */
  size?: number
  /**
   * The row's path relative to the session's `cwd`, present ONLY when the row
   * does not live in the directory the prefix names — an open tab reached by
   * its base name from somewhere else in the tree. Absent means the caller can
   * derive it, as it always could: the prefix's directory part plus `name`.
   */
  path?: string
  /** Open in the editor right now (spec § Open files). Absent means not. */
  open?: boolean
  /**
   * The tab the caret is in. It wears the caret bar the editor slot wears, so
   * the same glyph means "cursor is here" in both places (canvas
   * `Feature - IDE bridge` 20c).
   */
  active?: boolean
  /** The caret's line in the active tab — what its mark slot reads (20c). */
  line?: number
}

/**
 * The editor's tabs as the ranking reads them: absolute paths in the
 * extension's own order, and which of them the caret is in.
 *
 * The order is deliberately NOT recency — the extension does not report any,
 * measured 2026-09-23 (spec § Open files). It is the order the tabs sit in,
 * which is the order the person can see in their own tab bar.
 */
export interface OpenTabs {
  /**
   * The tab the caret is in, absolute, or null. Known from `selection_changed`'s
   * `filePath`, which arrives on a bare cursor move and needs no selection.
   */
  activePath: string | null
  /** The caret's line in the active tab, 1-based, or null. */
  activeLine?: number | null
  /** Every open tab, absolute, in the editor's own order. */
  paths: readonly string[]
}

/** One row while it is being built: the entry plus the key it is deduped by. */
interface Row {
  rel: string
  entry: CompletionEntry
}

/**
 * Whether an open tab answers what has been typed.
 *
 * Two readings, and the second is the whole point of the feature: a tab whose
 * path relative to the `cwd` starts with the prefix (so `@src/Det` still walks
 * the tree the way it reads), and — only when the prefix names no directory at
 * all — a tab whose BASE name starts with it, which is what makes `@Det` find
 * `web/src/panels/DetailPanel.tsx` without anyone typing the four directories
 * in front of it.
 *
 * The base-name reading is withheld once a directory has been typed, because
 * then the person is navigating and a row from an unrelated branch of the tree
 * would be an answer to a question they did not ask.
 */
function tabMatches(rel: string, prefix: string, hasDirPart: boolean): boolean {
  if (rel.startsWith(prefix)) return true
  return !hasDirPart && basename(rel).startsWith(prefix)
}

/**
 * The tabs in the order they should be offered: the active one first, then the
 * rest in the editor's order, each path once.
 */
function rankedTabs(tabs: OpenTabs): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of [...(tabs.activePath ? [tabs.activePath] : []), ...tabs.paths]) {
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/** Path separators as the wire spells them, so a key compares on any platform. */
function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

/**
 * Entries under the directory `prefix` names, whose own names start with what
 * `prefix` ends with, with the editor's open tabs lifted to the top.
 *
 * The split is the last separator: `src/comp` lists `src` for names beginning
 * `comp`, `src/` lists all of `src`, and a bare `comp` lists the project root.
 * Dotfiles appear only when the base itself starts with a dot — a directory
 * full of `.env`, `.git` and `.DS_Store` is not what someone typing `@` meant,
 * but `@.env` plainly is.
 *
 * `tabs` is the one optional part, and every kind of "no editor" arrives here
 * as null or as an empty list: the result is then byte-for-byte what this
 * function answered before the bridge existed (spec § When there is no editor).
 */
export function completeFilePath(
  cwd: string,
  prefix: string,
  tabs?: OpenTabs | null,
): CompletionEntry[] {
  const cut = prefix.lastIndexOf('/')
  const dirPart = cut === -1 ? '' : prefix.slice(0, cut + 1)
  const base = cut === -1 ? prefix : prefix.slice(cut + 1)

  // '.' rather than '' so the root case resolves to cwd itself.
  const confined = resolveInsideCwd(cwd, dirPart || '.')
  const wantDotfiles = base.startsWith('.')

  const listed: Row[] = []
  if (confined.kind === 'ok') {
    let names: string[]
    try {
      names = readdirSync(confined.path)
    } catch {
      // The prefix named a file, or something unreadable. Not an error — the
      // popup simply has nothing to offer.
      names = []
    }
    for (const name of names) {
      if (!name.startsWith(base)) continue
      if (!wantDotfiles && name.startsWith('.')) continue
      let stat
      try {
        stat = statSync(join(confined.path, name))
      } catch {
        // A broken symlink or a file deleted between readdir and stat.
        continue
      }
      listed.push({
        rel: dirPart + name,
        entry: stat.isDirectory() ? { name, dir: true } : { name, dir: false, size: stat.size },
      })
    }
    // Directories first, then alphabetical within each group — the same order
    // the popup draws, so the cap below takes the rows a person would have
    // scrolled to rather than an arbitrary slice of the readdir order.
    listed.sort((a, b) =>
      a.entry.dir === b.entry.dir ? a.entry.name.localeCompare(b.entry.name) : a.entry.dir ? -1 : 1,
    )
  }

  if (!tabs || tabs.paths.length === 0) {
    if (confined.kind !== 'ok') return []
    return listed.slice(0, FILE_COMPLETE_MAX).map((row) => row.entry)
  }

  // The `cwd`'s own real path, so a tab reported through a symlinked root
  // still lands on the same key the directory walk produced.
  const rootProbe = resolveInsideCwd(cwd, '.')
  const root = rootProbe.kind === 'ok' ? rootProbe.path : null

  const byRel = new Map(listed.map((row) => [row.rel, row]))
  const taken = new Set<string>()
  const ranked: CompletionEntry[] = []

  for (const abs of rankedTabs(tabs)) {
    if (root === null) break
    const resolved = resolveInsideCwd(cwd, abs)
    // Outside the sandbox, or gone since the editor listed it. The sandbox
    // rule wins over the editor's idea of what is interesting.
    if (resolved.kind !== 'ok') continue
    const rel = toPosix(relative(root, resolved.path))
    if (rel === '' || rel.startsWith('..')) continue
    if (!tabMatches(rel, prefix, cut !== -1)) continue
    const name = basename(rel)
    if (!wantDotfiles && name.startsWith('.')) continue
    if (taken.has(rel)) continue

    // The caret's tab wears its own mark and reads its line rather than its
    // size — "a file you have open you don't need weighed" (20c).
    const isActive = abs === tabs.activePath
    const mark = {
      open: true as const,
      ...(isActive ? { active: true as const } : {}),
      ...(isActive && typeof tabs.activeLine === 'number' ? { line: tabs.activeLine } : {}),
    }

    const existing = byRel.get(rel)
    if (existing) {
      // The same file the walk already found: one row, marked and lifted, not
      // a second one (canvas `Feature - IDE bridge` 20c — no second list).
      taken.add(rel)
      ranked.push({ ...existing.entry, ...mark })
      continue
    }

    let stat
    try {
      stat = statSync(resolved.path)
    } catch {
      continue
    }
    if (stat.isDirectory()) continue
    taken.add(rel)
    ranked.push({
      name,
      dir: false,
      size: stat.size,
      // Only when the row does not live where the prefix points — otherwise
      // the caller derives it, exactly as it did before open tabs existed.
      ...(dirPart + name === rel ? {} : { path: rel }),
      ...mark,
    })
  }

  // A bare `@` is a different question from `@Det`. It asks "what can I point
  // at", and with an editor open the honest answer is what you are looking at
  // — not the project root in alphabetical order, which for most repositories
  // begins with build directories and dotfiles (canvas `Feature - IDE bridge`
  // 20c: "bare @ — open tabs only, up to 6"). The tree is one keystroke away
  // and that keystroke is the one you were about to type anyway, so no
  // affordance is spent saying so.
  if (prefix === '' && ranked.length > 0) return ranked.slice(0, BARE_AT_TAB_MAX)

  const rest = listed.filter((row) => !taken.has(row.rel)).map((row) => row.entry)
  return [...ranked, ...rest].slice(0, FILE_COMPLETE_MAX)
}
