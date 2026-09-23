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
}

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
}): void {
  bridge()?.onSelectSession?.((id) => {
    void handlers.select(id)
  })
  bridge()?.onDetachedChanged?.((ids) => handlers.setDetached(ids))
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
 * Tell the desktop app that settings were saved, so its notifier re-reads
 * them (spec 2026-09-21-settings-sections-design § 5). The main process
 * cannot see a PATCH — the settings table is not a WebSocket topic — and the
 * renderer is the only thing that writes one, so this is both exact and
 * nearly free. A no-op in the browser.
 */
export function notifyDesktopSettingsChanged(): void {
  bridge()?.notifySettingsChanged?.()
}
