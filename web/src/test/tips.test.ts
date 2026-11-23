import { describe, expect, it } from 'vitest'
import {
  TIP_GROUPS,
  allTipsMeta,
  groupTips,
  hasUnseenTips,
  markedSeen,
  parseSeenTips,
  tipOrder,
  tipPosition,
  type Tip,
} from '../lib/tips'
import { TIPS } from '../tips/tipList'

// Spec 2026-11-16-tips-design § What it opens, § Where tips come from.
const tip = (id: string, group: Tip['group'] = 'Sessions'): Tip => ({ id, group, text: id })
const LIST = [tip('a'), tip('b', 'Elsewhere'), tip('c'), tip('d', 'Keyboard and input')]

describe('parseSeenTips', () => {
  it('reads a fresh install, and anything that is not a list of ids, as nothing seen', () => {
    for (const raw of [undefined, null, '', 'nope', '{"a":1}', '"a"', 'null']) {
      expect(parseSeenTips(raw).size).toBe(0)
    }
  })

  it('keeps the string ids and drops the rest', () => {
    expect([...parseSeenTips('["a", 3, "", "b", null]')]).toEqual(['a', 'b'])
  })
})

describe('markedSeen', () => {
  it('adds the shown ids and keeps those of tips no longer in the list', () => {
    expect(JSON.parse(markedSeen('["gone"]', ['b', 'a'])!)).toEqual(['a', 'b', 'gone'])
  })

  it('writes nothing when every shown id was seen already', () => {
    expect(markedSeen('["a","b"]', ['a'])).toBeNull()
    expect(markedSeen(undefined, [])).toBeNull()
  })

  it('starts from nothing on a value that does not read', () => {
    expect(JSON.parse(markedSeen('garbage', ['a'])!)).toEqual(['a'])
  })
})

describe('hasUnseenTips', () => {
  it('shows the dot on a fresh install and while any tip is unseen', () => {
    expect(hasUnseenTips(LIST, new Set())).toBe(true)
    expect(hasUnseenTips(LIST, new Set(['a', 'b', 'c']))).toBe(true)
  })

  it('drops it once every tip in the list has been seen, whatever else is remembered', () => {
    expect(hasUnseenTips(LIST, new Set(['a', 'b', 'c', 'd', 'gone']))).toBe(false)
  })
})

describe('tipOrder', () => {
  it('offers the unseen tips first, then the seen ones, each in list order', () => {
    expect(tipOrder(LIST, new Set(['a', 'c'])).map((t) => t.id)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('keeps list order when nothing, or everything, has been seen', () => {
    expect(tipOrder(LIST, new Set()).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(tipOrder(LIST, new Set(['a', 'b', 'c', 'd'])).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('the card', () => {
  it('says on the last tip that Next starts over', () => {
    expect(tipPosition(0, 4)).toBe('1 of 4')
    expect(tipPosition(3, 4)).toBe('4 of 4 · Next starts over')
  })
})

describe('All tips', () => {
  it('groups in the headings’ order, not the order a group first appears in the list', () => {
    expect(groupTips(LIST).map((g) => [g.group, g.tips.map((t) => t.id)])).toEqual([
      ['Sessions', ['a', 'c']],
      ['Keyboard and input', ['d']],
      ['Elsewhere', ['b']],
    ])
  })

  it('counts the new ones only when there are any', () => {
    expect(allTipsMeta(11, 2)).toBe('11 tips · 2 new')
    expect(allTipsMeta(11, 0)).toBe('11 tips')
  })
})

describe('the list', () => {
  it('has unique ids, each under a known heading', () => {
    const ids = TIPS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of TIPS) expect(TIP_GROUPS).toContain(t.group)
  })
})
