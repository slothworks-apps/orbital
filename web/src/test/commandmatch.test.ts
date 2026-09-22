import { describe, expect, it } from 'vitest'
import { commandMatchRank, matchCommands } from '../lib/commandMatch'
import type { SlashCommand } from '../lib/types'

const CATALOG: SlashCommand[] = [
  { name: '/code-review', description: '', source: 'project' },
  { name: '/commit', description: '', source: 'project' },
  { name: 'superpowers:brainstorming', description: '', source: 'plugin' },
  { name: 'acme-oncall:oncall', description: '', source: 'plugin' },
  { name: '/doctor', description: '', source: 'built-in' },
]

const names = (prefix: string) => matchCommands(CATALOG, prefix).map((c) => c.name)

describe('commandMatchRank', () => {
  it('ranks a name prefix above the segment after the colon, and that above a substring', () => {
    const prefix = commandMatchRank('commit', 'com')
    const segment = commandMatchRank('superpowers:brainstorming', 'brain')
    const substring = commandMatchRank('code-review', 'review')
    expect(prefix).not.toBeNull()
    expect(segment).toBeGreaterThan(prefix!)
    expect(substring).toBeGreaterThan(segment!)
  })

  it('matches case-insensitively', () => {
    expect(commandMatchRank('code-review', 'CODE')).toBe(commandMatchRank('code-review', 'code'))
  })

  it('takes the whole catalog on a bare slash', () => {
    expect(commandMatchRank('anything', '')).not.toBeNull()
  })

  it('answers null when nothing in the name carries the fragment', () => {
    expect(commandMatchRank('code-review', 'zz')).toBeNull()
  })

  it('does not treat the colon itself as a segment when there is none', () => {
    expect(commandMatchRank('commit', 'mit')).toBe(commandMatchRank('commit', 'omm'))
  })
})

describe('matchCommands', () => {
  it('finds a namespaced command by the half after the colon', () => {
    expect(names('brainstorming')).toEqual(['superpowers:brainstorming'])
  })

  it('strips a leading slash so both catalog spellings match alike', () => {
    expect(names('commit')).toEqual(['commit'])
  })

  it('keeps a prefix hit above a merely-containing name', () => {
    // `oncall` opens `acme-oncall:oncall`'s second half and sits inside its
    // first — the segment hit must win, not the substring one.
    expect(names('oncall')).toEqual(['acme-oncall:oncall'])
    expect(names('co')[0]).toBe('code-review')
  })

  it('holds the catalog order between names that match equally well', () => {
    expect(names('')).toEqual([
      'code-review',
      'commit',
      'superpowers:brainstorming',
      'acme-oncall:oncall',
      'doctor',
    ])
  })
})
