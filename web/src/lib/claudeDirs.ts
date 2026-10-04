import type { ClaudeDirRefusal } from './api'
import type { ClaudeDirName } from './types'

/**
 * The Claude directory a new session opens on, shared by the desktop's New
 * session dialog and the phone's screen (spec
 * 2026-10-04-multiple-claude-directories-design § 3): the selected planet's
 * directory, then the last launch's choice, then the default. A directory
 * removed since falls through to the next step; with none of the three
 * configured, the first directory there is. Null only when there are no
 * directories at all (a Mac from before the feature).
 */
export function openingClaudeDir(input: {
  dirs: readonly ClaudeDirName[]
  planet: number | null | undefined
  last: number | null | undefined
  fallback: number | null | undefined
}): number | null {
  const { dirs, planet, last, fallback } = input
  for (const id of [planet, last, fallback]) {
    if (id != null && dirs.some((d) => d.id === id)) return id
  }
  return dirs[0]?.id ?? null
}

/**
 * A session's directory name when it is worth showing: only with two or more
 * directories configured (§ 8 — with one, nothing changes anywhere). Null for
 * a session of a directory the list does not hold.
 */
export function claudeDirLabel(dirs: readonly ClaudeDirName[], claudeDirId: number | undefined): string | null {
  if (dirs.length < 2 || claudeDirId === undefined) return null
  return dirs.find((d) => d.id === claudeDirId)?.name ?? null
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
