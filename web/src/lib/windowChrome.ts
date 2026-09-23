import { useEffect, useRef, useSyncExternalStore } from 'react'
import { hasDesktopBridge, setWindowButtonsVisible } from './desktop'
import { SIDEBAR_COLLAPSE_MS } from '../ui/motion'

/**
 * The main desktop window's own chrome (spec:
 * 2026-09-24-main-window-chrome-design; canvas `Feature - Main window chrome`
 * 24a–24g). The window has no title bar, so the page draws what stands in for
 * one: a band across the top that drags the window, a hint that marks it, and
 * room in the sidebar's row 1 for the traffic lights. None of it exists in a
 * browser, and none of it in full screen (24c), where macOS draws its own.
 */

/**
 * Height of the band that drags the window, from the top edge to just below
 * the HUD row (24a). Camera fit keeps the sessions clear of it as well.
 */
export const WINDOW_DRAG_BAND_PX = 48

/**
 * Whether the window chrome is drawn: in the desktop app, out of full screen.
 * Every piece of it (band, hint, row 1's room for the lights, fit's top inset)
 * asks this one question, so they cannot disagree.
 */
export function hasWindowBand(env: { desktop: boolean; fullScreen: boolean }): boolean {
  return env.desktop && !env.fullScreen
}

/** How far down the map's top edge is covered by window chrome, for camera fit. */
export function mapTopInset(env: { desktop: boolean; fullScreen: boolean }): number {
  return hasWindowBand(env) ? WINDOW_DRAG_BAND_PX : 0
}

/**
 * What the sidebar's collapsed state asks of the traffic lights, and when.
 *
 * The lights hide at the START of a collapse and show at the END of an
 * expand: in between they would overhang the narrowing rail (24b). The first
 * sync after a load has nothing to animate from, so it applies at once.
 */
export function windowButtonsChange(
  collapsed: boolean,
  initial: boolean
): { visible: boolean; delayMs: number } {
  if (collapsed || initial) return { visible: !collapsed, delayMs: 0 }
  return { visible: true, delayMs: SIDEBAR_COLLAPSE_MS }
}

// Full screen is pushed by main (`full-screen-changed`, on every change and
// on every load); until the first push the window is taken to be windowed.
let fullScreen = false
const listeners = new Set<() => void>()

/** Where the bridge lands `full-screen-changed`; see `initDesktopBridge`. */
export function setWindowFullScreen(value: boolean): void {
  if (value === fullScreen) return
  fullScreen = value
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * What the window chrome depends on, live: whether this is the desktop app,
 * and whether its window is full screen. Every consumer re-renders from the
 * same push, so the whole layout swaps in one frame (24c). Only the main
 * window hears full screen; a detached window has chrome of its own (22b) and
 * does not ask.
 */
export function useWindowChromeEnv(): { desktop: boolean; fullScreen: boolean } {
  const isFullScreen = useSyncExternalStore(subscribe, () => fullScreen)
  return { desktop: hasDesktopBridge(), fullScreen: isFullScreen }
}

/** Whether this page draws the window chrome right now; see `hasWindowBand`. */
export function useWindowBand(): boolean {
  return hasWindowBand(useWindowChromeEnv())
}

/**
 * Keeps the main window's traffic lights in step with the sidebar (24a, 24b),
 * timed by `windowButtonsChange`. A collapse that turns back before the expand
 * finished cancels the pending show. Full screen is main's to handle: it keeps
 * the last request and applies it on the way out.
 */
export function useSidebarWindowButtons(collapsed: boolean): void {
  const synced = useRef(false)
  useEffect(() => {
    if (!hasDesktopBridge()) return
    const change = windowButtonsChange(collapsed, !synced.current)
    synced.current = true
    if (change.delayMs === 0) {
      setWindowButtonsVisible(change.visible)
      return
    }
    const timer = setTimeout(() => setWindowButtonsVisible(change.visible), change.delayMs)
    return () => clearTimeout(timer)
  }, [collapsed])
}
