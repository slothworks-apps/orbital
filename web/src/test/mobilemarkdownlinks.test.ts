import { describe, expect, it } from 'vitest'
import { markdownLink } from '../mobile/files/markdownLinks'

describe('markdownLink', () => {
  const file = 'docs/parity/Button.md'

  it('leaves web addresses to the browser', () => {
    expect(markdownLink('https://example.com/a.md:3', file)).toEqual({ kind: 'web', url: 'https://example.com/a.md:3' })
    expect(markdownLink('mailto:a@b.c', file)).toEqual({ kind: 'web', url: 'mailto:a@b.c' })
  })

  it('reads a relative link against the file’s own directory', () => {
    expect(markdownLink('out/parity.csv', file)).toEqual({ kind: 'file', path: 'docs/parity/out/parity.csv', line: null })
    expect(markdownLink('./a.ts:12', file)).toEqual({ kind: 'file', path: 'docs/parity/a.ts', line: 12 })
    expect(markdownLink('../../web/src/App.tsx#L7', file)).toEqual({ kind: 'file', path: 'web/src/App.tsx', line: 7 })
    expect(markdownLink('../../../up.md', file)).toEqual({ kind: 'file', path: '../up.md', line: null })
  })

  it('keeps an absolute link absolute and never climbs above the root', () => {
    expect(markdownLink('/etc/../tmp/x.log:3:9', '/Users/me/notes.md')).toEqual({ kind: 'file', path: '/tmp/x.log', line: 3 })
    expect(markdownLink('../../../x.md', '/a/notes.md')).toEqual({ kind: 'file', path: '/x.md', line: null })
  })

  it('turns a line in the same file into a jump, and the bare same file into nothing', () => {
    expect(markdownLink('Button.md:42', file)).toEqual({ kind: 'same', line: 42 })
    expect(markdownLink('./Button.md#L5', file)).toEqual({ kind: 'same', line: 5 })
    expect(markdownLink('Button.md', file)).toEqual({ kind: 'none' })
  })

  it('ignores anchors and queries, and decodes escaped characters', () => {
    expect(markdownLink('#open-questions', file)).toEqual({ kind: 'none' })
    expect(markdownLink('My%20Notes.md#intro', file)).toEqual({ kind: 'file', path: 'docs/parity/My Notes.md', line: null })
    expect(markdownLink('100%.md', file)).toEqual({ kind: 'file', path: 'docs/parity/100%.md', line: null })
    expect(markdownLink(undefined, file)).toEqual({ kind: 'none' })
  })
})
