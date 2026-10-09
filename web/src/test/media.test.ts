import { describe, expect, it } from 'vitest'
import type { MediaItem } from '../lib/types'
import {
  matchMediaItem,
  mediaCountLine,
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

describe('mediaTiles', () => {
  it('lists newest first and stacks each run of one tool call into one tile', () => {
    const tiles = mediaTiles(SESSION, false)
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
    const stack = mediaTiles(SESSION, false).find((t) => t.count === 5)!
    expect(stack.first.id).toBe('2')
  })

  it('does not stack two runs that sit next to each other', () => {
    const tiles = mediaTiles([tool('a', 'x'), tool('b', 'x'), tool('c', 'y')], false)
    expect(tiles.map((t) => t.count)).toEqual([1, 2])
  })

  it('does not stack frames of one run that something else came between', () => {
    const tiles = mediaTiles([tool('a', 'x'), you('b'), tool('c', 'x')], false)
    expect(tiles.map((t) => t.count)).toEqual([1, 1, 1])
  })

  it('leaves tool frames out entirely while they are hidden', () => {
    expect(mediaTiles(SESSION, true).map((t) => t.cover.id)).toEqual(['11', '8', '7', '1'])
  })

  it('stacks nothing for a tool frame without a run', () => {
    const loose = { ...tool('a', 'x'), toolRun: undefined }
    expect(mediaTiles([loose, { ...loose, id: 'b' }], false).map((t) => t.count)).toEqual([1, 1])
  })
})

describe('paging', () => {
  it('walks oldest first through every frame of a stack', () => {
    expect(ids(pagingOrder(SESSION, false))).toEqual(ids(SESSION))
  })

  it('never lands on a hidden tool frame, and counts only what is shown', () => {
    const order = pagingOrder(SESSION, true)
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
    const order = pagingOrder(SESSION, true)
    expect(order[positionIn(order, SESSION, '4')].id).toBe('7')
    expect(order[positionIn(order, SESSION, '10')].id).toBe('11')
  })

  it('falls back to the last shown item when nothing shown follows', () => {
    const all = [you('1'), tool('2', 'r')]
    const order = pagingOrder(all, true)
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
  it('counts what is shown and names what the switch hides', () => {
    expect(mediaCountLine(SESSION, false)).toBe('MEDIA · 11 · 7 tool')
    expect(mediaCountLine(SESSION, true)).toBe('MEDIA · 4 · 7 tool hidden')
    expect(mediaCountLine([you('1')], false)).toBe('MEDIA · 1')
  })

  it('has nothing to show when only hidden tool frames exist', () => {
    const only = [tool('1', 'r'), tool('2', 'r')]
    expect(visibleMedia(only, true)).toEqual([])
    expect(mediaCountLine(only, true)).toBe('MEDIA · 0 · 2 tool hidden')
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
