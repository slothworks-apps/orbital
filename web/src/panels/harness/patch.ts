/**
 * Parses the `git diff <range>` text the step-diff route answers with into
 * files, hunks and numbered lines, for the record's diff view (canvas 30e,
 * 30h). The route sends one unified patch; the view needs per-file stats for
 * its file list and a line number per row.
 */

export type PatchLineKind = 'add' | 'del' | 'context'

export interface PatchLine {
  kind: PatchLineKind
  text: string
  /** The new file's line for `add` and `context`, the old file's for `del` — the one column 30e shows. */
  line: number
}

export interface PatchHunk {
  header: string
  lines: PatchLine[]
}

export interface PatchFile {
  /** The new path; the old one for a deleted file. */
  path: string
  /** Set when the file was renamed or copied. */
  oldPath?: string
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  binary: boolean
  added: number
  removed: number
  hunks: PatchHunk[]
}

export interface ParsedPatch {
  files: PatchFile[]
  added: number
  removed: number
  /** The server cut the patch at its size cap. */
  cut: boolean
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** `a/foo` → `foo`; a quoted path loses its quotes. */
function stripPrefix(raw: string): string {
  let path = raw.trim()
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
  if (path.startsWith('a/') || path.startsWith('b/')) path = path.slice(2)
  return path
}

export function parsePatch(patch: string): ParsedPatch {
  const files: PatchFile[] = []
  let file: PatchFile | null = null
  let hunk: PatchHunk | null = null
  let oldNo = 0
  let newNo = 0
  let cut = false

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // `diff --git a/x b/x`: the b-side is the path unless a later header says otherwise.
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(raw)
      file = { path: m ? m[2] : raw.slice(11), status: 'modified', binary: false, added: 0, removed: 0, hunks: [] }
      if (m && m[1] !== m[2]) file.oldPath = m[1]
      files.push(file)
      hunk = null
      continue
    }
    if (raw.startsWith('… (cut')) {
      cut = true
      continue
    }
    if (!file) continue

    const m = HUNK.exec(raw)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[2])
      hunk = { header: raw, lines: [] }
      file.hunks.push(hunk)
      continue
    }

    if (!hunk) {
      // The file's header block.
      if (raw.startsWith('new file mode')) file.status = 'added'
      else if (raw.startsWith('deleted file mode')) file.status = 'deleted'
      else if (raw.startsWith('rename from ')) {
        file.status = 'renamed'
        file.oldPath = raw.slice('rename from '.length)
      } else if (raw.startsWith('rename to ')) file.path = raw.slice('rename to '.length)
      else if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') file.binary = true
      else if (raw.startsWith('--- ') && raw !== '--- /dev/null' && file.status === 'deleted') file.path = stripPrefix(raw.slice(4))
      else if (raw.startsWith('+++ ') && raw !== '+++ /dev/null') file.path = stripPrefix(raw.slice(4))
      continue
    }

    if (raw.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: raw.slice(1), line: newNo++ })
      file.added++
    } else if (raw.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: raw.slice(1), line: oldNo++ })
      file.removed++
    } else if (raw.startsWith(' ')) {
      hunk.lines.push({ kind: 'context', text: raw.slice(1), line: newNo++ })
      oldNo++
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — about the line before, not a line.
    } else if (raw === '') {
      // The patch's trailing newline, or a blank context line some tools strip the space of.
    }
  }

  return {
    files,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    cut,
  }
}

/** How many of a file's lines 30e shows before folding the rest into "⋯ n more lines". */
export const FILE_FOLD_LINES = 40

/** A file's rows up to `limit` lines, hunk headers kept; `more` is what was folded. */
export function foldFile(file: PatchFile, limit: number): { hunks: PatchHunk[]; more: number } {
  const hunks: PatchHunk[] = []
  let left = limit
  let more = 0
  for (const h of file.hunks) {
    if (left <= 0) {
      more += h.lines.length
      continue
    }
    const take = h.lines.slice(0, left)
    more += h.lines.length - take.length
    left -= take.length
    hunks.push({ header: h.header, lines: take })
  }
  return { hunks, more }
}
