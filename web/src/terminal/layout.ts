import { PANEL_GUTTER_PX, SUBAGENT_PANEL_DEFAULT_PX } from '../store/store'

/** 48a: the dock's height until the user drags its top edge. */
export const DOCK_DEFAULT_PX = 380
/** 48a: the lowest the top edge drags to. */
export const DOCK_MIN_PX = 200
/** 48a: the highest it drags to, as a share of the window's height. */
const DOCK_MAX_VIEWPORT_SHARE = 0.6
/** 48a: the dock stops this far short of the detail panel. */
export const DOCK_PANEL_GAP_PX = 12
/** The collapsed sidebar's rail — `Panel`'s collapsed width (canvas 1b). */
export const SIDEBAR_RAIL_PX = 56
/** 48b: the side panel's width, at the right edge in the subagent's slot. */
export const TERMINAL_SIDE_PANEL_PX = 640

/** Where the dock's height is persisted, like the panels' widths. */
export const DOCK_HEIGHT_SETTING = 'terminal_dock_height'

/**
 * Clamps a dock height to [`DOCK_MIN_PX`, `DOCK_MAX_VIEWPORT_SHARE` of the
 * window]. The floor wins on a window too short for both, as the panels'
 * widths resolve the same conflict.
 */
export function clampDockHeight(height: number, viewportHeight: number): number {
  return Math.max(DOCK_MIN_PX, Math.min(viewportHeight * DOCK_MAX_VIEWPORT_SHARE, height))
}

/** `terminal_dock_height` as the layout uses it: parsed, defaulted, clamped. */
export function parseDockHeight(settings: Record<string, string>, viewportHeight: number): number {
  const raw = Number(settings[DOCK_HEIGHT_SETTING])
  return clampDockHeight(raw > 0 ? raw : DOCK_DEFAULT_PX, viewportHeight)
}

/**
 * The dock's horizontal extent in the main window (48a), as offsets from the
 * window's left and right edges: from the gutter past the sidebar (or its
 * rail) to `DOCK_PANEL_GAP_PX` before the detail panel. `detailRightPx` is
 * where the detail panel's right edge sits — past the side slot when one is
 * open, which is how the dock ends at that slot.
 */
export function dockExtent(input: {
  sidebarCollapsed: boolean
  sidebarWidthPx: number
  detailRightPx: number
  detailWidthPx: number
}): { leftPx: number; rightPx: number } {
  const sidebar = input.sidebarCollapsed ? SIDEBAR_RAIL_PX : input.sidebarWidthPx
  return {
    leftPx: PANEL_GUTTER_PX + sidebar + PANEL_GUTTER_PX,
    rightPx: input.detailRightPx + input.detailWidthPx + DOCK_PANEL_GAP_PX,
  }
}

/**
 * How wide the side slot's occupant asks to be, or 0 with the slot empty. A
 * subagent, ▣ output or harness wins the slot over the terminal (48b): the
 * terminal steps aside until it is closed.
 */
export function sideSlotWidth(agentPanelOpen: boolean, terminalSideShown: boolean): number {
  if (agentPanelOpen) return SUBAGENT_PANEL_DEFAULT_PX
  return terminalSideShown ? TERMINAL_SIDE_PANEL_PX : 0
}
