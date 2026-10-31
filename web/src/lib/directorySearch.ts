import { homePath } from './format'
import { leafOf } from './whereForm'

/** One row of `GET /api/projects`: a directory a session ran in. */
export interface DirectoryRow {
  cwd: string
  lastModel: string | null
  lastAt: number | null
}

/** How many directories the list shows before anything is typed. */
export const RECENT_DIRECTORIES = 10

/** A stretch of text to fill as the match: `[start, end)`. */
export type Mark = readonly [number, number]

/** A row of the suggestion list: the directory, how it prints, and where the query hit it. */
export interface DirectoryMatch {
  row: DirectoryRow
  /** The last segment. */
  name: string
  /** The full path, home as `~`. */
  path: string
  nameMarks: Mark[]
  pathMarks: Mark[]
}

/**
 * The suggestion list under the New session directory field, on the desktop
 * and on the phone (canvas `Feature - Directory suggestions`). Nothing typed:
 * the first `RECENT_DIRECTORIES` rows. Otherwise the query splits on spaces
 * and every word must appear somewhere in the full path — written out or
 * from `~`, case-insensitive — so `sloth orb` and `slothworks/orb` both find
 * `~/Projects/slothworks/orbital`. Rows keep the route's order, most recent
 * first. A word found in the name is filled there; one found only in the
 * rest of the path is filled in the path.
 */
export function searchDirectories(projects: readonly DirectoryRow[], query: string): DirectoryMatch[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return projects.slice(0, RECENT_DIRECTORIES).map((row) => describe(row, []))
  const out: DirectoryMatch[] = []
  for (const row of projects) {
    const full = row.cwd.toLowerCase()
    const home = homePath(row.cwd).toLowerCase()
    if (words.every((w) => home.includes(w) || full.includes(w))) out.push(describe(row, words))
  }
  return out
}

function describe(row: DirectoryRow, words: readonly string[]): DirectoryMatch {
  const path = homePath(row.cwd)
  const name = leafOf(path) || path
  const nameLower = name.toLowerCase()
  const pathLower = path.toLowerCase()
  const nameMarks: Mark[] = []
  const pathMarks: Mark[] = []
  for (const w of words) {
    const inName = nameLower.indexOf(w)
    if (inName >= 0) {
      nameMarks.push([inName, inName + w.length])
      continue
    }
    // A word written out from `/Users/…` matches the full path but not the `~` one printed: nothing to fill.
    const inPath = pathLower.indexOf(w)
    if (inPath >= 0) pathMarks.push([inPath, inPath + w.length])
  }
  return { row, name, path, nameMarks: merge(nameMarks), pathMarks: merge(pathMarks) }
}

/** Sorted, overlapping or touching marks joined into one. */
function merge(marks: Mark[]): Mark[] {
  const sorted = [...marks].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const [s, e] of sorted) {
    const last = out[out.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** `text` cut at `marks`, for rendering: each piece and whether it is filled. */
export function markedPieces(text: string, marks: readonly Mark[]): Array<{ text: string; marked: boolean }> {
  const out: Array<{ text: string; marked: boolean }> = []
  let at = 0
  for (const [s, e] of marks) {
    if (s > at) out.push({ text: text.slice(at, s), marked: false })
    out.push({ text: text.slice(s, e), marked: true })
    at = e
  }
  if (at < text.length) out.push({ text: text.slice(at), marked: false })
  return out
}
