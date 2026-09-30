import { describe, it, expect } from 'vitest'
import {
  findPathMatches,
  hasTextExtension,
  rehypePathLinks,
  codeSpanPath,
  type HastRoot,
} from '../lib/pathLinks'

// ---------------------------------------------------------------------------
// findPathMatches — the pure matcher (spec § Assistant prose)
// ---------------------------------------------------------------------------

describe('findPathMatches', () => {
  it('matches a relative path with a slash and a known text extension', () => {
    const matches = findPathMatches('see web/src/App.tsx for details')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ path: 'web/src/App.tsx', line: null, text: 'web/src/App.tsx' })
    expect(matches[0].index).toBe(4)
  })

  it('matches an absolute and a tilde path', () => {
    expect(findPathMatches('/Users/t/app/main.py')[0]?.path).toBe('/Users/t/app/main.py')
    expect(findPathMatches('~/notes/todo.txt')[0]?.path).toBe('~/notes/todo.txt')
  })

  it('keeps a :line suffix — line parsed, suffix part of the hit area', () => {
    const [m] = findPathMatches('the bug is in web/src/App.tsx:42, honest')
    expect(m.path).toBe('web/src/App.tsx')
    expect(m.line).toBe(42)
    expect(m.text).toBe('web/src/App.tsx:42')
  })

  it('keeps :line:col — line kept, column ignored, both inside the hit area', () => {
    const [m] = findPathMatches('web/src/App.tsx:42:7 fails')
    expect(m.line).toBe(42)
    expect(m.text).toBe('web/src/App.tsx:42:7')
  })

  it('requires at least one slash', () => {
    expect(findPathMatches('App.tsx is the entry')).toHaveLength(0)
    expect(findPathMatches('README.md')).toHaveLength(0)
  })

  it('requires a known text extension', () => {
    expect(findPathMatches('run scripts/deploy first')).toHaveLength(0)
    expect(findPathMatches('a/b.unknownext here')).toHaveLength(0)
  })

  it('never matches image or known-binary extensions', () => {
    for (const name of ['a/b.png', 'a/b.jpg', 'a/b.jpeg', 'a/b.gif', 'a/b.webp', 'a/b.woff2', 'a/b.pdf', 'a/b.zip', 'a/b.svg']) {
      expect(findPathMatches(`shipped ${name} today`), name).toHaveLength(0)
    }
  })

  it('does not swallow trailing sentence punctuation', () => {
    const [m] = findPathMatches('fixed in web/src/App.tsx.')
    expect(m.text).toBe('web/src/App.tsx')
  })

  it('skips URL-shaped runs (a candidate preceded by another slash)', () => {
    expect(findPathMatches('https://example.com/docs/readme.md')).toHaveLength(0)
  })

  it('finds several matches with correct offsets', () => {
    const text = 'web/a.ts then docs/b.md:3'
    const matches = findPathMatches(text)
    expect(matches.map((m) => m.text)).toEqual(['web/a.ts', 'docs/b.md:3'])
    expect(text.slice(matches[1].index, matches[1].index + matches[1].length)).toBe('docs/b.md:3')
  })
})

describe('hasTextExtension', () => {
  it('accepts code/docs/config extensions and refuses image/binary ones', () => {
    expect(hasTextExtension('/a/b/store.ts')).toBe(true)
    expect(hasTextExtension('notes.md')).toBe(true)
    expect(hasTextExtension('conf/settings.yaml')).toBe(true)
    expect(hasTextExtension('shot.png')).toBe(false)
    expect(hasTextExtension('font.woff2')).toBe(false)
    expect(hasTextExtension('Makefile')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// rehypePathLinks — the hast transformer
// ---------------------------------------------------------------------------

function textNode(value: string) {
  return { type: 'text' as const, value }
}

function el(tagName: string, children: unknown[]) {
  return { type: 'element' as const, tagName, properties: {}, children }
}

function runPlugin(tree: HastRoot): HastRoot {
  const transform = rehypePathLinks()
  transform(tree)
  return tree
}

describe('rehypePathLinks', () => {
  it('wraps a match in an <a> carrying data-path and data-line', () => {
    const tree = {
      type: 'root',
      children: [el('p', [textNode('see web/src/App.tsx:42 now')])],
    } as HastRoot
    runPlugin(tree)

    const p = tree.children[0] as ReturnType<typeof el>
    expect(p.children).toHaveLength(3)
    expect(p.children[0]).toEqual(textNode('see '))
    const link = p.children[1] as { tagName: string; properties: Record<string, unknown>; children: unknown[] }
    expect(link.tagName).toBe('a')
    expect(link.properties.dataPath).toBe('web/src/App.tsx')
    expect(link.properties.dataLine).toBe('42')
    expect(link.children).toEqual([textNode('web/src/App.tsx:42')])
    expect(p.children[2]).toEqual(textNode(' now'))
  })

  it('leaves text without matches untouched', () => {
    const tree = {
      type: 'root',
      children: [el('p', [textNode('nothing pathlike here')])],
    } as HastRoot
    runPlugin(tree)
    expect((tree.children[0] as ReturnType<typeof el>).children).toEqual([
      textNode('nothing pathlike here'),
    ])
  })

  it('skips code blocks, code spans that are more than a path, and existing links', () => {
    const tree = {
      type: 'root',
      children: [
        el('p', [el('code', [textNode('cat web/src/App.tsx')])]),
        el('pre', [el('code', [textNode('web/src/App.tsx:1')])]),
        el('a', [textNode('docs/readme.md')]),
      ],
    } as HastRoot
    runPlugin(tree)

    const codeChild = (tree.children[0] as ReturnType<typeof el>).children[0] as ReturnType<typeof el>
    expect(codeChild.children).toEqual([textNode('cat web/src/App.tsx')])
    const preCode = (tree.children[1] as ReturnType<typeof el>).children[0] as ReturnType<typeof el>
    expect(preCode.children).toEqual([textNode('web/src/App.tsx:1')])
    expect((tree.children[2] as ReturnType<typeof el>).children).toEqual([
      textNode('docs/readme.md'),
    ])
  })

  it('omits data-line when the match has no line suffix', () => {
    const tree = {
      type: 'root',
      children: [el('p', [textNode('docs/readme.md')])],
    } as HastRoot
    runPlugin(tree)
    const link = (tree.children[0] as ReturnType<typeof el>).children[0] as {
      properties: Record<string, unknown>
    }
    expect(link.properties.dataPath).toBe('docs/readme.md')
    expect(link.properties.dataLine).toBeUndefined()
  })

  it('links a code span that is exactly one path, inside the code element', () => {
    const tree = {
      type: 'root',
      children: [el('p', [el('code', [textNode('docs/x.md:3')])])],
    } as HastRoot
    runPlugin(tree)

    const code = (tree.children[0] as ReturnType<typeof el>).children[0] as ReturnType<typeof el>
    expect(code.tagName).toBe('code')
    const link = code.children[0] as { tagName: string; properties: Record<string, unknown>; children: unknown[] }
    expect(link.tagName).toBe('a')
    expect(link.properties).toMatchObject({ dataPath: 'docs/x.md', dataLine: '3', dataCode: '' })
    expect(link.children).toEqual([textNode('docs/x.md:3')])
  })
})

describe('codeSpanPath', () => {
  it('takes a span that is exactly one path, with or without a line', () => {
    expect(codeSpanPath('docs/decisions/x.md')).toMatchObject({ path: 'docs/decisions/x.md', line: null })
    expect(codeSpanPath('web/src/App.tsx:42:7')).toMatchObject({ path: 'web/src/App.tsx', line: 42 })
    expect(codeSpanPath(' web/src/App.tsx ')?.path).toBe('web/src/App.tsx')
  })

  it('refuses a span where the path is only part of it', () => {
    expect(codeSpanPath('cat web/src/App.tsx')).toBeNull()
    expect(codeSpanPath('web/src/App.tsx --watch')).toBeNull()
    expect(codeSpanPath('web/a.ts web/b.ts')).toBeNull()
    expect(codeSpanPath('web/src/App.tsx.')).toBeNull()
  })

  it('refuses what the prose matcher refuses', () => {
    expect(codeSpanPath('README.md')).toBeNull()
    expect(codeSpanPath('a/b.png')).toBeNull()
    expect(codeSpanPath('https://example.com/a.md')).toBeNull()
  })
})
