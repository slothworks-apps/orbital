import { describe, it, expect } from 'vitest'
import { parseWalkthroughRoute, walkthroughPath } from '../walkthrough/route'

describe('parseWalkthroughRoute', () => {
  it('names the session for exactly one segment', () => {
    expect(parseWalkthroughRoute('/walkthrough/abc')).toBe('abc')
    expect(parseWalkthroughRoute('/walkthrough/abc/')).toBe('abc')
    expect(parseWalkthroughRoute('/walkthrough/a%20b')).toBe('a b')
  })
  it('is null for anything else', () => {
    expect(parseWalkthroughRoute('/')).toBeNull()
    expect(parseWalkthroughRoute('/walkthrough')).toBeNull()
    expect(parseWalkthroughRoute('/walkthrough/')).toBeNull()
    expect(parseWalkthroughRoute('/walkthrough/a/b')).toBeNull()
    expect(parseWalkthroughRoute('/walkthroughs/a')).toBeNull()
    expect(parseWalkthroughRoute('/walkthrough/%E0%A4%A')).toBeNull()
  })
  it('round-trips through walkthroughPath', () => {
    expect(parseWalkthroughRoute(walkthroughPath('id with space'))).toBe('id with space')
  })
})
