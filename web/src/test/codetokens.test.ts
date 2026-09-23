import { beforeEach, describe, expect, it, vi } from 'vitest'
import { diffSideTexts, resetFragmentTokenCache, tokenizeFragment } from '../lib/codeTokens'
import { languageFromPath, tokenizeCode, type CodeToken } from '../lib/highlight'
import type { DiffLine } from '../lib/diff'

// Only the shiki call is stubbed; `languageFromPath` is the real one.
vi.mock('../lib/highlight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/highlight')>()),
  tokenizeCode: vi.fn(),
}))

const tokenizeCodeMock = vi.mocked(tokenizeCode)
const grid = (...lines: string[]): CodeToken[][] =>
  lines.map((text) => [{ content: text, color: '#e6edf3' }])

beforeEach(() => {
  resetFragmentTokenCache()
  tokenizeCodeMock.mockReset()
})

const add = (text: string): DiffLine => ({ kind: 'add', text })
const del = (text: string): DiffLine => ({ kind: 'del', text })
const ctx = (text: string): DiffLine => ({ kind: 'context', text })

describe('languageFromPath', () => {
  it('maps an extension the shiki id differs from', () => {
    expect(languageFromPath('/a/b/main.ts').lang).toBe('typescript')
    expect(languageFromPath('/a/b/main.tsx').lang).toBe('tsx')
    expect(languageFromPath('/a/b/run.sh').lang).toBe('shellscript')
  })

  it('hands an unmapped extension to shiki as-is', () => {
    expect(languageFromPath('/a/b/main.go').lang).toBe('go')
    expect(languageFromPath('/a/b/data.json').lang).toBe('json')
  })

  it('reads the extension off the last path segment only', () => {
    expect(languageFromPath('/a.py/b.d/main.rs').lang).toBe('rust')
  })

  it('takes the last dot when a name has several', () => {
    expect(languageFromPath('/a/vite.config.ts').lang).toBe('typescript')
    expect(languageFromPath('/a/Component.test.tsx').lang).toBe('tsx')
  })

  it('lowercases, so a shouted extension still resolves', () => {
    expect(languageFromPath('/a/README.MD').lang).toBe('markdown')
  })

  it('gives no language to a file with no extension', () => {
    expect(languageFromPath('/a/b/Makefile').lang).toBe('')
    expect(languageFromPath('Makefile').lang).toBe('')
  })

  it('treats a dotfile name as a name, not an extension', () => {
    expect(languageFromPath('/a/.gitignore').lang).toBe('')
    expect(languageFromPath('.env').lang).toBe('')
  })

  it('still resolves a dotfile that has a real extension after the name', () => {
    expect(languageFromPath('/a/.eslintrc.json').lang).toBe('json')
  })

  it('labels a language when the label differs from the id', () => {
    expect(languageFromPath('/a/main.tsx').label).toBe('typescript')
    expect(languageFromPath('/a/main.cc').label).toBe('c++')
    expect(languageFromPath('/a/main.go').label).toBe('go')
  })
})

describe('diffSideTexts', () => {
  it('reassembles the two sides a fragment of rows came from', () => {
    const sides = diffSideTexts([ctx('one'), del('two'), add('TWO'), ctx('three')])
    expect(sides.before).toBe('one\ntwo\nthree')
    expect(sides.after).toBe('one\nTWO\nthree')
    expect(sides.beforeLines).toBe(3)
    expect(sides.afterLines).toBe(3)
  })

  it('points each row at its own line on its own side', () => {
    const sides = diffSideTexts([ctx('one'), del('two'), add('TWO'), ctx('three')])
    expect(sides.coords).toEqual([
      { side: 'after', line: 0 },
      { side: 'before', line: 1 },
      { side: 'after', line: 1 },
      { side: 'after', line: 2 },
    ])
  })

  it('reads a context row off the after side, where it also lives', () => {
    const sides = diffSideTexts([del('gone'), ctx('kept')])
    expect(sides.before).toBe('gone\nkept')
    expect(sides.after).toBe('kept')
    // The context row must index into `after`, not into `before` — off by one
    // there would colour every context line with its neighbour's tokens.
    expect(sides.coords[1]).toEqual({ side: 'after', line: 0 })
  })

  it('leaves the before side empty for a pure insertion', () => {
    const sides = diffSideTexts([add('new'), add('newer')])
    expect(sides.before).toBe('')
    expect(sides.beforeLines).toBe(0)
    expect(sides.after).toBe('new\nnewer')
    expect(sides.afterLines).toBe(2)
  })

  it('leaves the after side empty for a pure deletion', () => {
    const sides = diffSideTexts([del('old')])
    expect(sides.after).toBe('')
    expect(sides.afterLines).toBe(0)
    expect(sides.before).toBe('old')
  })

  it('counts a blank line rather than inferring it from the joined text', () => {
    const sides = diffSideTexts([add('')])
    expect(sides.after).toBe('')
    // One blank line and no lines both join to '', which is why the counts
    // are carried separately.
    expect(sides.afterLines).toBe(1)
  })

  it('keeps every removal before every addition addressable in a coarse block', () => {
    const sides = diffSideTexts([del('a'), del('b'), add('A'), add('B')])
    expect(sides.before).toBe('a\nb')
    expect(sides.after).toBe('A\nB')
    expect(sides.coords).toEqual([
      { side: 'before', line: 0 },
      { side: 'before', line: 1 },
      { side: 'after', line: 0 },
      { side: 'after', line: 1 },
    ])
  })

  it('returns empty sides for no rows', () => {
    const sides = diffSideTexts([])
    expect(sides).toEqual({
      before: '',
      after: '',
      beforeLines: 0,
      afterLines: 0,
      coords: [],
    })
  })

  it('produces one coordinate per row, always', () => {
    const rows = [ctx('a'), del('b'), add('c'), add('d'), ctx('e'), del('f')]
    const sides = diffSideTexts(rows)
    expect(sides.coords).toHaveLength(rows.length)
  })

  it('addresses a line of each side that really is that row text', () => {
    const rows = [ctx('a'), del('b'), add('c'), add('d'), ctx('e'), del('f')]
    const sides = diffSideTexts(rows)
    const lines = { before: sides.before.split('\n'), after: sides.after.split('\n') }
    rows.forEach((row, index) => {
      const coord = sides.coords[index]
      expect(lines[coord.side][coord.line]).toBe(row.text)
    })
  })
})

describe('tokenizeFragment', () => {
  it('tokenizes a fragment and keeps the grid', async () => {
    tokenizeCodeMock.mockResolvedValue(grid('const a = 1', 'const b = 2'))
    await expect(tokenizeFragment('const a = 1\nconst b = 2', 'typescript', 2)).resolves.toEqual(
      grid('const a = 1', 'const b = 2'),
    )
    expect(tokenizeCodeMock).toHaveBeenCalledWith('const a = 1\nconst b = 2', 'typescript')
  })

  it('never asks shiki for a file with no language', async () => {
    await expect(tokenizeFragment('some text', '', 1)).resolves.toBeNull()
    expect(tokenizeCodeMock).not.toHaveBeenCalled()
  })

  it('never asks shiki for a side with no rows', async () => {
    await expect(tokenizeFragment('', 'typescript', 0)).resolves.toBeNull()
    expect(tokenizeCodeMock).not.toHaveBeenCalled()
  })

  it('falls back to plain text when shiki cannot highlight the language', async () => {
    tokenizeCodeMock.mockResolvedValue(null)
    await expect(tokenizeFragment('x', 'nonesuch', 1)).resolves.toBeNull()
  })

  it('refuses a grid whose line count disagrees with the rows', async () => {
    // Anything but one entry per row would shift each line's colours onto its
    // neighbour, which is worse than no colour at all.
    tokenizeCodeMock.mockResolvedValue(grid('a', 'b', 'c'))
    await expect(tokenizeFragment('a\nb', 'typescript', 2)).resolves.toBeNull()
  })

  it('tokenizes one fragment once, however often it is asked for', async () => {
    tokenizeCodeMock.mockResolvedValue(grid('a'))
    await tokenizeFragment('a', 'typescript', 1)
    await tokenizeFragment('a', 'typescript', 1)
    expect(tokenizeCodeMock).toHaveBeenCalledTimes(1)
  })

  it('remembers a refusal too, rather than retrying it every render', async () => {
    tokenizeCodeMock.mockResolvedValue(null)
    await tokenizeFragment('a', 'typescript', 1)
    await tokenizeFragment('a', 'typescript', 1)
    expect(tokenizeCodeMock).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight call between the rows that asked for it', async () => {
    tokenizeCodeMock.mockResolvedValue(grid('a'))
    const [first, second] = await Promise.all([
      tokenizeFragment('a', 'typescript', 1),
      tokenizeFragment('a', 'typescript', 1),
    ])
    expect(tokenizeCodeMock).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
  })

  it('keys on the language as well as the text', async () => {
    tokenizeCodeMock.mockResolvedValue(grid('a'))
    await tokenizeFragment('a', 'typescript', 1)
    await tokenizeFragment('a', 'python', 1)
    expect(tokenizeCodeMock).toHaveBeenCalledTimes(2)
  })
})
