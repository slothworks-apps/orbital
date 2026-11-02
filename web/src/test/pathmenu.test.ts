import { describe, it, expect } from 'vitest'
import { CHOOSER_ROWS, GAVE_UP, NOT_A_NAME, outcomeOf, shownMatches, type FoundFile } from '../lib/findByName'
import { editorsFor, mentionOf, pathMenuGroups, relativeUnder } from '../lib/pathMenu'

const file = (relative: string, touched = false): FoundFile => ({ path: `/repo/${relative}`, relative, touched })
const kinds = (groups: ReturnType<typeof pathMenuGroups>) => groups.map((g) => g.map((a) => a.kind))

describe('pathMenuGroups', () => {
  it('draws the full menu in three groups, editors in the given order', () => {
    const groups = pathMenuGroups({
      relative: true,
      editors: [
        { id: 'a', name: 'WebStorm' },
        { id: 'b', name: 'VS Code' },
      ],
      finder: true,
      mention: true,
    })
    expect(kinds(groups)).toEqual([['copy', 'copy-relative'], ['editor', 'editor', 'finder'], ['mention']])
    expect(groups[1].map((a) => (a.kind === 'editor' ? a.name : a.kind))).toEqual(['WebStorm', 'VS Code', 'finder'])
  })

  it('leaves an empty middle group out, so the browser gets one hairline', () => {
    expect(kinds(pathMenuGroups({ relative: true, editors: [], finder: false, mention: true }))).toEqual([
      ['copy', 'copy-relative'],
      ['mention'],
    ])
  })

  it('keeps Finder alone in the middle when no editor is connected', () => {
    expect(kinds(pathMenuGroups({ relative: true, editors: [], finder: true, mention: true }))).toEqual([
      ['copy', 'copy-relative'],
      ['finder'],
      ['mention'],
    ])
  })

  it('offers Copy relative path only for a located file, Mention only with a composer', () => {
    expect(kinds(pathMenuGroups({ relative: false, editors: [], finder: false, mention: false }))).toEqual([['copy']])
  })
})

describe('editorsFor', () => {
  const ides = [
    { id: 'ws', ideName: 'WebStorm', workspaceRoot: '/repo' },
    { id: 'vs', ideName: 'VS Code', workspaceRoot: '/elsewhere' },
  ]

  it('lists the editors whose workspace holds the file', () => {
    expect(editorsFor({ ides }, '/repo/src/a.ts')).toEqual([{ id: 'ws', name: 'WebStorm' }])
    expect(editorsFor({ ides }, 'src/a.ts')).toEqual([
      { id: 'ws', name: 'WebStorm' },
      { id: 'vs', name: 'VS Code' },
    ])
  })

  it('does not take a sibling directory sharing the prefix for the workspace', () => {
    expect(editorsFor({ ides }, '/repository/a.ts')).toEqual([])
  })

  it("offers no editor for another device's session", () => {
    const machine = { id: 'm', name: 'studio', kind: 'mac', os: 'macOS', online: true, asOf: null }
    expect(editorsFor({ ides, machine }, '/repo/a.ts')).toEqual([])
  })
})

describe('relativeUnder', () => {
  it('measures against the deepest root the path lies under', () => {
    expect(relativeUnder('/repo/.claude/worktrees/x/src/a.ts', ['/repo', '/repo/.claude/worktrees/x'])).toBe('src/a.ts')
  })

  it('is null outside every root, and for a prefix that is not a directory', () => {
    expect(relativeUnder('/other/a.ts', ['/repo'])).toBeNull()
    expect(relativeUnder('/repository/a.ts', ['/repo/'])).toBeNull()
  })
})

describe('mentionOf', () => {
  it('mentions a file inside the working directory relatively, with its line', () => {
    expect(mentionOf('/repo/src/a.ts', 42, '/repo')).toEqual({ text: '@src/a.ts:42', path: 'src/a.ts' })
  })

  it('keeps a file outside it absolute, and a path never located as written', () => {
    expect(mentionOf('/tmp/notes.md', null, '/repo').text).toBe('@/tmp/notes.md')
    expect(mentionOf('src/a.ts', null, '/repo').text).toBe('@src/a.ts')
  })
})

describe('the chooser', () => {
  const matches = (n: number) => Array.from({ length: n }, (_, i) => file(`${'d/'.repeat(i)}index.ts`))

  it('caps the rows, and its last row counts the rest and opens them, the server’s unlisted ones included', () => {
    const choice = { kind: 'matches' as const, name: 'index.ts', matches: matches(8), more: 12 }
    const capped = shownMatches(choice, false)
    expect(capped.rows).toHaveLength(CHOOSER_ROWS)
    expect(capped).toMatchObject({ more: 14, expands: true })
    const all = shownMatches(choice, true)
    expect(all.rows).toHaveLength(8)
    expect(all).toMatchObject({ more: 12, expands: false })
  })

  it('has nothing to open when every listed match fits, only the server’s count', () => {
    expect(shownMatches({ kind: 'matches', name: 'a.ts', matches: matches(3), more: 0 }, false)).toMatchObject({
      more: 0,
      expands: false,
    })
    expect(shownMatches({ kind: 'matches', name: 'a.ts', matches: matches(CHOOSER_ROWS), more: 5 }, false)).toMatchObject({
      more: 5,
      expands: false,
    })
  })
})

describe('outcomeOf', () => {
  const facts = { under: 'web/', device: 'studio-mbp' }

  it('opens the one match', () => {
    expect(outcomeOf({ matches: [file('a.ts')], more: 0 }, 'a.ts', facts)).toEqual({ kind: 'open', file: file('a.ts') })
  })

  it('chooses among several, and says when there are none', () => {
    expect(outcomeOf({ matches: [file('a.ts'), file('b/a.ts')], more: 0 }, 'a.ts', facts).kind).toBe('choose')
    expect(outcomeOf({ matches: [file('a.ts')], more: 3 }, 'a.ts', facts).kind).toBe('choose')
    expect(outcomeOf({ matches: [], more: 0 }, 'a.ts', facts)).toEqual({
      kind: 'choose',
      choice: { kind: 'none', name: 'a.ts', under: 'web/' },
    })
  })

  it('says there is no such file when the server will not take the name', () => {
    expect(outcomeOf(NOT_A_NAME, 'a.ts', facts)).toEqual({
      kind: 'choose',
      choice: { kind: 'none', name: 'a.ts', under: 'web/' },
    })
  })

  it('falls back to the name as written when the lookup is not served, and names the device that did not answer', () => {
    expect(outcomeOf(null, 'a.ts', facts)).toEqual({ kind: 'as-written' })
    expect(outcomeOf(GAVE_UP, 'a.ts', facts)).toEqual({
      kind: 'choose',
      choice: { kind: 'silent', name: 'a.ts', device: 'studio-mbp' },
    })
  })
})
