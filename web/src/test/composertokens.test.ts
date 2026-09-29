import { describe, it, expect } from 'vitest'
import {
  tokenizeComposer,
  unknownCommand,
  completionContext,
  commandNameSet,
} from '../lib/composerTokens'
import type { SlashCommand } from '../lib/types'

/** The catalog as the wire delivers it — some names slashed, some not. */
const CATALOG: SlashCommand[] = [
  { name: '/code-review', description: '', source: 'project' },
  { name: 'commit', description: '', source: 'project' },
  { name: 'compact', description: '', source: 'built-in' },
]
const KNOWN = commandNameSet(CATALOG)

/** The invariant the paint depends on: tokens re-join to the input, verbatim. */
function joined(text: string) {
  return tokenizeComposer(text, KNOWN)
    .map((t) => t.text)
    .join('')
}

// ---------------------------------------------------------------------------
// tokenizeComposer — the pure table (spec § Highlighting)
// ---------------------------------------------------------------------------

describe('tokenizeComposer', () => {
  it('leaves plain prose as one text run', () => {
    expect(tokenizeComposer('review the staged diff', KNOWN)).toEqual([
      { kind: 'text', text: 'review the staged diff' },
    ])
  })

  it('tints a known command at position 0', () => {
    expect(tokenizeComposer('/code-review the staged diff', KNOWN)).toEqual([
      { kind: 'command', text: '/code-review', name: 'code-review' },
      { kind: 'text', text: ' the staged diff' },
    ])
  })

  it('accepts a catalog name given with or without its leading slash', () => {
    expect(tokenizeComposer('/commit now', KNOWN)[0]).toMatchObject({ kind: 'command' })
    expect(tokenizeComposer('/code-review', KNOWN)[0]).toMatchObject({ kind: 'command' })
  })

  it('marks a command mid-sentence — the CLI picks one up there too', () => {
    expect(tokenizeComposer('run /code-review please', KNOWN)).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'command', text: '/code-review', name: 'code-review' },
      { kind: 'text', text: ' please' },
    ])
  })

  it('leaves a slash inside a word alone — a path or a date is not a slug', () => {
    expect(tokenizeComposer('see web/code-review now', KNOWN)).toEqual([
      { kind: 'text', text: 'see web/code-review now' },
    ])
  })

  it('leaves an unrecognised command plain (9e UNKNOWN)', () => {
    expect(tokenizeComposer('/comand the diff', KNOWN)).toEqual([
      { kind: 'text', text: '/comand the diff' },
    ])
  })

  it('leaves a half-typed command plain until it matches exactly', () => {
    expect(tokenizeComposer('/code-revi', KNOWN)).toEqual([{ kind: 'text', text: '/code-revi' }])
  })

  it('tokenizes a mention with a :line suffix', () => {
    expect(tokenizeComposer('start from @web/src/App.tsx:42 please', KNOWN)).toEqual([
      { kind: 'text', text: 'start from ' },
      { kind: 'mention', text: '@web/src/App.tsx:42', path: 'web/src/App.tsx', suffix: ':42' },
      { kind: 'text', text: ' please' },
    ])
  })

  it('keeps a :line:col suffix whole', () => {
    const [token] = tokenizeComposer('@web/src/App.tsx:42:7', KNOWN)
    expect(token).toEqual({
      kind: 'mention',
      text: '@web/src/App.tsx:42:7',
      path: 'web/src/App.tsx',
      suffix: ':42:7',
    })
  })

  it('tokenizes a directory mention, trailing slash kept', () => {
    expect(tokenizeComposer('@web/src/components/', KNOWN)).toEqual([
      { kind: 'mention', text: '@web/src/components/', path: 'web/src/components/', suffix: '' },
    ])
  })

  it('tokenizes a slashless mention — the @ is the intent, not the extension', () => {
    expect(tokenizeComposer('@README.md', KNOWN)).toEqual([
      { kind: 'mention', text: '@README.md', path: 'README.md', suffix: '' },
    ])
  })

  it('does not read an email address as a mention', () => {
    expect(tokenizeComposer('mail tomas@example.com', KNOWN)).toEqual([
      { kind: 'text', text: 'mail tomas@example.com' },
    ])
  })

  it('leaves a bare @ as prose', () => {
    expect(tokenizeComposer('@ ', KNOWN)).toEqual([{ kind: 'text', text: '@ ' }])
  })

  it('keeps a sentence-ending full stop out of the mention', () => {
    expect(tokenizeComposer('see @web/src/App.tsx.', KNOWN)).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'mention', text: '@web/src/App.tsx', path: 'web/src/App.tsx', suffix: '' },
      { kind: 'text', text: '.' },
    ])
  })

  it('finds a command and several mentions in one field', () => {
    const tokens = tokenizeComposer('/commit @a/b.ts and @c/d.ts', KNOWN)
    expect(tokens.map((t) => t.kind)).toEqual(['command', 'text', 'mention', 'text', 'mention'])
  })

  it('emits nothing for an empty field', () => {
    expect(tokenizeComposer('', KNOWN)).toEqual([])
  })

  it('re-joins to the input verbatim, whatever the mix', () => {
    for (const text of [
      '',
      'plain',
      '/code-review the diff',
      '/comand',
      'a @b/c.ts:1:2 d @e/ f',
      '@ @@ a@b tomas@example.com',
      'trailing space ',
      'multi\nline @x/y.ts\n',
    ]) {
      expect(joined(text)).toBe(text)
    }
  })
})

// ---------------------------------------------------------------------------
// unknownCommand — the hint line's note
// ---------------------------------------------------------------------------

describe('unknownCommand', () => {
  it('names a complete position-0 slug that matches nothing', () => {
    expect(unknownCommand('/comand the diff', KNOWN)).toBe('/comand')
    expect(unknownCommand('/comand', KNOWN)).toBe('/comand')
  })

  it('stays quiet while the slug is still a live prefix of something', () => {
    expect(unknownCommand('/co', KNOWN)).toBeNull()
    expect(unknownCommand('/com', KNOWN)).toBeNull()
  })

  it('speaks once a live prefix is finished by a space', () => {
    expect(unknownCommand('/co the diff', KNOWN)).toBe('/co')
  })

  it('stays quiet for a known command, for prose and for an empty slug', () => {
    expect(unknownCommand('/code-review the diff', KNOWN)).toBeNull()
    expect(unknownCommand('run /comand', KNOWN)).toBeNull()
    expect(unknownCommand('/', KNOWN)).toBeNull()
    expect(unknownCommand('', KNOWN)).toBeNull()
  })

  it('stays quiet for an absolute path typed at position 0', () => {
    expect(unknownCommand('/Users/tomin/notes.md is the file', KNOWN)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// completionContext — what the popup is completing at the caret
// ---------------------------------------------------------------------------

describe('completionContext', () => {
  it('reads a command context at position 0', () => {
    expect(completionContext('/co', 3)).toEqual({ kind: 'command', start: 0, prefix: 'co' })
  })

  it('reads the bare trigger as an empty prefix', () => {
    expect(completionContext('/', 1)).toEqual({ kind: 'command', start: 0, prefix: '' })
    expect(completionContext('ping @', 6)).toEqual({ kind: 'file', start: 5, prefix: '' })
  })

  it('reads a file context from an @ anywhere', () => {
    expect(completionContext('check @web/src/Co', 17)).toEqual({
      kind: 'file',
      start: 6,
      prefix: 'web/src/Co',
    })
  })

  it('reads a command context from a slash that starts a word anywhere', () => {
    expect(completionContext('run /co', 7)).toEqual({ kind: 'command', start: 4, prefix: 'co' })
  })

  it('refuses a slash glued to the end of a word', () => {
    expect(completionContext('and/or', 6)).toBeNull()
  })

  it('refuses an absolute path at position 0 — that is not a command', () => {
    expect(completionContext('/Users/to', 9)).toBeNull()
  })

  it('refuses an @ glued to the end of a word', () => {
    expect(completionContext('tomas@exa', 9)).toBeNull()
  })

  it('refuses a caret that has moved past the token', () => {
    expect(completionContext('/co now', 7)).toBeNull()
  })

  it('takes the caret, not the end of the text', () => {
    expect(completionContext('/co the diff', 3)).toEqual({ kind: 'command', start: 0, prefix: 'co' })
  })
})
