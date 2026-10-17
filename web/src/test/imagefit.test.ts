import { describe, expect, it } from 'vitest'
import { IMAGE_MAX_EDGE, firstFitScale, nextFitScale } from '../lib/imageFit'

describe('bringing an image down to size', () => {
  it('starts at full size, or at the API\'s longest edge', () => {
    expect(firstFitScale(3000, 2000)).toBe(1)
    expect(firstFitScale(16000, 4000)).toBe(IMAGE_MAX_EDGE / 16000)
  })

  it('aims each try under the ceiling by area, and always smaller than the last', () => {
    // 20 MB at full size: the area has to go to a quarter, the edge to about half.
    const next = nextFitScale(1, 20, 5)
    expect(next).toBeLessThan(0.5)
    expect(next).toBeGreaterThan(0.4)
    // Barely over: still a real step down, never the same scale again.
    expect(nextFitScale(0.5, 5.01, 5)).toBeLessThanOrEqual(0.45)
  })
})
