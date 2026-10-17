import { describe, expect, it } from 'vitest'
import { catalogRead } from '../lib/useClaudeDirModels'

describe('catalogRead', () => {
  it("reads this device's own catalog only for a directory other than the default", () => {
    expect(catalogRead(3, undefined, true, 1)).toEqual({ key: 'd:3', dir: 3 })
    expect(catalogRead(1, undefined, true, 1)).toBeNull()
    expect(catalogRead(3, undefined, false, 1)).toBeNull()
    expect(catalogRead(null, undefined, true, 1)).toBeNull()
  })

  it("reads another device's catalog for its own directory, whatever this device holds", () => {
    // Its directory 1 is its own, even where it is this device's default.
    expect(catalogRead(1, 'build', true, 1)).toEqual({ key: 'm:build:1', dir: 1 })
    expect(catalogRead(2, 'build', false, null)).toEqual({ key: 'm:build:2', dir: 2 })
    expect(catalogRead(null, 'build', true, 1)).toEqual({ key: 'm:build:', dir: undefined })
    expect(catalogRead(2, 'build', true, 1)?.key).not.toBe(catalogRead(2, 'air', true, 1)?.key)
  })
})
