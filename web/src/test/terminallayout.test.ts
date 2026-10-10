import { describe, expect, it } from 'vitest'
import {
  DOCK_DEFAULT_PX,
  DOCK_MIN_PX,
  SIDEBAR_RAIL_PX,
  TERMINAL_SIDE_PANEL_PX,
  clampDockHeight,
  dockExtent,
  parseDockHeight,
  sideSlotWidth,
} from '../terminal/layout'
import { PANEL_GUTTER_PX, SUBAGENT_PANEL_DEFAULT_PX } from '../store/store'

describe('dockExtent', () => {
  it('runs from past the rail to just before the detail panel', () => {
    // 48a at 1440: the rail collapsed, the detail panel alone at its edge inset.
    const { leftPx, rightPx } = dockExtent({
      sidebarCollapsed: true,
      sidebarWidthPx: 300,
      detailRightPx: PANEL_GUTTER_PX,
      detailWidthPx: 450,
    })
    expect(leftPx).toBe(PANEL_GUTTER_PX + SIDEBAR_RAIL_PX + PANEL_GUTTER_PX)
    expect(rightPx).toBe(478)
  })

  it('starts past an open sidebar', () => {
    const { leftPx } = dockExtent({
      sidebarCollapsed: false,
      sidebarWidthPx: 280,
      detailRightPx: PANEL_GUTTER_PX,
      detailWidthPx: 450,
    })
    expect(leftPx).toBe(PANEL_GUTTER_PX + 280 + PANEL_GUTTER_PX)
  })

  it('ends at the slot when the detail panel has moved left for it', () => {
    const slot = PANEL_GUTTER_PX + SUBAGENT_PANEL_DEFAULT_PX + PANEL_GUTTER_PX
    const alone = dockExtent({ sidebarCollapsed: true, sidebarWidthPx: 300, detailRightPx: PANEL_GUTTER_PX, detailWidthPx: 450 })
    const beside = dockExtent({ sidebarCollapsed: true, sidebarWidthPx: 300, detailRightPx: slot, detailWidthPx: 450 })
    expect(beside.rightPx - alone.rightPx).toBe(slot - PANEL_GUTTER_PX)
  })
})

describe('clampDockHeight', () => {
  it('keeps a height inside the floor and the window share', () => {
    expect(clampDockHeight(100, 900)).toBe(DOCK_MIN_PX)
    expect(clampDockHeight(400, 900)).toBe(400)
    expect(clampDockHeight(800, 900)).toBe(540)
  })

  it('lets the floor win on a window too short for both', () => {
    expect(clampDockHeight(300, 300)).toBe(DOCK_MIN_PX)
  })

  it('defaults a missing or broken setting', () => {
    expect(parseDockHeight({}, 900)).toBe(DOCK_DEFAULT_PX)
    expect(parseDockHeight({ terminal_dock_height: 'tall' }, 900)).toBe(DOCK_DEFAULT_PX)
    expect(parseDockHeight({ terminal_dock_height: '250' }, 900)).toBe(250)
  })
})

describe('sideSlotWidth', () => {
  it('gives the slot to an agent panel over the terminal', () => {
    expect(sideSlotWidth(true, true)).toBe(SUBAGENT_PANEL_DEFAULT_PX)
    expect(sideSlotWidth(false, true)).toBe(TERMINAL_SIDE_PANEL_PX)
    expect(sideSlotWidth(false, false)).toBe(0)
  })
})
