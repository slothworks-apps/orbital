import { describe, expect, it } from 'vitest'
import { PHOTO_MAX_EDGE } from '../mobile/constants'
import { fitWithin, photoName } from '../mobile/photo'

describe('fitWithin', () => {
  it('brings the long edge of a landscape photo to the edge and scales the other in proportion', () => {
    expect(fitWithin(4032, 3024, PHOTO_MAX_EDGE)).toEqual({ w: 1568, h: 1176, scaled: true })
  })

  it('does the same for a portrait photo', () => {
    expect(fitWithin(3024, 4032, PHOTO_MAX_EDGE)).toEqual({ w: 1176, h: 1568, scaled: true })
  })

  it('leaves a photo already within the edge as it is', () => {
    expect(fitWithin(800, 600, PHOTO_MAX_EDGE)).toEqual({ w: 800, h: 600, scaled: false })
  })

  it('leaves a photo exactly at the edge as it is', () => {
    expect(fitWithin(1568, 1000, PHOTO_MAX_EDGE)).toEqual({ w: 1568, h: 1000, scaled: false })
  })

  it('never rounds a thin strip down to an edge of 0', () => {
    expect(fitWithin(10000, 1, PHOTO_MAX_EDGE)).toEqual({ w: 1568, h: 1, scaled: true })
    expect(fitWithin(1, 10000, PHOTO_MAX_EDGE)).toEqual({ w: 1, h: 1568, scaled: true })
  })
})

describe('photoName', () => {
  it('names a photo as a camera does, from the local time of day', () => {
    expect(photoName(new Date(2026, 9, 2, 9, 5, 7))).toBe('IMG_090507.jpg')
    expect(photoName(new Date(2026, 9, 2, 23, 59, 0))).toBe('IMG_235900.jpg')
  })
})
