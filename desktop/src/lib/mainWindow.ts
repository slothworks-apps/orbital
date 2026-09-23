/**
 * The main window's chrome: no title bar, the traffic lights in the sidebar's
 * row 1, and a drag band across the top that the renderer draws (spec:
 * 2026-09-24-main-window-chrome-design; canvas `Feature - Main window chrome`
 * 24a–24g).
 *
 * These are the decisions main makes about it. Nothing here may import
 * electron (spec 2026-09-16-electron-wrapper-design § 4 "Testing").
 */

/**
 * `set-window-buttons-visible` as main reads it: the renderer asking for the
 * traffic lights to show (sidebar expanded) or hide (sidebar collapsed, 24b).
 * Anything that is not a boolean is dropped rather than coerced — a truthy
 * string must not decide whether the window can be closed with the mouse.
 */
export function parseWindowButtonsVisible(payload: unknown): boolean | null {
  return typeof payload === 'boolean' ? payload : null;
}

/**
 * `full-screen-changed` as the preload reads it. Only a literal `true` is full
 * screen: a malformed message leaves the renderer in the windowed layout, the
 * one where every control still clears the lights.
 */
export function parseFullScreen(payload: unknown): boolean {
  return payload === true;
}

/**
 * What main does with the lights, given what the renderer last asked for:
 * the value to apply, or null to leave them to macOS. A full-screen window has
 * no lights of its own to show or hide (24c), so a request made there is kept
 * and applied on the way out of full screen instead.
 */
export function decideWindowButtons(requested: boolean, fullScreen: boolean): boolean | null {
  return fullScreen ? null : requested;
}
