import { describe, expect, it } from 'vitest'
import { moveTagTo, slotToIndex } from '../lib/tagFilter'
import { HUE_SWATCHES, nextTagHue } from '../lib/tagHues'

const tags = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
const ids = (list: { id: number }[]) => list.map((t) => t.id)

/** A drop into gap `slot`, as the sidebar's chip row does it. */
const dropInto = (tagId: number, slot: number) =>
  ids(moveTagTo(tags, tagId, slotToIndex(tags.findIndex((t) => t.id === tagId), slot)))

describe('tag reorder', () => {
  it('drops a tag into the gap under the pointer, either way along the row', () => {
    expect(dropInto(1, 3)).toEqual([2, 3, 1, 4])
    expect(dropInto(1, 4)).toEqual([2, 3, 4, 1])
    expect(dropInto(4, 0)).toEqual([4, 1, 2, 3])
    expect(dropInto(3, 1)).toEqual([1, 3, 2, 4])
  })

  it('leaves the order alone for a drop next to the tag itself', () => {
    expect(moveTagTo(tags, 2, slotToIndex(1, 1))).toBe(tags)
    expect(moveTagTo(tags, 2, slotToIndex(1, 2))).toBe(tags)
  })

  it('clamps an index past either end and ignores an unknown tag', () => {
    expect(ids(moveTagTo(tags, 2, 99))).toEqual([1, 3, 4, 2])
    expect(ids(moveTagTo(tags, 3, -5))).toEqual([3, 1, 2, 4])
    expect(moveTagTo(tags, 9, 0)).toBe(tags)
  })
})

describe('nextTagHue', () => {
  it('takes the first swatch no tag wears, then goes round', () => {
    expect(nextTagHue([{ hue: 210 }, { hue: 290 }])).toBe(250)
    expect(nextTagHue(HUE_SWATCHES.map((hue) => ({ hue })))).toBe(HUE_SWATCHES[0])
  })
})
