import { describe, expect, it } from 'vitest'
import type { MediaItem } from '../lib/types'
import {
  matchMediaItem,
  mediaCountLine,
  mediaSourceKey,
  mediaTileCaption,
  parseHiddenSources,
  sourcesSummary,
  mediaTiles,
  mediaToolLabel,
  pagingOrder,
  positionIn,
  stepIndex,
  visibleMedia,
} from '../lib/media'

const you = (id: string, ref = `r-${id}`): MediaItem => ({
  id,
  kind: 'image',
  source: 'you',
  messageId: `m-${id}`,
  ts: '2026-10-09T14:07:00Z',
  ref,
})
const tool = (id: string, run: string): MediaItem => ({
  id,
  kind: 'image',
  source: 'tool',
  messageId: `m-${run}`,
  ts: '2026-10-09T14:09:00Z',
  ref: `r-${id}`,
  toolRun: run,
})
const agent = (id: string, path: string, messageId = `m-${id}`): MediaItem => ({
  id,
  kind: path.endsWith('.pdf') ? 'pdf' : 'image',
  source: 'agent',
  messageId,
  ts: '2026-10-09T14:15:00Z',
  path,
  cwd: '/w',
  disk: 'present',
})

// Canvas 24d's session, oldest first as the server lists it: two tool runs
// of five and two frames around the user's and the agent's items.
const SESSION: MediaItem[] = [
  you('1'),
  tool('2', 'r1'),
  tool('3', 'r1'),
  tool('4', 'r1'),
  tool('5', 'r1'),
  tool('6', 'r1'),
  agent('7', 'docs/spec.pdf'),
  you('8'),
  tool('9', 'r2'),
  tool('10', 'r2'),
  agent('11', 'out/a.png'),
]

const ids = (items: MediaItem[]) => items.map((item) => item.id)
const TOOLS_OFF = ['tool'] as const

describe('mediaTiles', () => {
  it('lists newest first and stacks each run of one tool call into one tile', () => {
    const tiles = mediaTiles(SESSION, [])
    expect(tiles.map((t) => [t.cover.id, t.count])).toEqual([
      ['11', 1],
      ['10', 2],
      ['8', 1],
      ['7', 1],
      ['6', 5],
      ['1', 1],
    ])
  })

  it('opens a stack on its first frame, the oldest of the run', () => {
    const stack = mediaTiles(SESSION, []).find((t) => t.count === 5)!
    expect(stack.first.id).toBe('2')
  })

  it('does not stack two runs that sit next to each other', () => {
    const tiles = mediaTiles([tool('a', 'x'), tool('b', 'x'), tool('c', 'y')], [])
    expect(tiles.map((t) => t.count)).toEqual([1, 2])
  })

  it('does not stack frames of one run that something else came between', () => {
    const tiles = mediaTiles([tool('a', 'x'), you('b'), tool('c', 'x')], [])
    expect(tiles.map((t) => t.count)).toEqual([1, 1, 1])
  })

  it('leaves tool frames out entirely while they are hidden', () => {
    expect(mediaTiles(SESSION, TOOLS_OFF).map((t) => t.cover.id)).toEqual(['11', '8', '7', '1'])
  })

  it('stacks nothing for a tool frame without a run', () => {
    const loose = { ...tool('a', 'x'), toolRun: undefined }
    expect(mediaTiles([loose, { ...loose, id: 'b' }], []).map((t) => t.count)).toEqual([1, 1])
  })
})

describe('paging', () => {
  it('walks oldest first through every frame of a stack', () => {
    expect(ids(pagingOrder(SESSION, []))).toEqual(ids(SESSION))
  })

  it('never lands on a hidden tool frame, and counts only what is shown', () => {
    const order = pagingOrder(SESSION, TOOLS_OFF)
    expect(ids(order)).toEqual(['1', '7', '8', '11'])
    let at = 0
    const seen: string[] = []
    for (let i = 0; i < order.length; i++) {
      at = stepIndex(order.length, at, 1)
      seen.push(order[at].id)
    }
    expect(seen).toEqual(['7', '8', '11', '1'])
  })

  it('wraps at both ends', () => {
    expect(stepIndex(4, 0, -1)).toBe(3)
    expect(stepIndex(4, 3, 1)).toBe(0)
    expect(stepIndex(0, 0, 1)).toBe(-1)
  })

  it('hands a frame the switch just hid to the next shown item after it', () => {
    const order = pagingOrder(SESSION, TOOLS_OFF)
    expect(order[positionIn(order, SESSION, '4')].id).toBe('7')
    expect(order[positionIn(order, SESSION, '10')].id).toBe('11')
  })

  it('falls back to the last shown item when nothing shown follows', () => {
    const all = [you('1'), tool('2', 'r')]
    const order = pagingOrder(all, TOOLS_OFF)
    expect(order[positionIn(order, all, '2')].id).toBe('1')
  })

  it('has no position in an empty order', () => {
    expect(positionIn([], SESSION, '1')).toBe(-1)
  })
})

describe('matchMediaItem', () => {
  it('finds a ref in the message it was pressed in', () => {
    const items = [you('1', 'same'), you('2', 'same')]
    expect(matchMediaItem(items, { kind: 'ref', ref: 'same', messageId: 'm-1' })?.id).toBe('1')
  })

  it('takes the newest mention when the message is not known', () => {
    const items = [agent('1', 'out/a.png'), agent('2', 'out/a.png')]
    expect(matchMediaItem(items, { kind: 'path', path: 'out/a.png' })?.id).toBe('2')
  })

  it('matches a path only against what the agent named', () => {
    expect(matchMediaItem(SESSION, { kind: 'path', path: 'r-1' })).toBeUndefined()
    expect(matchMediaItem(SESSION, { kind: 'path', path: 'nope.png' })).toBeUndefined()
  })
})

describe('mediaCountLine', () => {
  it('gives the total, and how much of it is shown while filtered', () => {
    expect(mediaCountLine(SESSION, [])).toBe('MEDIA · 11')
    expect(mediaCountLine(SESSION, TOOLS_OFF)).toBe('MEDIA · 4 of 11')
  })

  it('has nothing to show when only hidden tool frames exist', () => {
    const only = [tool('1', 'r'), tool('2', 'r')]
    expect(visibleMedia(only, TOOLS_OFF)).toEqual([])
    expect(mediaCountLine(only, TOOLS_OFF)).toBe('MEDIA · 0 of 2')
  })
})

describe('mediaToolLabel', () => {
  it('names an MCP tool by its server and tool, a plugin server by its own name', () => {
    expect(mediaToolLabel('mcp__plugin_playwright_playwright__browser_take_screenshot')).toBe(
      'Playwright · browser take screenshot'
    )
    expect(mediaToolLabel('mcp__figma__get_screenshot')).toBe('Figma · get screenshot')
  })

  it('leaves a built-in tool as it is', () => {
    expect(mediaToolLabel('Read')).toBe('Read')
  })
})

const written: MediaItem = {
  id: 'w', kind: 'image', source: 'written', messageId: 'm-w', ts: '2026-10-13T10:00:00Z', path: 'out/w.png', cwd: '/w', tool: 'Write',
}
const moon = (item: MediaItem, name = 'a11y-audit'): MediaItem => ({ ...item, id: `s-${item.id}`, subagent: { toolUseId: 'toolu_1', name } })

describe('written images', () => {
  const all = [you('1'), written, agent('2', 'out/a.png')]

  it('are their own source, never stacked with a tool run', () => {
    expect(ids(visibleMedia(all, ['saved']))).toEqual(['1', '2'])
    expect(ids(visibleMedia(all, TOOLS_OFF))).toEqual(['1', 'w', '2'])
    expect(mediaTiles([tool('3', 'r'), written, tool('4', 'r')], []).map((t) => t.count)).toEqual([1, 1, 1])
  })

  it('are what a press on the written path opens', () => {
    expect(matchMediaItem(all, { kind: 'path', path: 'out/w.png', messageId: 'm-w' })?.id).toBe('w')
  })
})

describe('sources', () => {
  it("files a subagent's item under Subagents whatever it is underneath", () => {
    expect(mediaSourceKey(moon(tool('1', 'r')))).toBe('subagent')
    expect(mediaSourceKey(moon(agent('2', 'a.png')))).toBe('subagent')
    expect(mediaSourceKey(agent('2', 'a.png'))).toBe('named')
    expect(mediaSourceKey(written)).toBe('saved')
  })

  it("keeps Tools to the parent's own frames", () => {
    const all = [tool('1', 'r'), moon(tool('2', 'r'))]
    expect(ids(visibleMedia(all, TOOLS_OFF))).toEqual(['s-2'])
    expect(ids(visibleMedia(all, ['subagent']))).toEqual(['1'])
  })

  it('always shows a source this client does not know', () => {
    const later = { ...you('1'), source: 'pasted' } as unknown as MediaItem
    expect(visibleMedia([later], ['you', 'tool', 'named', 'saved', 'subagent'])).toHaveLength(1)
  })

  it("does not stack a subagent's frames with the parent's run of the same id", () => {
    expect(mediaTiles([tool('1', 'r'), moon(tool('2', 'r'))], []).map((t) => t.count)).toEqual([1, 1])
  })
})

describe('sourcesSummary', () => {
  it('says All at rest and n of 5 once narrowed', () => {
    expect(sourcesSummary(SESSION, [])).toMatchObject({ label: 'Sources: All', filtered: false, shown: 11, total: 11 })
    expect(sourcesSummary(SESSION, TOOLS_OFF)).toMatchObject({ label: 'Sources: 4 of 5', filtered: true, shown: 4 })
  })

  it('counts a source with no items as on, so nothing hidden never reads as filtered', () => {
    expect(sourcesSummary(SESSION, ['subagent', 'saved'])).toMatchObject({ label: 'Sources: All', filtered: false })
  })

  it('says none when the filter leaves nothing', () => {
    expect(sourcesSummary(SESSION, ['you', 'tool', 'named'])).toMatchObject({ label: 'Sources: none', shown: 0 })
  })
})

describe('mediaTileCaption', () => {
  const tile = (item: MediaItem, count = 1) => ({ key: item.id, cover: item, first: item, count })

  it('names the file when there is one, else the source', () => {
    expect(mediaTileCaption(tile(agent('1', 'out/stepper-390.png')))).toEqual({ text: 'stepper-390.png', named: true, moon: false })
    expect(mediaTileCaption(tile(you('2')))).toEqual({ text: 'Attached by you', named: false, moon: false })
  })

  it("leads a subagent's with the moon, and names a stack by its tool", () => {
    expect(mediaTileCaption(tile(moon(you('3'))))).toEqual({ text: 'a11y-audit', named: false, moon: true })
    const frame = { ...tool('4', 'r'), tool: 'mcp__plugin_playwright_playwright__browser_take_screenshot', path: 'shot.png' }
    expect(mediaTileCaption(tile(frame, 3)).text).toBe('Playwright · browser take screenshot')
  })
})

describe('parseHiddenSources', () => {
  it('reads what was stored, dropping names it does not know', () => {
    expect(parseHiddenSources('["tool","moons","saved"]', false)).toEqual(['tool', 'saved'])
    expect(parseHiddenSources('not json', false)).toEqual([])
    expect(parseHiddenSources('{"tool":true}', false)).toEqual([])
  })

  it('keeps what Hide tool images hid for a session that never had the filter', () => {
    expect(parseHiddenSources(null, true)).toEqual(['tool', 'saved'])
    expect(parseHiddenSources(null, false)).toEqual([])
    expect(parseHiddenSources('[]', true)).toEqual([])
  })
})
