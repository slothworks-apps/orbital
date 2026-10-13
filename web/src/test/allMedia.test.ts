import { describe, it, expect } from 'vitest'
import { allMediaKey, allMediaOrder, allMediaSections, joinPage, keyedMedia, pickTag } from '../lib/allMedia'
import type { AllMediaItem } from '../lib/types'

const item = (sessionId: string, id: string, extra: Partial<AllMediaItem> = {}): AllMediaItem => ({
  id, kind: 'image', source: 'you', messageId: id, ts: '', ref: `${sessionId}${id}`,
  sessionId, sessionTitle: sessionId.toUpperCase(), tagIds: [], ...extra,
})

describe('pickTag', () => {
  it('a plain click keeps only that tag; an additive one toggles it', () => {
    expect(pickTag([1, 2], 3, false)).toEqual([3])
    expect(pickTag([1], 1, false)).toEqual([1])
    expect(pickTag([1], 2, true)).toEqual([1, 2])
    expect(pickTag([1, 2], 1, true)).toEqual([2])
    expect(pickTag([], 4, true)).toEqual([4])
  })
})

describe('joinPage', () => {
  it('appends a page, leaving out what is held by session and id', () => {
    const held = [item('a', '1'), item('a', '2')]
    const joined = joinPage(held, [item('a', '2'), item('b', '2'), item('b', '1')])
    expect(joined.map(allMediaKey)).toEqual(['a/1', 'a/2', 'b/2', 'b/1'])
  })
})

describe('allMediaSections', () => {
  it('groups a session\'s run under its name, joining a run split across pages, tool runs stacked', () => {
    const items = keyedMedia([
      item('a', '3', { source: 'tool', toolRun: 't1' }),
      item('a', '2', { source: 'tool', toolRun: 't1' }),
      item('a', '1'),
      item('b', '1'),
    ])
    const sections = allMediaSections(items, false)
    expect(sections.map((s) => [s.sessionId, s.title, s.tiles.map((t) => [t.cover.id, t.first.id, t.count])])).toEqual([
      ['a', 'A', [['a/3', 'a/2', 2], ['a/1', 'a/1', 1]]],
      ['b', 'B', [['b/1', 'b/1', 1]]],
    ])
  })

  it('leaves out a session whose items Hide tool images hides', () => {
    const items = keyedMedia([item('a', '1', { source: 'tool' }), item('b', '1')])
    expect(allMediaSections(items, true).map((s) => s.sessionId)).toEqual(['b'])
  })
})

describe('allMediaOrder', () => {
  it('pages against the grid, so a stack opened on its first frame walks on through the rest', () => {
    const items = keyedMedia([
      item('a', '3', { source: 'tool', toolRun: 't1' }),
      item('a', '2', { source: 'tool', toolRun: 't1' }),
      item('b', '1'),
    ])
    expect(allMediaOrder(items).map((i) => i.id)).toEqual(['b/1', 'a/2', 'a/3'])
  })
})
