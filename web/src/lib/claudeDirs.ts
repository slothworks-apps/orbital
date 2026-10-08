import type { ClaudeDirRefusal } from './api'
import type { ClaudeDirName } from './types'

/** Where the New session choice was prefilled from — the hint beside its label (canvas 44c, 44d). */
export type ClaudeDirPrefillSource = 'planet' | 'last' | 'default' | 'first'

/**
 * The Claude directory a new session opens on, and which step chose it,
 * shared by the desktop's New session dialog and the phone's screen (spec
 * 2026-10-04-multiple-claude-directories-design § 3): the selected planet's
 * directory, then the last launch's choice, then the default. A directory
 * removed since, or missing on disk (it cannot be chosen, canvas 44f), falls
 * through to the next step; with none of the three usable, the first usable
 * directory there is, else the first at all. Null only when there are no
 * directories (a Mac from before the feature).
 */
export function claudeDirPrefill(input: {
  dirs: readonly ClaudeDirName[]
  planet: number | null | undefined
  last: number | null | undefined
  fallback: number | null | undefined
}): { id: number; from: ClaudeDirPrefillSource } | null {
  const { dirs, planet, last, fallback } = input
  const steps: Array<[number | null | undefined, ClaudeDirPrefillSource]> = [
    [planet, 'planet'],
    [last, 'last'],
    [fallback, 'default'],
  ]
  for (const [id, from] of steps) {
    if (id != null && dirs.some((d) => d.id === id && claudeDirChoosable(d))) return { id, from }
  }
  const first = dirs.find(claudeDirChoosable) ?? dirs[0]
  return first ? { id: first.id, from: 'first' } : null
}

/** `claudeDirPrefill`'s directory alone. */
export function openingClaudeDir(input: Parameters<typeof claudeDirPrefill>[0]): number | null {
  return claudeDirPrefill(input)?.id ?? null
}

/**
 * A directory can be launched under unless it is known to be missing on disk.
 * A Mac from before the presence was sent says nothing, and that is choosable.
 */
export function claudeDirChoosable(dir: ClaudeDirName): boolean {
  return dir.exists !== false
}

/**
 * ⌘D in New session (canvas 44f "Keyboard"): the next directory after
 * `current` in Settings order, skipping missing ones and wrapping around.
 * `current` itself when nothing else can be chosen.
 */
export function nextClaudeDir(dirs: readonly ClaudeDirName[], current: number | null): number | null {
  const start = dirs.findIndex((d) => d.id === current)
  for (let step = 1; step <= dirs.length; step++) {
    const dir = dirs[(start + step + dirs.length) % dirs.length]
    if (dir && claudeDirChoosable(dir)) return dir.id
  }
  return current
}

/** The words of a directory name, as the monogram reads them. */
function nameWords(name: string): string[] {
  return name.trim().split(/\s+/).filter(Boolean)
}

/** The first `n` characters of a word, by code point, so an emoji or an accented letter is not split. */
function lead(word: string | undefined, n: number): string {
  return Array.from(word ?? '')
    .slice(0, n)
    .join('')
}

/**
 * Every directory's monogram (canvas 44f "Monogram"): the first letter of the
 * first word; on a clash with another directory, the initials of the first
 * two words; and a one-word name the first two letters — unless its clash is
 * already gone once the longer names took their initials ("Work" beside "Work
 * Enterprise" stays W, beside WE; "Personal" beside "Playground" is PE, PL).
 * Uppercase, at most two characters, derived again on every rename.
 */
export function claudeDirMonograms(dirs: readonly ClaudeDirName[]): Map<number, string> {
  const words = new Map(dirs.map((d) => [d.id, nameWords(d.name)]))
  const first = new Map(dirs.map((d) => [d.id, lead(words.get(d.id)?.[0], 1).toUpperCase() || '?']))
  const clashes = (id: number, of: Map<number, string>) =>
    dirs.some((o) => o.id !== id && of.get(o.id) === of.get(id))

  // A name of two or more words takes its initials on a clash.
  const initials = new Map(first)
  for (const d of dirs) {
    const w = words.get(d.id) ?? []
    if (w.length >= 2 && clashes(d.id, first)) initials.set(d.id, (lead(w[0], 1) + lead(w[1], 1)).toUpperCase())
  }
  // A one-word name that still clashes takes its first two letters.
  const out = new Map(initials)
  for (const d of dirs) {
    const w = words.get(d.id) ?? []
    if (w.length < 2 && clashes(d.id, initials)) out.set(d.id, lead(w[0], 2).toUpperCase() || '?')
  }
  return out
}

/**
 * A directory's path as it is shown: `~` for the home directory, the way the
 * canvas and a shell write it. The server sends absolute paths and the web
 * does not know the home directory, so it is recognised by the macOS and
 * Linux convention (`/Users/<name>`, `/home/<name>`); any other path is shown
 * as it is.
 */
export function claudeDirDisplayPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/**
 * The mark's tooltip (canvas 44f "Tooltip"): `Claude directory: Work ·
 * ~/.claude-work · jan@acme.com`, the path and the e-mail only when known.
 */
export function claudeDirTooltip(dir: ClaudeDirName): string {
  return [`Claude directory: ${dir.name}`, dir.path ? claudeDirDisplayPath(dir.path) : null, dir.account ?? null]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The line under a directory's name in a picker (canvas 44c, 44d): its path
 * and account, or that it is missing on disk.
 */
export function claudeDirSubline(dir: ClaudeDirName): string {
  if (!claudeDirChoosable(dir)) return 'not found on disk'
  return [dir.path ? claudeDirDisplayPath(dir.path) : null, dir.account ?? null].filter(Boolean).join(' · ')
}

/** What a directory mark draws: the monogram, the name beside it, and the tooltip. */
export interface ClaudeDirMarkInfo {
  id: number
  mono: string
  name: string
  title: string
}

/**
 * A session's directory mark when it is worth showing: only with two or more
 * directories configured (§ 8, canvas 44f "One directory" — with one, nothing
 * changes anywhere). Null for a session of a directory the list does not hold.
 */
export function claudeDirMark(
  dirs: readonly ClaudeDirName[],
  claudeDirId: number | null | undefined,
  monograms: Map<number, string> = claudeDirMonograms(dirs),
): ClaudeDirMarkInfo | null {
  if (dirs.length < 2 || claudeDirId == null) return null
  const dir = dirs.find((d) => d.id === claudeDirId)
  if (!dir) return null
  return { id: dir.id, mono: monograms.get(dir.id) ?? '?', name: dir.name, title: claudeDirTooltip(dir) }
}

/** A refused directory change, as one plain sentence for the Settings row. */
export function claudeDirRefusalSentence(error: ClaudeDirRefusal): string {
  switch (error) {
    case 'path_required':
      return 'Enter the directory’s path.'
    case 'not_absolute':
      return 'The path has to be absolute — start it with / or ~/.'
    case 'no_such_directory':
      return 'There is no directory at that path.'
    case 'not_a_directory':
      return 'That path is a file, not a directory.'
    case 'duplicate':
      return 'That directory is already in the list.'
    case 'name_required':
      return 'Give the directory a name.'
    case 'not_found':
      return 'That directory was removed in the meantime.'
    case 'last_directory':
      return 'The last directory cannot be removed.'
  }
}
