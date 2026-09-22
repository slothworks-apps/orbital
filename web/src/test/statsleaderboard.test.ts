import { describe, it, expect } from 'vitest'
import type { StatsToolRow, StatsTotals } from '../lib/types'
import { LEADERBOARD_VISIBLE_ROWS, leaderboardBars } from '../stats/leaderboard'

const tool = (name: string, ms: number, resultChars = 0): StatsToolRow => ({
  tool: name,
  isMcp: name.startsWith('mcp__'),
  calls: 1,
  errors: 0,
  ms,
  p50Ms: null,
  resultChars,
})

/** Only the three lanes the honest share divides by matter here. */
const totals = (localToolMs: number, mcpMs: number, subagentMs = 0): StatsTotals =>
  ({ localToolMs, mcpMs, subagentMs }) as StatsTotals

describe('leaderboardBars', () => {
  const rows = [tool('mcp__a__b', 3000), tool('Bash', 1500), tool('Grep', 500)]

  it('normalises the bars to the leading row, so the ranking stays readable', () => {
    const bars = leaderboardBars(rows, 'slowest', totals(50_000, 50_000))
    expect(bars.map((b) => b.width)).toEqual([1, 0.5, 1 / 6])
  })

  it('keeps the printed share honest — of the window, not of the leader', () => {
    // 5s of tool time listed out of 100s in the window.
    const bars = leaderboardBars(rows, 'slowest', totals(50_000, 50_000))
    expect(bars.map((b) => b.share)).toEqual([0.03, 0.015, 0.005])
  })

  it('counts the subagent lane as tool time too — a Task call is a tool call', () => {
    const [first] = leaderboardBars([tool('Agent', 1000)], 'slowest', totals(1000, 0, 3000))
    expect(first.share).toBe(0.25)
  })

  it('ranks the expensive tab by result volume, shared against the listed rows', () => {
    const expensive = [tool('Read', 0, 8000), tool('Bash', 0, 2000)]
    const bars = leaderboardBars(expensive, 'mostExpensive', totals(0, 0))
    expect(bars.map((b) => b.width)).toEqual([1, 0.25])
    expect(bars.map((b) => b.share)).toEqual([0.8, 0.2])
  })

  it('draws nothing rather than dividing by zero', () => {
    expect(leaderboardBars([tool('Bash', 0)], 'slowest', totals(0, 0))[0]).toMatchObject({
      width: 0,
      share: 0,
    })
    expect(leaderboardBars([], 'slowest', totals(10, 10))).toEqual([])
  })

  it('never lets a share exceed the whole, however the lanes were counted', () => {
    // A tool whose measured time outruns the window's lanes (a rollup written
    // by an older stats version) must not paint a bar past the track.
    const [first] = leaderboardBars([tool('Bash', 9000)], 'slowest', totals(1000, 0))
    expect(first.share).toBe(1)
  })

  it("shows the canvas's four rows before the rest have to be scrolled to", () => {
    expect(LEADERBOARD_VISIBLE_ROWS).toBe(4)
  })
})
