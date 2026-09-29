import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { composerMarkdown, composerSchemaExtensions } from '../lib/composerMarkdown'

/**
 * Markdown → editor → markdown (spec: 2026-09-29-composer-rich-editor-design
 * § 5). The composer hands its caller markdown and the agent reads it raw, so
 * what was typed has to come out byte for byte — not merely "equivalent".
 */

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function roundTrip(markdown: string): string {
  editor = new Editor({
    extensions: composerSchemaExtensions(),
    content: markdown,
    contentType: 'markdown',
  })
  return composerMarkdown(editor)
}

/** The document the markdown parsed into, as node type names in reading order. */
function shape(markdown: string): string[] {
  editor = new Editor({
    extensions: composerSchemaExtensions(),
    content: markdown,
    contentType: 'markdown',
  })
  const names: string[] = []
  editor.state.doc.descendants((node) => {
    names.push(
      node.isText ? `text:${node.marks.map((m) => m.type.name).join('+')}` : node.type.name,
    )
  })
  return names
}

describe('composer markdown — structure', () => {
  it.each([
    ['a bullet list', '- one\n- two\n- three'],
    ['an ordered list', '1. one\n2. two\n3. three'],
    ['a nested list', '- one\n  - nested\n  - nested two\n- two'],
    ['a list nested in an ordered one', '1. a\n   - b\n   - c\n2. d'],
    ['headings', '# Heading\n\n## Sub\n\nbody'],
    ['a quote', '> quoted line\n> second'],
    ['a fenced block with its language and indentation', '```ts\nconst a = 1\n  indented\n```'],
    ['a fence holding markdown characters', '```\nplain *not bold* # x\n```'],
    ['inline code', 'some `inline *code*` here'],
    ['bold and italic', '**bold** and *italic*'],
    ['a paragraph after a list', '- item\n\nafter'],
    ['two paragraphs', 'para one\n\npara two'],
    ['a soft line break', 'line one\nline two'],
    ['a hard break', 'trailing spaces  \nhard break'],
  ])('keeps %s', (_, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('parses into real structure, not text that looks like it', () => {
    expect(shape('- a\n  - b')).toEqual([
      'bulletList',
      'listItem',
      'paragraph',
      'text:',
      'bulletList',
      'listItem',
      'paragraph',
      'text:',
    ])
    expect(shape('**b** _i_ `c`')).toEqual([
      'paragraph',
      'text:bold',
      'text:',
      'text:italic',
      'text:',
      'text:code',
    ])
  })
})

describe('composer markdown — literal characters', () => {
  it.each([
    ['stars that emphasise nothing', '2 * 3 * 4 = 24'],
    ['underscores inside words', 'snake_case_name and a_b'],
    ['a hash mid-line', 'a # not heading'],
    ['a hash glued to a word', '#hashtag'],
    ['a greater-than sign', 'x > y and a >= b'],
    ['a lone backtick', 'a lone ` tick'],
    ['angle brackets and ampersands', 'price is $5 & <tag> & <div>html</div>'],
    ['a link, which is out of scope', 'see [the docs](https://example.com/a_b_c)'],
    ['a bare URL', 'https://example.com/a_b_c'],
    ['a table, which is out of scope', '| a | b |\n|---|---|\n| 1 | 2 |'],
    ['a task list marker', '- [ ] task'],
  ])('keeps %s', (_, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('escapes only what would otherwise turn into formatting', () => {
    editor = new Editor({ extensions: composerSchemaExtensions(), content: '' })
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '*not italic* and 5 * x' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '# not a heading' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '- not a bullet' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '&amp; typed as is' }] },
      ],
    })
    const markdown = composerMarkdown(editor)
    expect(markdown).toBe(
      '\\*not italic\\* and 5 \\* x\n\n\\# not a heading\n\n\\- not a bullet\n\n\\&amp; typed as is',
    )
    // And the escapes are what bring the same text back.
    const back = new Editor({
      extensions: composerSchemaExtensions(),
      content: markdown,
      contentType: 'markdown',
    })
    expect(back.getText({ blockSeparator: '\n' })).toBe(
      '*not italic* and 5 * x\n# not a heading\n- not a bullet\n&amp; typed as is',
    )
    back.destroy()
  })
})

describe('composer markdown — tokens and prose', () => {
  it.each([
    ['a command', '/code-review the staged diff'],
    ['a command mid-prompt and a mention with a line', 'run /commit then @web/src/App.tsx:42'],
    ['a directory mention', '@src/components/ check'],
    ['an absolute path', '/Users/tomin/notes.md'],
    ['Czech', 'Příliš žluťoučký kůň úpěl ďábelské ódy.'],
    ['Czech in a list', '- řádek jedna\n- řádek dvě'],
  ])('keeps %s', (_, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('hands out nothing for an empty document, and no &nbsp; for blank lines', () => {
    expect(roundTrip('')).toBe('')
    editor = new Editor({ extensions: composerSchemaExtensions(), content: '' })
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph' },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
        { type: 'paragraph' },
      ],
    })
    expect(composerMarkdown(editor)).not.toContain('nbsp')
    expect(composerMarkdown(editor)).toMatch(/^a\n+b$/)
  })
})
