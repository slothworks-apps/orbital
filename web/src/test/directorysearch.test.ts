import { describe, expect, it } from 'vitest'
import { RECENT_DIRECTORIES, markedPieces, searchDirectories, type DirectoryRow } from '../lib/directorySearch'

const row = (cwd: string, lastAt = 0): DirectoryRow => ({ cwd, lastModel: null, lastAt })
const cwds = (rows: ReturnType<typeof searchDirectories>) => rows.map((m) => m.row.cwd)

describe('searchDirectories', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => row(`/w/p${i}`, 100 - i))

  it('lists the most recent directories for an empty or blank query, nothing marked', () => {
    for (const q of ['', '   ']) {
      const rows = searchDirectories(twelve, q)
      expect(cwds(rows)).toEqual(twelve.slice(0, RECENT_DIRECTORIES).map((r) => r.cwd))
      expect(rows.every((m) => m.nameMarks.length === 0 && m.pathMarks.length === 0)).toBe(true)
    }
  })

  it('finds a query anywhere in the full path, not only the last folder, in the input order', () => {
    const projects = [row('/w/auth-service'), row('/w/web'), row('/w/oauth/web'), row('/w/x/AUTH')]
    expect(cwds(searchDirectories(projects, ' auth '))).toEqual(['/w/auth-service', '/w/oauth/web', '/w/x/AUTH'])
  })

  it('matches across a segment boundary', () => {
    const projects = [row('/Users/t/Projects/slothworks/orbital'), row('/Users/t/Projects/orbital-old')]
    expect(cwds(searchDirectories(projects, 'slothworks/orb'))).toEqual(['/Users/t/Projects/slothworks/orbital'])
  })

  it('needs every word of a query split by spaces, in any order', () => {
    const projects = [row('/Users/t/slothworks/orbital'), row('/Users/t/slothworks/atlas'), row('/Users/t/orbital')]
    expect(cwds(searchDirectories(projects, 'orb sloth'))).toEqual(['/Users/t/slothworks/orbital'])
  })

  it('matches ~ against the home folder it stands for, and the path written out', () => {
    const projects = [row('/Users/tomin/lab/voice-notes'), row('/srv/lab/x')]
    expect(cwds(searchDirectories(projects, '~/lab'))).toEqual(['/Users/tomin/lab/voice-notes'])
    expect(cwds(searchDirectories(projects, '/users/tomin/lab'))).toEqual(['/Users/tomin/lab/voice-notes'])
  })

  it('returns nothing when nothing matches', () => {
    expect(searchDirectories([row('/w/web')], '~/nowhere')).toEqual([])
  })

  it('marks a word in the name when it is there, else in the path, as the path prints', () => {
    const [m] = searchDirectories([row('/Users/t/slothworks/orbital')], 'sloth ORB')
    expect(m.name).toBe('orbital')
    expect(m.path).toBe('~/slothworks/orbital')
    expect(m.nameMarks).toEqual([[0, 3]])
    expect(m.pathMarks).toEqual([[2, 7]])
  })

  it('leaves unmarked a word that matched only the written-out home', () => {
    const [m] = searchDirectories([row('/Users/tomin/lab')], '/users/tomin')
    expect(m.pathMarks).toEqual([])
  })

  it('joins overlapping marks', () => {
    const [m] = searchDirectories([row('/w/authority')], 'auth tho')
    expect(m.nameMarks).toEqual([[0, 5]])
  })
})

describe('markedPieces', () => {
  it('cuts text at the marks', () => {
    expect(markedPieces('orbital', [[0, 3]])).toEqual([
      { text: 'orb', marked: true },
      { text: 'ital', marked: false },
    ])
    expect(markedPieces('abc', [])).toEqual([{ text: 'abc', marked: false }])
  })
})
