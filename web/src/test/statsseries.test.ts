import { describe, it, expect } from 'vitest'
import type { StatsDayBusy } from '../lib/types'
import { fillDaySeries } from '../stats/series'

const day = (key: string, apiMs: number): StatsDayBusy => ({
  day: key,
  apiMs,
  localToolMs: 0,
  mcpMs: 0,
  subagentMs: 0,
  busyMs: apiMs,
})

/** Local noon on a given date — the day key never depends on the clock time. */
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime()

describe('fillDaySeries', () => {
  it('returns one column per calendar day in the window, gaps zeroed', () => {
    const filled = fillDaySeries([day('2026-09-16', 1000)], at(2026, 9, 14), at(2026, 9, 20))
    expect(filled.map((d) => d.day)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ])
    expect(filled[2].apiMs).toBe(1000)
    expect(filled[0]).toMatchObject({ apiMs: 0, localToolMs: 0, mcpMs: 0, subagentMs: 0, busyMs: 0 })
  })

  it('spans month and year ends', () => {
    expect(fillDaySeries([], at(2026, 12, 30), at(2027, 1, 2)).map((d) => d.day)).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ])
  })

  it('starts at the first measured day when the window has no start', () => {
    const filled = fillDaySeries([day('2026-09-18', 5)], null, at(2026, 9, 20))
    expect(filled.map((d) => d.day)).toEqual(['2026-09-18', '2026-09-19', '2026-09-20'])
  })

  it('leaves an unbounded, empty window empty rather than inventing a column', () => {
    expect(fillDaySeries([], null, at(2026, 9, 20))).toEqual([])
  })

  it('does not fill a range too wide to draw — the measured days stand alone', () => {
    const measured = [day('2020-01-01', 1), day('2026-09-20', 2)]
    expect(fillDaySeries(measured, null, at(2026, 9, 20))).toEqual(measured)
  })

  it('keeps the series sorted even if the source is not', () => {
    const filled = fillDaySeries(
      [day('2026-09-15', 2), day('2026-09-14', 1)],
      at(2026, 9, 14),
      at(2026, 9, 15)
    )
    expect(filled.map((d) => d.apiMs)).toEqual([1, 2])
  })
})
