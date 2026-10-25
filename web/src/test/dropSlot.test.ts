import { describe, expect, it } from 'vitest'
import { dropSlot, movesItem } from '../lib/dropSlot'

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height })

describe('dropSlot in a wrapping chip row', () => {
  // Two lines: chips 0 and 1 on the first, chip 2 alone on the second.
  const chips = [rect(0, 0, 40, 20), rect(46, 0, 40, 20), rect(0, 26, 40, 20)]

  it('picks the gap before the first chip whose middle is right of the pointer', () => {
    expect(dropSlot(chips, 10, 10, 'row', 3)).toMatchObject({ slot: 0, bar: { x: -3, y: 0, height: 20 } })
    expect(dropSlot(chips, 30, 10, 'row', 3)).toMatchObject({ slot: 1, bar: { x: 43 } })
  })

  it('takes the gap after the last chip of the line the pointer is on', () => {
    expect(dropSlot(chips, 80, 10, 'row', 3)).toMatchObject({ slot: 2, bar: { x: 89, y: 0 } })
    expect(dropSlot(chips, 35, 36, 'row', 3)).toMatchObject({ slot: 3, bar: { x: 43, y: 26 } })
  })

  it('uses the nearest line for a pointer between or past the lines', () => {
    expect(dropSlot(chips, 5, 60, 'row', 3)?.slot).toBe(2)
    expect(dropSlot(chips, 5, -15, 'row', 3)?.slot).toBe(0)
  })
})

describe('dropSlot in a column of cards', () => {
  const cards = [rect(0, 0, 200, 40), rect(0, 46, 200, 60)]

  it('lies flat above the first card whose middle is below the pointer, or after the last', () => {
    expect(dropSlot(cards, 50, 10, 'column', 3)).toEqual({ slot: 0, bar: { x: 0, y: -3, width: 200, height: 0 } })
    expect(dropSlot(cards, 50, 30, 'column', 3)).toMatchObject({ slot: 1, bar: { y: 43 } })
    expect(dropSlot(cards, 50, 100, 'column', 3)).toMatchObject({ slot: 2, bar: { y: 109 } })
  })

  it('has no gap in an empty list', () => {
    expect(dropSlot([], 0, 0, 'column', 3)).toBeNull()
  })
})

describe('movesItem', () => {
  it('is false for the gaps either side of the dragged item', () => {
    expect(movesItem(2, 2)).toBe(false)
    expect(movesItem(2, 3)).toBe(false)
    expect(movesItem(2, 1)).toBe(true)
    expect(movesItem(2, 4)).toBe(true)
  })
})
