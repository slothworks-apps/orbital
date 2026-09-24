/**
 * Electron bridge: the desktop preload exposes `orbitalDesktop` (nothing in
 * a browser). A notification click selects the session it was about — the
 * URL mirror in sessionUrl.ts then records it like any other selection.
 */
type DesktopBridge = {
  onSelectSession?: (cb: (id: string) => void) => void
  notifySettingsChanged?: () => void
  detachSession?: (id: string) => void
  focusSession?: (id: string) => void
  onDetachedChanged?: (cb: (ids: string[]) => void) => void
  openInMainWindow?: (path: string) => void
  setSubagentPanel?: (state: SubagentPanelState) => void
  setWindowButtonsVisible?: (visible: boolean) => void
  onFullScreenChanged?: (cb: (fullScreen: boolean) => void) => void
  setMenuCommands?: (items: MenuCommand[]) => void
  onCommand?: (cb: (id: string) => void) => void
}

/**
 * One keymap command as the desktop menu lists it (`menuCommands` in
 * `keymap.ts` builds the list; `desktop/src/lib/appMenu.ts` has the same type
 * and validates it). `accelerator` is in Electron's syntax;
 * `registerAccelerator` is the command's `whileTyping`.
 */
export type MenuCommand = {
  id: string
  label: string
  accelerator: string
  menu: 'File' | 'Session' | 'View' | 'Window'
  order: number
  registerAccelerator: boolean
}

/**
 * The subagent panel's state in a detached window, as main needs it to size
 * the window: how much room the panel wants, and how wide the window must be
 * to hold both panels at their minimums without growing.
 */
export type SubagentPanelState =
  | { open: true; widthPx: number; pairMinPx: number }
  | { open: false }

function bridge(): DesktopBridge | undefined {
  return (window as { orbitalDesktop?: DesktopBridge }).orbitalDesktop
}

/**
 * Whether this page runs inside the desktop app. The detach control asks
 * this: focusing and closing a window are things only Electron does reliably,
 * so a browser gets no control at all rather than one that opens a tab it
 * cannot bring back (spec: 2026-09-23-detached-session-windows-design).
 */
export function hasDesktopBridge(): boolean {
  return bridge() !== undefined
}

/**
 * The main window's half of the bridge: notification clicks select, and the
 * detached list lands in the store. Called only for the main window — a
 * detached window never receives the list, which is what keeps its own
 * `select` from being redirected to focusing itself (spec:
 * 2026-09-23-detached-session-windows-design § The detached window).
 */
export function initDesktopBridge(handlers: {
  select: (id: string) => Promise<void>
  setDetached: (ids: string[]) => void
  setFullScreen: (fullScreen: boolean) => void
}): void {
  bridge()?.onSelectSession?.((id) => {
    void handlers.select(id)
  })
  bridge()?.onDetachedChanged?.((ids) => handlers.setDetached(ids))
  bridge()?.onFullScreenChanged?.((fullScreen) => handlers.setFullScreen(fullScreen))
}

/**
 * Shows or hides the main window's traffic lights: the collapsed sidebar has
 * no room for them (canvas `Feature - Main window chrome` 24b). A no-op in
 * the browser, and main ignores it from a detached window.
 */
export function setWindowButtonsVisible(visible: boolean): void {
  bridge()?.setWindowButtonsVisible?.(visible)
}

/**
 * Hands main the keymap's menu-worthy commands, which it builds the menu bar
 * from (spec: 2026-09-23-shortcuts-design § 5). Sent by the main window
 * only; main ignores a detached window's. A no-op in the browser.
 */
export function setMenuCommands(items: MenuCommand[]): void {
  bridge()?.setMenuCommands?.(items)
}

/**
 * A menu item picked, or its accelerator pressed, while this window had
 * focus: `cb` gets the command id. Every window listens, a detached one
 * included. Registers a listener for the page's lifetime, so it is called
 * once per page load. A no-op in the browser.
 */
export function onCommand(cb: (id: string) => void): void {
  bridge()?.onCommand?.(cb)
}

/** Opens the session in its own window, or focuses the one it already has. */
export function detachSession(id: string): void {
  bridge()?.detachSession?.(id)
}

/** Brings a detached session's window to the front. */
export function focusSession(id: string): void {
  bridge()?.focusSession?.(id)
}

/**
 * Loads an in-app page in the main window and brings it forward — how a
 * detached window opens its walkthrough without giving up its own panel
 * (spec: 2026-09-24-page-headers-design § "Walkthrough from a detached
 * window"). Main takes only a walkthrough path. A no-op in the browser.
 */
export function openInMainWindow(path: string): void {
  bridge()?.openInMainWindow?.(path)
}

/**
 * Tells main that this detached window's subagent panel opened or closed, so
 * the window grows to make room and shrinks back (spec:
 * 2026-09-23-detached-session-windows-design § The subagent panel in the
 * window). A no-op in the browser.
 */
export function setSubagentPanel(state: SubagentPanelState): void {
  bridge()?.setSubagentPanel?.(state)
}

/**
 * Tell the desktop app that settings were saved, so its notifier re-reads
 * them (spec 2026-09-21-settings-sections-design § 5). The main process
 * cannot see a PATCH — the settings table is not a WebSocket topic — and the
 * renderer is the only thing that writes one, so this is both exact and
 * nearly free. A no-op in the browser.
 */
export function notifyDesktopSettingsChanged(): void {
  bridge()?.notifySettingsChanged?.()
}
