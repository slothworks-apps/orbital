import { describe, it, expect } from 'vitest'
import { parseSessionWindowRoute } from '../lib/sessionWindowRoute'

// spec: 2026-09-23-detached-session-windows-design § The detached window
describe('parseSessionWindowRoute', () => {
  it('reads the id of /session/<id>', () => {
    expect(parseSessionWindowRoute('/session/abc-123')).toBe('abc-123')
  })

  it('tolerates a trailing slash', () => {
    expect(parseSessionWindowRoute('/session/abc-123/')).toBe('abc-123')
  })

  it('decodes a percent-encoded id', () => {
    expect(parseSessionWindowRoute('/session/a%2Fb%20c')).toBe('a/b c')
  })

  it('names nothing for an empty id', () => {
    expect(parseSessionWindowRoute('/session')).toBeNull()
    expect(parseSessionWindowRoute('/session/')).toBeNull()
    expect(parseSessionWindowRoute('/session//')).toBeNull()
  })

  it('names nothing for extra segments', () => {
    expect(parseSessionWindowRoute('/session/abc/more')).toBeNull()
    expect(parseSessionWindowRoute('/session/abc/more/')).toBeNull()
  })

  it('names nothing for a malformed escape', () => {
    expect(parseSessionWindowRoute('/session/%E0%A4%A')).toBeNull()
  })

  it('names nothing for other paths', () => {
    expect(parseSessionWindowRoute('/')).toBeNull()
    expect(parseSessionWindowRoute('/sessions/abc')).toBeNull()
    expect(parseSessionWindowRoute('/sessionabc')).toBeNull()
    expect(parseSessionWindowRoute('/stats/session/abc')).toBeNull()
    expect(parseSessionWindowRoute('/sandbox')).toBeNull()
  })
})
