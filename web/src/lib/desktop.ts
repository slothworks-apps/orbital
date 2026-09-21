/**
 * Electron bridge: the desktop preload exposes `orbitalDesktop` (nothing in
 * a browser). A notification click selects the session it was about — the
 * URL mirror in sessionUrl.ts then records it like any other selection.
 */
export function initDesktopBridge(select: (id: string) => Promise<void>): void {
  const bridge = (
    window as {
      orbitalDesktop?: { onSelectSession?: (cb: (id: string) => void) => void }
    }
  ).orbitalDesktop
  bridge?.onSelectSession?.((id) => {
    void select(id)
  })
}
