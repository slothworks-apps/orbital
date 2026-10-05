import { describe, expect, it } from 'vitest'
import {
  claudeDirDisplayPath,
  claudeDirMark,
  claudeDirMonograms,
  claudeDirPrefill,
  claudeDirTooltip,
  nextClaudeDir,
} from '../lib/claudeDirs'
import type { ClaudeDirName } from '../lib/types'

/** Directories named as given, ids from 1. */
function named(...names: string[]): ClaudeDirName[] {
  return names.map((name, i) => ({ id: i + 1, name }))
}

/** The monograms in the list's order. */
function monos(...names: string[]): string[] {
  const dirs = named(...names)
  const map = claudeDirMonograms(dirs)
  return dirs.map((d) => map.get(d.id) ?? '')
}

describe('claudeDirMonograms — canvas 44f', () => {
  it('is the first letter, upper-cased, while it is unique', () => {
    expect(monos('Personal', 'work')).toEqual(['P', 'W'])
  })

  it('takes the initials of the first two words on a clash', () => {
    expect(monos('Work', 'Work Enterprise')).toEqual(['W', 'WE'])
    expect(monos('Northwind client sandbox', 'Northwind prod')).toEqual(['NC', 'NP'])
  })

  it('takes the first two letters of a one-word name that still clashes', () => {
    expect(monos('Personal', 'Playground')).toEqual(['PE', 'PL'])
    // The one-word name falls back; the two-word name keeps its initials.
    expect(monos('Pa', 'Pb Enterprise', 'Pc')).toEqual(['PA', 'PE', 'PC'])
  })

  it('reads words across any run of whitespace, and ignores the edges', () => {
    expect(monos('  work   enterprise ', 'Wild')).toEqual(['WE', 'W'])
  })

  it('never splits a character that is more than one UTF-16 unit', () => {
    expect(monos('🚀 Rocket', '🚀 Ship')).toEqual(['🚀R', '🚀S'])
    expect(monos('Čeština', 'Dílna')).toEqual(['Č', 'D'])
  })

  it('has a mark even for a name with no letters in it', () => {
    expect(monos('', 'Work')).toEqual(['?', 'W'])
  })

  it('caps at two characters', () => {
    expect(monos('Alpha Beta Gamma', 'Alpha Delta').every((m) => m.length <= 2)).toBe(true)
  })
})

describe('claudeDirMark — only with two or more', () => {
  const dirs: ClaudeDirName[] = [
    { id: 1, name: 'Personal', path: '/Users/jan/.claude', account: 'jan@gmail.com' },
    { id: 2, name: 'Work', path: '/Users/jan/.claude-work', account: null },
  ]

  it('marks a session of a configured directory', () => {
    expect(claudeDirMark(dirs, 2)).toEqual({
      id: 2,
      mono: 'W',
      name: 'Work',
      title: 'Claude directory: Work · ~/.claude-work',
    })
  })

  it('marks nothing with a single directory, or for a directory the list does not hold', () => {
    expect(claudeDirMark([dirs[0]], 1)).toBeNull()
    expect(claudeDirMark(dirs, 9)).toBeNull()
    expect(claudeDirMark(dirs, undefined)).toBeNull()
  })
})

describe('claudeDirTooltip and claudeDirDisplayPath', () => {
  it('names the path and the account only when known', () => {
    expect(claudeDirTooltip({ id: 1, name: 'Work', path: '/Users/jan/.claude-work', account: 'jan@acme.com' })).toBe(
      'Claude directory: Work · ~/.claude-work · jan@acme.com',
    )
    expect(claudeDirTooltip({ id: 1, name: 'Work' })).toBe('Claude directory: Work')
  })

  it('writes the home directory as ~ and leaves other paths alone', () => {
    expect(claudeDirDisplayPath('/Users/jan/.claude')).toBe('~/.claude')
    expect(claudeDirDisplayPath('/home/jan/.claude-work')).toBe('~/.claude-work')
    expect(claudeDirDisplayPath('/Users/jan')).toBe('~')
    expect(claudeDirDisplayPath('/opt/claude')).toBe('/opt/claude')
    // Not a home directory, only a name that starts like one.
    expect(claudeDirDisplayPath('/Usersx/jan/.claude')).toBe('/Usersx/jan/.claude')
  })
})

describe('claudeDirPrefill — a missing directory falls through', () => {
  const dirs: ClaudeDirName[] = [
    { id: 1, name: 'Personal', exists: true },
    { id: 2, name: 'Work', exists: false },
    { id: 3, name: 'Client' },
  ]

  it('says which step chose', () => {
    expect(claudeDirPrefill({ dirs, planet: 3, last: 1, fallback: 1 })).toEqual({ id: 3, from: 'planet' })
    expect(claudeDirPrefill({ dirs, planet: null, last: 1, fallback: 3 })).toEqual({ id: 1, from: 'last' })
    expect(claudeDirPrefill({ dirs, planet: null, last: null, fallback: 3 })).toEqual({ id: 3, from: 'default' })
  })

  it('skips a directory missing on disk at every step', () => {
    expect(claudeDirPrefill({ dirs, planet: 2, last: 2, fallback: 3 })).toEqual({ id: 3, from: 'default' })
    expect(claudeDirPrefill({ dirs, planet: 2, last: 2, fallback: 2 })).toEqual({ id: 1, from: 'first' })
  })

  it('opens on the first directory when every one is missing, rather than on nothing', () => {
    const gone = dirs.map((d) => ({ ...d, exists: false }))
    expect(claudeDirPrefill({ dirs: gone, planet: 2, last: 3, fallback: 1 })).toEqual({ id: 1, from: 'first' })
  })
})

describe('nextClaudeDir — ⌘D', () => {
  const dirs: ClaudeDirName[] = [
    { id: 1, name: 'Personal' },
    { id: 5, name: 'Work', exists: false },
    { id: 7, name: 'Client' },
  ]

  it('steps in Settings order, skipping missing directories, and wraps around', () => {
    expect(nextClaudeDir(dirs, 1)).toBe(7)
    expect(nextClaudeDir(dirs, 7)).toBe(1)
  })

  it('starts at the first choosable directory when nothing is chosen', () => {
    expect(nextClaudeDir(dirs, null)).toBe(1)
  })

  it('stays put when no other directory can be chosen', () => {
    expect(nextClaudeDir([{ id: 1, name: 'Personal' }, { id: 2, name: 'Work', exists: false }], 1)).toBe(1)
  })
})
