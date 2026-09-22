import { describe, it, expect, afterEach, vi } from 'vitest'
import { sessionViewTransitionName, withViewTransition } from '../lib/viewTransition'

// ---------------------------------------------------------------------------
// withViewTransition — only the branching is tested. Whether the browser then
// tweens the row is the browser's business and jsdom has no opinion on it.
// ---------------------------------------------------------------------------

const realStartViewTransition = Reflect.get(document, 'startViewTransition')
const realMatchMedia = window.matchMedia

afterEach(() => {
  if (realStartViewTransition === undefined) Reflect.deleteProperty(document, 'startViewTransition')
  else Reflect.set(document, 'startViewTransition', realStartViewTransition)
  window.matchMedia = realMatchMedia
})

/** Stands in for the API jsdom does not implement, running the callback at once. */
function stubStartViewTransition() {
  const start = vi.fn((callback: () => void) => {
    callback()
    return {} as ViewTransition
  })
  Reflect.set(document, 'startViewTransition', start)
  return start
}

function stubReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) =>
    ({ matches: reduce && query.includes('prefers-reduced-motion'), media: query }) as MediaQueryList)
}

describe('withViewTransition', () => {
  it('applies synchronously where the API is missing — jsdom, and Firefox', () => {
    expect(Reflect.get(document, 'startViewTransition')).toBeUndefined()
    const apply = vi.fn()
    withViewTransition(apply)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('skips the transition under prefers-reduced-motion, still applying', () => {
    const start = stubStartViewTransition()
    stubReducedMotion(true)
    const apply = vi.fn()
    withViewTransition(apply)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
  })

  it('goes through the API when it exists and motion is allowed', () => {
    const start = stubStartViewTransition()
    stubReducedMotion(false)
    const apply = vi.fn()
    withViewTransition(apply)
    expect(start).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// sessionViewTransitionName — a name that collides pairs two different rows
// and aborts the transition, so the escaping is the part worth pinning.
// ---------------------------------------------------------------------------

describe('sessionViewTransitionName', () => {
  it('passes a UUID through unchanged behind the prefix', () => {
    const id = '3f2a9c1e-4b7d-4a20-8e11-0c5d6b9a7e33'
    expect(sessionViewTransitionName(id)).toBe(`orbital-session-${id}`)
  })

  it('produces a valid custom ident for an id that starts with a digit', () => {
    expect(sessionViewTransitionName('42')).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/)
  })

  it('escapes everything outside the ident alphabet', () => {
    expect(sessionViewTransitionName('a:b')).toBe('orbital-session-a_3a_b')
    expect(sessionViewTransitionName('a b')).toBe('orbital-session-a_20_b')
  })

  it('never collides two ids on one name', () => {
    const ids = ['a:b', 'a-b', 'a_b', 'a b', 'a.b', 'a_3a_b', 'ab', 'a/b']
    const names = new Set(ids.map(sessionViewTransitionName))
    expect(names.size).toBe(ids.length)
    for (const name of names) expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/)
  })
})
