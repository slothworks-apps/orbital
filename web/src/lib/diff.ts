/**
 * Line diff for the transcript's editing tool rows (spec:
 * 2026-09-23-edit-diffs-in-the-transcript). Pure, synchronous and bounded —
 * it runs inside a render, in a panel that is already animating its own
 * scroll (adr `the-transcript-scrolls-on-its-own-raf-loop`), so every path
 * through it has a ceiling.
 *
 * Why this is hand-written rather than a dependency: adr
 * `the-line-diff-is-ours`.
 */

/** What a rendered row is. */
export type DiffLineKind = 'context' | 'add' | 'del'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export interface DiffHunk {
  /**
   * Unchanged lines dropped between the previous hunk (or the start of the
   * text) and this one — drawn as one gap marker, never as rows.
   */
  skipped: number
  lines: DiffLine[]
}

export interface LineDiff {
  hunks: DiffHunk[]
  /** Unchanged lines dropped after the last hunk. Zeroed when `truncated`. */
  trailingSkipped: number
  added: number
  removed: number
  /**
   * The two sides differ at all. Usually `added + removed > 0`, but a change
   * that only adds or removes the final line break moves no row — see the
   * two `EndsWithNewline` flags.
   */
  changed: boolean
  /**
   * The two sides were too big, or too far apart, to align line by line, so
   * the changed region is reported as "all of this went, all of that came"
   * (`DIFF_MAX_LINES`, `DIFF_MAX_EDIT_DISTANCE`). The rows are still exact;
   * what is lost is the matching of unchanged lines *inside* the region.
   */
  coarse: boolean
  /** Rows were cut at `DIFF_MAX_RENDERED_LINES`. */
  truncated: boolean
  /** How many rows that cut dropped. */
  truncatedLines: number
  /**
   * Whether each side ended in a newline. They differ only when the change
   * itself added or removed the final line break, which no row can show — the
   * `\ No newline` footnote of every unified diff exists for the same reason.
   */
  beforeEndsWithNewline: boolean
  afterEndsWithNewline: boolean
}

/** Unchanged rows kept on each side of a change. */
export const DIFF_CONTEXT_LINES = 3

/**
 * Per side, after the common head and tail have been trimmed off. Above this
 * the alignment is not attempted at all: a replacement that large reads as a
 * replacement however it is aligned, and the cost of finding out is real.
 */
export const DIFF_MAX_LINES = 2000

/**
 * The `d` ceiling of the Myers walk — the number of single-line insertions
 * and deletions the alignment is allowed to cost before it gives up. Myers
 * is O((n+m)·d) in time and O(d²) in the recorded trace, so together with
 * `DIFF_MAX_LINES` this is what bounds the worst case (two large, wholly
 * unrelated texts) that would otherwise be paid for on the render path.
 * Past this many changed lines the diff is over `DIFF_MAX_RENDERED_LINES`
 * anyway, so the alignment being exact would buy nothing visible.
 */
export const DIFF_MAX_EDIT_DISTANCE = 400

/**
 * Rows a single diff may put in the DOM. The transcript re-reads
 * `scrollHeight` every animation frame while it is following a new message,
 * so an expanded row holding thousands of nodes is paid for on every one of
 * those frames, not once.
 */
export const DIFF_MAX_RENDERED_LINES = 400

/**
 * Text to lines, with the trailing empty element that `split` produces for a
 * text ending in a newline dropped — that element is punctuation, not a line,
 * and carrying it makes every whole-file comparison off by one. Whether the
 * newline was there is kept separately on the result.
 */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

interface Op {
  kind: DiffLineKind
  text: string
}

/**
 * Myers' greedy O(nd) walk with a recorded trace, returning the edit script
 * from `a` to `b`, or null when the distance exceeds `maxD`. The trace holds
 * one copy of the furthest-reaching frontier per round, which is what the
 * backtrack reads to turn "the distance is d" into "here is which line went
 * where".
 */
function myersOps(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  const bound = n + m
  // `k` runs over -bound..bound, so the frontier is indexed at `k + offset`.
  const offset = bound
  const size = 2 * bound + 1
  const trace: Int32Array[] = []
  const v = new Int32Array(size)

  for (let d = 0; d <= bound && d <= maxD; d += 1) {
    // Snapshot before the round, which is the state the backtrack of this
    // round's move has to read. Only the `-d..d` window is kept: everything
    // outside it is still zero at this point, and storing the whole frontier
    // every round is what makes a naive trace cost O(d·(n+m)) instead of
    // O(d²). Read back as `frontier[k + d]`.
    trace.push(v.slice(offset - d, offset + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]
      } else {
        x = v[k - 1 + offset] + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[k + offset] = x
      if (x >= n && y >= m) return backtrack(trace, a, b, d)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], a: string[], b: string[], d: number): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length

  for (let depth = d; depth > 0; depth -= 1) {
    // `trace[depth]` is the frontier as it stood before round `depth`, windowed
    // to `-depth..depth` — hence the `+ depth` rather than a global offset.
    const frontier = trace[depth]
    const k = x - y
    const prevK =
      k === -depth || (k !== depth && frontier[k - 1 + depth] < frontier[k + 1 + depth])
        ? k + 1
        : k - 1
    const prevX = frontier[prevK + depth]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x -= 1
      y -= 1
      ops.push({ kind: 'context', text: a[x] })
    }
    if (x === prevX) {
      y -= 1
      ops.push({ kind: 'add', text: b[y] })
    } else {
      x -= 1
      ops.push({ kind: 'del', text: a[x] })
    }
  }
  while (x > 0 && y > 0) {
    x -= 1
    y -= 1
    ops.push({ kind: 'context', text: a[x] })
  }

  ops.reverse()
  return ops
}

/** Changed rows plus `DIFF_CONTEXT_LINES` either side, runs that touch merged. */
function hunkify(lines: DiffLine[]): { hunks: DiffHunk[]; trailingSkipped: number } {
  const ranges: { start: number; end: number }[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].kind === 'context') continue
    const start = Math.max(0, i - DIFF_CONTEXT_LINES)
    const end = Math.min(lines.length - 1, i + DIFF_CONTEXT_LINES)
    const last = ranges[ranges.length - 1]
    // Touching ranges merge: a single unchanged row between two changes is
    // worth less as a gap marker than as the line it is.
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end)
    else ranges.push({ start, end })
  }
  if (ranges.length === 0) return { hunks: [], trailingSkipped: 0 }

  const hunks: DiffHunk[] = []
  let cursor = 0
  for (const range of ranges) {
    hunks.push({ skipped: range.start - cursor, lines: lines.slice(range.start, range.end + 1) })
    cursor = range.end + 1
  }
  return { hunks, trailingSkipped: lines.length - cursor }
}

/** Cuts the row list at `DIFF_MAX_RENDERED_LINES`, dropping whole hunks past it. */
function truncate(hunks: DiffHunk[]): { hunks: DiffHunk[]; dropped: number } {
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  if (total <= DIFF_MAX_RENDERED_LINES) return { hunks, dropped: 0 }

  const kept: DiffHunk[] = []
  let budget = DIFF_MAX_RENDERED_LINES
  for (const hunk of hunks) {
    if (budget === 0) break
    if (hunk.lines.length <= budget) {
      kept.push(hunk)
      budget -= hunk.lines.length
      continue
    }
    kept.push({ skipped: hunk.skipped, lines: hunk.lines.slice(0, budget) })
    budget = 0
  }
  return { hunks: kept, dropped: total - DIFF_MAX_RENDERED_LINES }
}

/**
 * The line diff of two texts. Both sides must be known — there is no honest
 * diff against a side Orbital does not have, and `lib/fileEdit.ts` is where
 * that distinction is made.
 */
export function diffLines(before: string, after: string): LineDiff {
  const a = splitLines(before)
  const b = splitLines(after)
  const beforeEndsWithNewline = before.endsWith('\n')
  const afterEndsWithNewline = after.endsWith('\n')

  // Trim what both sides share at the ends first. This is the whole reason a
  // two-line change inside a two-thousand-line string is cheap, and it also
  // keeps the Myers walk off the part of the text nobody touched.
  const limit = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < limit && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (suffix < limit - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix += 1
  }

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)

  const ops =
    midA.length > DIFF_MAX_LINES || midB.length > DIFF_MAX_LINES
      ? null
      : myersOps(midA, midB, DIFF_MAX_EDIT_DISTANCE)
  const coarse = ops === null
  const middle: Op[] = ops ?? [
    ...midA.map((text): Op => ({ kind: 'del', text })),
    ...midB.map((text): Op => ({ kind: 'add', text })),
  ]

  const lines: DiffLine[] = [
    ...a.slice(0, prefix).map((text): DiffLine => ({ kind: 'context', text })),
    ...middle,
    ...a.slice(a.length - suffix).map((text): DiffLine => ({ kind: 'context', text })),
  ]

  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added += 1
    else if (line.kind === 'del') removed += 1
  }

  const grouped = hunkify(lines)
  const cut = truncate(grouped.hunks)

  return {
    hunks: cut.hunks,
    trailingSkipped: cut.dropped > 0 ? 0 : grouped.trailingSkipped,
    added,
    removed,
    changed: added > 0 || removed > 0 || beforeEndsWithNewline !== afterEndsWithNewline,
    coarse,
    truncated: cut.dropped > 0,
    truncatedLines: cut.dropped,
    beforeEndsWithNewline,
    afterEndsWithNewline,
  }
}

/**
 * The diff pair: the only green and red the transcript keeps, for `+n` and
 * `−n` counts printed on a row (canvas `Feature - Transcript blocks` 20d-G).
 * Shared so the detail header's line changes (canvas `Feature - Branch
 * status` 1h, "no new hue") are the same two inks, not a near copy.
 */
export const DIFF_ADDED_INK_CLASS = 'text-[oklch(82%_.14_145)]'
export const DIFF_REMOVED_INK_CLASS = 'text-[oklch(72%_.15_22)]'
