import { describe, expect, it } from 'vitest'
import {
  DIFF_CONTEXT_LINES,
  DIFF_MAX_EDIT_DISTANCE,
  DIFF_MAX_LINES,
  DIFF_MAX_RENDERED_LINES,
  diffLines,
  splitLines,
  type DiffLine,
} from '../lib/diff'
import { changeCounts, describeFileChange, writeOutcome, type FileChange } from '../lib/fileEdit'

/** Every rendered row of a diff, hunks flattened, for assertions that do not
 *  care where the hunk boundaries fell. */
function rows(diff: ReturnType<typeof diffLines>): DiffLine[] {
  return diff.hunks.flatMap((hunk) => hunk.lines)
}

/** `+a/-d/ c` shorthand so an expected diff reads as one string. */
function sketch(diff: ReturnType<typeof diffLines>): string {
  return rows(diff)
    .map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`)
    .join('\n')
}

const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n')

describe('splitLines', () => {
  it('treats the newline that ends a text as punctuation, not as a line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
  })

  it('distinguishes empty text from one empty line', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('\n')).toEqual([''])
    expect(splitLines('\n\n')).toEqual(['', ''])
  })
})

describe('diffLines', () => {
  it('reports no change for identical texts', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nb\nc\n')
    expect(diff.changed).toBe(false)
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(0)
    expect(diff.hunks).toEqual([])
  })

  it('aligns a one-line change and keeps context either side', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(sketch(diff)).toBe([' a', '-b', '+B', ' c'].join('\n'))
  })

  it('shows a pure insertion as additions only', () => {
    const diff = diffLines('a\nc\n', 'a\nb\nc\n')
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(0)
    expect(sketch(diff)).toBe([' a', '+b', ' c'].join('\n'))
  })

  it('shows a pure deletion as removals only', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nc\n')
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(1)
    expect(sketch(diff)).toBe([' a', '-b', ' c'].join('\n'))
  })

  it('handles a whole-text replacement with nothing in common', () => {
    const diff = diffLines('a\nb\n', 'x\ny\n')
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(2)
    expect(rows(diff).every((line) => line.kind !== 'context')).toBe(true)
    expect(diff.coarse).toBe(false)
  })

  it('handles a change on the very first line', () => {
    const diff = diffLines('a\nb\nc\n', 'A\nb\nc\n')
    expect(sketch(diff)).toBe(['-a', '+A', ' b', ' c'].join('\n'))
    expect(diff.hunks[0].skipped).toBe(0)
  })

  it('handles a change on the very last line', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nb\nC\n')
    expect(sketch(diff)).toBe([' a', ' b', '-c', '+C'].join('\n'))
    expect(diff.trailingSkipped).toBe(0)
  })

  it('creates a whole text out of nothing', () => {
    const diff = diffLines('', 'a\nb\n')
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(0)
    expect(sketch(diff)).toBe(['+a', '+b'].join('\n'))
  })

  it('empties a whole text', () => {
    const diff = diffLines('a\nb\n', '')
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(2)
  })

  it('sees a trailing newline appearing even though no row moves', () => {
    const diff = diffLines('a\nb', 'a\nb\n')
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(0)
    expect(diff.hunks).toEqual([])
    expect(diff.changed).toBe(true)
    expect(diff.beforeEndsWithNewline).toBe(false)
    expect(diff.afterEndsWithNewline).toBe(true)
  })

  it('sees a trailing newline disappearing', () => {
    const diff = diffLines('a\nb\n', 'a\nb')
    expect(diff.changed).toBe(true)
    expect(diff.beforeEndsWithNewline).toBe(true)
    expect(diff.afterEndsWithNewline).toBe(false)
  })

  it('does not call a newline change on an empty side a change', () => {
    expect(diffLines('', '').changed).toBe(false)
  })

  it('distinguishes a blank line being added from a trailing newline', () => {
    const diff = diffLines('a\n', 'a\n\n')
    expect(diff.added).toBe(1)
    expect(rows(diff).at(-1)).toEqual({ kind: 'add', text: '' })
  })

  it('keeps exactly DIFF_CONTEXT_LINES of context and drops the rest into a gap', () => {
    const before = `${lines(40)}\n`
    const after = before.replace('line 20', 'LINE 20')
    const diff = diffLines(before, after)

    expect(diff.hunks).toHaveLength(1)
    const hunk = diff.hunks[0]
    // Context before, the -/+ pair, context after.
    expect(hunk.lines).toHaveLength(DIFF_CONTEXT_LINES * 2 + 2)
    expect(hunk.skipped).toBe(20 - DIFF_CONTEXT_LINES)
    expect(diff.trailingSkipped).toBe(40 - 21 - DIFF_CONTEXT_LINES)
  })

  it('splits distant changes into separate hunks and merges touching ones', () => {
    const before = `${lines(40)}\n`
    const far = before.replace('line 5', 'LINE 5').replace('line 30', 'LINE 30')
    expect(diffLines(before, far).hunks).toHaveLength(2)

    // Changes a single unchanged line apart share one hunk rather than
    // putting a "1 unchanged line" marker between them.
    const near = before.replace('line 5', 'LINE 5').replace('line 7', 'LINE 7')
    expect(diffLines(before, near).hunks).toHaveLength(1)
  })

  it('counts every changed line even when only some are rendered', () => {
    const before = lines(DIFF_MAX_RENDERED_LINES * 2, 'old')
    const after = lines(DIFF_MAX_RENDERED_LINES * 2, 'new')
    const diff = diffLines(before, after)

    expect(diff.added).toBe(DIFF_MAX_RENDERED_LINES * 2)
    expect(diff.removed).toBe(DIFF_MAX_RENDERED_LINES * 2)
    expect(diff.truncated).toBe(true)
    expect(rows(diff)).toHaveLength(DIFF_MAX_RENDERED_LINES)
    expect(diff.truncatedLines).toBe(diff.added + diff.removed - DIFF_MAX_RENDERED_LINES)
    // The truncation note replaces the trailing gap marker — one story, not two.
    expect(diff.trailingSkipped).toBe(0)
  })

  it('falls back to a coarse replacement past DIFF_MAX_EDIT_DISTANCE', () => {
    const n = DIFF_MAX_EDIT_DISTANCE
    const diff = diffLines(lines(n, 'old'), lines(n, 'new'))

    expect(diff.coarse).toBe(true)
    expect(diff.added).toBe(n)
    expect(diff.removed).toBe(n)
    expect(diff.changed).toBe(true)
  })

  it('stays cheap and exact when a huge text changes in one place', () => {
    const before = `${lines(DIFF_MAX_LINES * 2)}\n`
    const after = before.replace('line 900', 'LINE 900')
    const started = Date.now()
    const diff = diffLines(before, after)

    // The common head and tail are trimmed before any alignment runs, so the
    // size of the unchanged part must not reach the ceilings at all.
    expect(diff.coarse).toBe(false)
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('refuses the alignment rather than the diff when both sides are huge', () => {
    const diff = diffLines(lines(DIFF_MAX_LINES + 1, 'old'), lines(DIFF_MAX_LINES + 1, 'new'))
    expect(diff.coarse).toBe(true)
    expect(diff.changed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tool call -> change (lib/fileEdit.ts)
// ---------------------------------------------------------------------------

describe('writeOutcome', () => {
  it('reads the two sentences the CLI writes', () => {
    expect(writeOutcome('File created successfully at: /a/b.ts')).toBe('created')
    expect(writeOutcome('The file /a/b.ts has been updated successfully.')).toBe('replaced')
  })

  it('is unknown while the call is still running, and on failure', () => {
    expect(writeOutcome(undefined)).toBe('unknown')
    expect(writeOutcome('File created successfully at: /a/b.ts', true)).toBe('unknown')
  })

  it('never guesses at a sentence it does not recognise', () => {
    expect(writeOutcome('something else entirely')).toBe('unknown')
    expect(writeOutcome('')).toBe('unknown')
  })
})

describe('describeFileChange', () => {
  it('ignores tools that do not edit', () => {
    expect(describeFileChange('Read', { file_path: '/a.ts' }, 'contents')).toBeNull()
    expect(describeFileChange('Bash', { command: 'ls' }, 'out')).toBeNull()
    expect(describeFileChange(undefined, { file_path: '/a.ts' }, undefined)).toBeNull()
  })

  it('falls back to the raw input when an edit call is malformed', () => {
    expect(describeFileChange('Edit', { file_path: '/a.ts' }, undefined)).toBeNull()
    expect(describeFileChange('Write', { file_path: '/a.ts' }, undefined)).toBeNull()
    expect(describeFileChange('Edit', 'not an object', undefined)).toBeNull()
  })

  it('diffs an Edit from its own input and carries replace_all', () => {
    const change = describeFileChange(
      'Edit',
      { file_path: '/a.ts', old_string: 'a\nb\n', new_string: 'a\nB\n', replace_all: true },
      'The file /a.ts has been updated successfully.',
    ) as Extract<FileChange, { kind: 'edit' }>

    expect(change.kind).toBe('edit')
    expect(change.path).toBe('/a.ts')
    expect(change.replaceAll).toBe(true)
    expect(change.diff.added).toBe(1)
    expect(change.diff.removed).toBe(1)
  })

  it('defaults replace_all to false rather than to undefined', () => {
    const change = describeFileChange(
      'Edit',
      { file_path: '/a.ts', old_string: 'a', new_string: 'b' },
      undefined,
    ) as Extract<FileChange, { kind: 'edit' }>
    expect(change.replaceAll).toBe(false)
  })

  it('reuses one diff for the same input object', () => {
    const input = { file_path: '/a.ts', old_string: 'a', new_string: 'b' }
    const first = describeFileChange('Edit', input, undefined) as Extract<
      FileChange,
      { kind: 'edit' }
    >
    const second = describeFileChange('Edit', input, 'done') as Extract<
      FileChange,
      { kind: 'edit' }
    >
    expect(second.diff).toBe(first.diff)
  })

  it('carries a Write as content plus what is known about the file before it', () => {
    const created = describeFileChange(
      'Write',
      { file_path: '/a.ts', content: 'x\ny\n' },
      'File created successfully at: /a.ts',
    ) as Extract<FileChange, { kind: 'write' }>
    expect(created).toMatchObject({ kind: 'write', path: '/a.ts', outcome: 'created' })

    const replaced = describeFileChange(
      'Write',
      { file_path: '/a.ts', content: 'x\n' },
      'The file /a.ts has been updated successfully.',
    ) as Extract<FileChange, { kind: 'write' }>
    expect(replaced.outcome).toBe('replaced')
  })

  it('reads a NotebookEdit cell, defaulting the mode the schema defaults', () => {
    const change = describeFileChange(
      'NotebookEdit',
      { notebook_path: '/n.ipynb', new_source: 'print(1)', cell_id: 'c3' },
      undefined,
    ) as Extract<FileChange, { kind: 'notebook' }>
    expect(change).toMatchObject({ kind: 'notebook', mode: 'replace', cellId: 'c3' })

    const inserted = describeFileChange(
      'NotebookEdit',
      { notebook_path: '/n.ipynb', new_source: 'print(1)', edit_mode: 'insert' },
      undefined,
    ) as Extract<FileChange, { kind: 'notebook' }>
    expect(inserted).toMatchObject({ mode: 'insert', cellId: null })
  })
})

describe('changeCounts', () => {
  it('counts both sides of an Edit', () => {
    const change = describeFileChange(
      'Edit',
      { file_path: '/a.ts', old_string: 'a\nb\n', new_string: 'a\nB\nC\n' },
      undefined,
    )!
    expect(changeCounts(change)).toEqual({ added: 2, removed: 1 })
  })

  it('counts a created file as all additions', () => {
    const change = describeFileChange(
      'Write',
      { file_path: '/a.ts', content: 'x\ny\nz\n' },
      'File created successfully at: /a.ts',
    )!
    expect(changeCounts(change)).toEqual({ added: 3, removed: 0 })
  })

  it('refuses to count an overwrite, whose other side is unknown', () => {
    const replaced = describeFileChange(
      'Write',
      { file_path: '/a.ts', content: 'x\n' },
      'The file /a.ts has been updated successfully.',
    )!
    expect(changeCounts(replaced)).toBeNull()

    const running = describeFileChange('Write', { file_path: '/a.ts', content: 'x\n' }, undefined)!
    expect(changeCounts(running)).toBeNull()

    const notebook = describeFileChange(
      'NotebookEdit',
      { notebook_path: '/n.ipynb', new_source: 'print(1)' },
      undefined,
    )!
    expect(changeCounts(notebook)).toBeNull()
  })
})
