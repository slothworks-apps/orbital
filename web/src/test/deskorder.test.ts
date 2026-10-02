import { describe, it, expect } from 'vitest'
import { anchorForMatMove, cardOrder, matOrder } from '../map/desk/order'

const a = { tagId: 1, x: -10, y: 0 }
const b = { tagId: 2, x: 0, y: 5 }
const c = { tagId: 3, x: 10, y: -5 }

describe('desk order', () => {
  it('orders mats by anchor x, then top first, then tag id', () => {
    expect(matOrder([c, a, b]).map((m) => m.tagId)).toEqual([1, 2, 3])
    const top = { tagId: 9, x: 0, y: 8 }
    expect(matOrder([b, top]).map((m) => m.tagId)).toEqual([9, 2])
    const twin = { tagId: 4, x: 0, y: 5 }
    expect(matOrder([twin, b]).map((m) => m.tagId)).toEqual([2, 4])
  })

  it('writes an anchor that re-sorts the moved mat into its new slot', () => {
    const ordered = [a, b, c]
    for (const [from, to] of [
      [0, 3],
      [0, 2],
      [2, 0],
      [2, 1],
      [1, 0],
      [1, 3],
    ] as const) {
      const next = anchorForMatMove(ordered, from, to)
      expect(next).not.toBeNull()
      const moved = { ...ordered[from], ...next! }
      const after = matOrder(ordered.map((m, i) => (i === from ? moved : m))).map((m) => m.tagId)
      const expected = ordered.filter((_, i) => i !== from).map((m) => m.tagId)
      expected.splice(to > from ? to - 1 : to, 0, ordered[from].tagId)
      expect(after).toEqual(expected)
      expect(next!.y).toBe(ordered[from].y)
    }
  })

  it('does nothing for a drop on its own slot', () => {
    expect(anchorForMatMove([a, b, c], 1, 1)).toBeNull()
  })

  it('keeps cards in id order whatever order they come in', () => {
    const items = ['s3', 's1', 's2'].map((id) => ({ session: { id } }))
    expect(cardOrder(items).map((i) => i.session.id)).toEqual(['s1', 's2', 's3'])
  })
})
