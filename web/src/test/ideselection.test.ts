import { describe, expect, it } from 'vitest'
import {
  IDE_SELECTION_MAX_CHARS,
  elideFileName,
  fileNameOf,
  isAttachable,
  lineCountLabel,
  lineEnd,
  lipParts,
  pathRelativeTo,
  promptWithSelection,
  parseSentSelection,
  selectionId,
} from '../lib/ideSelection'
import type { IdeSelection } from '../lib/types'

/**
 * The composer slot's arithmetic and the block that rides with a prompt
 * (spec: 2026-09-23-ide-bridge-design § The slot and the lip).
 */

const CWD = '/Users/t/proj'

function sel(over: Partial<IdeSelection> = {}): IdeSelection {
  return {
    filePath: '/Users/t/proj/web/CLAUDE.md',
    lineStart: 84,
    lineCount: 5,
    text: 'hello',
    ...over,
  }
}

describe('pathRelativeTo', () => {
  it('writes a path under the cwd relative, with no leading dot-slash', () => {
    expect(pathRelativeTo(CWD, '/Users/t/proj/web/CLAUDE.md')).toBe('web/CLAUDE.md')
    expect(pathRelativeTo(`${CWD}/`, '/Users/t/proj/web/CLAUDE.md')).toBe('web/CLAUDE.md')
  })

  it('leaves a path outside the cwd whole — the editor can have anything open', () => {
    expect(pathRelativeTo(CWD, '/etc/hosts')).toBe('/etc/hosts')
    // A sibling directory whose name merely starts the same way is outside.
    expect(pathRelativeTo(CWD, '/Users/t/proj-evil/a.ts')).toBe('/Users/t/proj-evil/a.ts')
  })

  it('answers the path itself when there is no cwd to relate it to', () => {
    expect(pathRelativeTo('', '/a/b.ts')).toBe('/a/b.ts')
  })
})

describe('the labels', () => {
  it('shows the file name alone — the directory never shows on the slot', () => {
    expect(fileNameOf('/Users/t/proj/web/CLAUDE.md')).toBe('CLAUDE.md')
    expect(fileNameOf('CLAUDE.md')).toBe('CLAUDE.md')
  })

  it('elides a long name from the front, so the tail and the extension survive', () => {
    const long = 'OnboardingCompactHeader.stories.tsx'
    const cut = elideFileName(long)
    expect(cut.length).toBeLessThanOrEqual(long.length)
    expect(cut).toContain('…')
    expect(cut.endsWith('.stories.tsx')).toBe(true)
    // Short enough to fit is left exactly alone.
    expect(elideFileName('CLAUDE.md')).toBe('CLAUDE.md')
  })

  it('counts lines above one and characters at one, as the CLI says it', () => {
    expect(lipParts(sel())).toEqual({ amount: '5 lines', file: 'CLAUDE.md' })
    expect(lipParts(sel({ lineCount: 1, text: 'x'.repeat(34) })).amount).toBe('34 chars')
    expect(lipParts(sel({ lineCount: 1, text: 'x' })).amount).toBe('1 char')
  })

  it('counts lines in words, singular included', () => {
    expect(lineCountLabel(sel())).toBe('5 lines')
    expect(lineCountLabel(sel({ lineCount: 1 }))).toBe('1 line')
    // A count the server could never send is still not allowed to read as zero.
    expect(lineCountLabel(sel({ lineCount: 0 }))).toBe('1 line')
    expect(lineEnd(sel({ lineCount: 0 }))).toBe(84)
  })
})

describe('selectionId', () => {
  it('is the same for two readings of the same selection', () => {
    expect(selectionId(sel())).toBe(selectionId(sel()))
  })

  it('changes on the file, the start, the count and the text', () => {
    const base = selectionId(sel())
    expect(selectionId(sel({ filePath: '/Users/t/proj/other.md' }))).not.toBe(base)
    expect(selectionId(sel({ lineStart: 85 }))).not.toBe(base)
    expect(selectionId(sel({ lineCount: 6 }))).not.toBe(base)
    expect(selectionId(sel({ text: 'hellp' }))).not.toBe(base)
    // Same length, different content — the hash is what separates them.
    expect(selectionId(sel({ text: 'olleh' }))).not.toBe(base)
  })

  it('separates a caret from a selection that happens to sit on one line', () => {
    expect(selectionId(sel({ lineCount: 1, text: null }))).not.toBe(
      selectionId(sel({ lineCount: 1, text: 'x' })),
    )
  })

  it('stays short whatever the selection weighs', () => {
    expect(selectionId(sel({ text: 'x'.repeat(500_000) }))).toHaveLength(
      selectionId(sel({ text: 'y'.repeat(500_000) })).length,
    )
    expect(selectionId(sel({ text: 'x'.repeat(500_000) })).length).toBeLessThan(80)
  })
})

describe('isAttachable', () => {
  it('is false for a caret, a missing selection and an empty string', () => {
    expect(isAttachable(null)).toBe(false)
    expect(isAttachable(undefined)).toBe(false)
    expect(isAttachable(sel({ text: null }))).toBe(false)
    expect(isAttachable(sel({ text: '' }))).toBe(false)
    expect(isAttachable(sel())).toBe(true)
  })
})

describe('promptWithSelection', () => {
  it('puts the block first and the typed words last', () => {
    const out = promptWithSelection('what does this do?', CWD, sel({ text: 'const a = 1' }))
    expect(out).toBe(
      [
        'Selected in the editor — @web/CLAUDE.md lines 84–88:',
        '',
        '```',
        'const a = 1',
        '```',
        '',
        'what does this do?',
      ].join('\n'),
    )
  })

  it('carries the block alone when the turn has no words of its own', () => {
    expect(promptWithSelection('', CWD, sel({ text: 'x' })).endsWith('```')).toBe(true)
  })

  it('cuts a selection that would otherwise ride whole with every prompt', () => {
    const out = promptWithSelection('why?', CWD, sel({ text: 'a'.repeat(IDE_SELECTION_MAX_CHARS * 2) }))
    expect(out).toContain('selection truncated')
    expect(out.length).toBeLessThan(IDE_SELECTION_MAX_CHARS + 200)
    // And says nothing about a cut when there was none.
    expect(promptWithSelection('why?', CWD, sel({ text: 'short' }))).not.toContain('truncated')
  })

  it('fences a selection that is itself fenced, so the block cannot close early', () => {
    const fenced = '```ts\nconst a = 1\n```'
    const out = promptWithSelection('why?', CWD, sel({ text: fenced }))
    const back = parseSentSelection(out)
    expect(back?.text).toBe('why?')
  })
})

describe('parseSentSelection', () => {
  const round = (typed: string, over: Partial<IdeSelection> = {}) =>
    parseSentSelection(promptWithSelection(typed, CWD, sel(over)))

  it('reads the block back out of a turn it wrote', () => {
    expect(round('tighten this')).toEqual({
      path: 'web/CLAUDE.md',
      lineStart: 84,
      lineEnd: 88,
      lineCount: 5,
      text: 'tighten this',
    })
  })

  it('answers an empty body for a turn that was only a selection', () => {
    expect(round('')?.text).toBe('')
  })

  it('answers null for every turn that did not carry one', () => {
    expect(parseSentSelection(null)).toBeNull()
    expect(parseSentSelection(undefined)).toBeNull()
    expect(parseSentSelection('')).toBeNull()
    expect(parseSentSelection('just a message')).toBeNull()
    // Someone typing the opening words by hand is not a block.
    expect(parseSentSelection('Selected in the editor — I mean the one on the left')).toBeNull()
  })

  it('leaves a code block in the typed words alone', () => {
    const typed = 'compare with\n\n```\nother()\n```'
    expect(round(typed)?.text).toBe(typed)
  })
})
