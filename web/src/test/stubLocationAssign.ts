import { vi } from 'vitest'

/**
 * Records `window.location.assign` calls, returning the spy and a restore.
 *
 * jsdom cannot navigate, and `Location.assign` is unforgeable, so it cannot be
 * spied on in place. `window.location` itself is configurable here: this swaps
 * in a proxy that reads through to the real location (the URL mirror and
 * `pathname` checks still need it) and answers `assign` with the spy.
 */
export function stubLocationAssign(): { assign: ReturnType<typeof vi.fn>; restore: () => void } {
  const assign = vi.fn()
  const real = window.location
  const original = Object.getOwnPropertyDescriptor(window, 'location')!
  // An empty target: a proxy over `real` itself may not answer `assign`
  // differently, because that property is non-configurable on it.
  const proxy = new Proxy({} as Location, {
    get(_, key) {
      if (key === 'assign') return assign
      const value: unknown = Reflect.get(real, key, real)
      return typeof value === 'function' ? (value as () => unknown).bind(real) : value
    },
  })
  Object.defineProperty(window, 'location', { configurable: true, get: () => proxy })
  return { assign, restore: () => Object.defineProperty(window, 'location', original) }
}
