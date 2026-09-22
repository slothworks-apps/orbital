import { describe, it, expect } from 'vitest'
import {
  formatCost,
  formatCostAmount,
  formatDeltaPercent,
  formatFindingTime,
  formatPercent,
  formatPoints,
  formatSessionSpan,
  formatStatsDuration,
  formatTokens,
  formatToolName,
  splitTokens,
} from '../stats/format'

describe('formatStatsDuration', () => {
  it('spells anything under a minute in tenths of a second', () => {
    expect(formatStatsDuration(1200)).toBe('1.2s')
    expect(formatStatsDuration(400)).toBe('0.4s')
    expect(formatStatsDuration(0)).toBe('0.0s')
    expect(formatStatsDuration(11_300)).toBe('11.3s')
    expect(formatStatsDuration(59_900)).toBe('59.9s')
  })

  it('spells anything under an hour as minutes and zero-padded seconds', () => {
    expect(formatStatsDuration(250_000)).toBe('4m 10s')
    expect(formatStatsDuration(1_744_000)).toBe('29m 04s')
    expect(formatStatsDuration(60_000)).toBe('1m 00s')
  })

  it('spells an hour or more as hours and zero-padded minutes, never days', () => {
    expect(formatStatsDuration(7_500_000)).toBe('2h 05m')
    expect(formatStatsDuration(148_320_000)).toBe('41h 12m')
  })

  it('carries a rounded remainder into the next unit instead of printing 60', () => {
    // 59.96s would print as "60.0s" if the seconds were rounded in place.
    expect(formatStatsDuration(59_960)).toBe('1m 00s')
    // 59m 59.6s would print as "59m 60s".
    expect(formatStatsDuration(3_599_600)).toBe('1h 00m')
  })

  it('floors a negative span at zero rather than printing a sign', () => {
    expect(formatStatsDuration(-5_000)).toBe('0.0s')
  })
})

describe('formatTokens', () => {
  it('abbreviates to three significant figures', () => {
    expect(formatTokens(12_400_000)).toBe('12.4M')
    expect(formatTokens(11_600_000)).toBe('11.6M')
    expect(formatTokens(812_000)).toBe('812k')
    expect(formatTokens(84_000)).toBe('84k')
  })

  it('drops the zeros three significant figures would pad with', () => {
    expect(formatTokens(1_200)).toBe('1.2k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(2_000_000)).toBe('2M')
    expect(formatTokens(10_000)).toBe('10k')
  })

  it('prints a count below a thousand whole', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(148)).toBe('148')
    expect(formatTokens(999)).toBe('999')
  })

  it('promotes a count that rounds up into the next unit', () => {
    // 999.5k is three significant figures away from 1000k, which is not a unit.
    expect(formatTokens(999_500)).toBe('1M')
    expect(formatTokens(999_999_500)).toBe('1000M')
  })

  it('splits the unit off for the tiles, which set it in its own type size', () => {
    expect(splitTokens(12_400_000)).toEqual({ value: '12.4', unit: 'M' })
    expect(splitTokens(812_000)).toEqual({ value: '812', unit: 'k' })
    expect(splitTokens(42)).toEqual({ value: '42', unit: '' })
  })
})

describe('formatCost', () => {
  it('always prints two decimals', () => {
    expect(formatCost(148.2)).toBe('$148.20')
    expect(formatCost(1.7)).toBe('$1.70')
    expect(formatCost(1.7249)).toBe('$1.72')
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCostAmount(27.6)).toBe('27.60')
  })
})

describe('formatPercent', () => {
  it('rounds a ratio to a whole percent', () => {
    expect(formatPercent(0.68)).toBe('68%')
    expect(formatPercent(0.684)).toBe('68%')
    expect(formatPercent(0.686)).toBe('69%')
    expect(formatPercent(1)).toBe('100%')
  })

  it('signs a window-over-window delta, which arrives already in percent', () => {
    expect(formatDeltaPercent(18.4)).toBe('+18%')
    expect(formatDeltaPercent(-12.6)).toBe('−13%')
    expect(formatDeltaPercent(0)).toBe('+0%')
  })

  it('signs a difference of two ratios in points', () => {
    expect(formatPoints(-0.09)).toBe('−9 pts')
    expect(formatPoints(0.04)).toBe('+4 pts')
  })
})

describe('formatToolName', () => {
  it('reads an MCP tool as server and tool', () => {
    expect(formatToolName('mcp__sentry__search_issues')).toBe('sentry.search_issues')
    expect(formatToolName('mcp__playwright__navigate')).toBe('playwright.navigate')
  })

  it('leaves a built-in tool alone', () => {
    expect(formatToolName('Bash')).toBe('Bash')
    expect(formatToolName('NotebookEdit')).toBe('NotebookEdit')
  })

  it('splits on the double underscore only, so single ones survive', () => {
    expect(formatToolName('mcp__my_server__my_tool')).toBe('my_server.my_tool')
  })

  it('returns a malformed MCP name unchanged rather than mangling it', () => {
    expect(formatToolName('mcp__lonely')).toBe('lonely')
  })
})

describe('formatFindingTime', () => {
  const now = new Date(2026, 8, 20, 9, 30).getTime()

  it('stamps the current calendar day with the time', () => {
    expect(formatFindingTime(new Date(2026, 8, 20, 14, 2).getTime(), now)).toBe('today 14:02')
  })

  it('stamps yesterday by calendar day, not by elapsed hours', () => {
    // 23:50 last night is under 12 hours ago and still "yest".
    expect(formatFindingTime(new Date(2026, 8, 19, 21, 36).getTime(), now)).toBe('yest 21:36')
  })

  it('dates anything older', () => {
    const label = formatFindingTime(new Date(2026, 8, 17, 8, 0).getTime(), now)
    expect(label).toMatch(/17/)
    expect(label).toMatch(/Sep/)
  })
})

describe('formatSessionSpan', () => {
  const start = new Date(2026, 8, 18, 13, 4).getTime()

  it('dates the start and leaves the end as a time on the same day', () => {
    const span = formatSessionSpan(start, new Date(2026, 8, 18, 14, 41).getTime())
    expect(span).toMatch(/18/)
    expect(span).toMatch(/Sep/)
    expect(span).toMatch(/13:04 → 14:41$/)
  })

  it('dates the end too when the session crossed midnight', () => {
    const span = formatSessionSpan(start, new Date(2026, 8, 19, 1, 12).getTime())
    expect(span).toMatch(/→ .*19.*01:12$/)
  })

  it('says nothing it does not know', () => {
    expect(formatSessionSpan(null, null)).toBe('—')
    expect(formatSessionSpan(start, null)).toMatch(/→ —$/)
  })
})
