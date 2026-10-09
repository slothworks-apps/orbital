/**
 * Electron bridge: the desktop preload exposes `orbitalDesktop` (nothing in
 * a browser). A notification click selects the session it was about — the
 * URL mirror in sessionUrl.ts then records it like any other selection.
 */
type DesktopBridge = {
  onSelectSession?: (cb: (id: string) => void) => void
  notifySettingsChanged?: () => void
  requestNotificationPermission?: () => Promise<unknown>
  openNotificationSettings?: () => void
  detachSession?: (id: string) => void
  focusSession?: (id: string) => void
  onDetachedChanged?: (cb: (ids: string[]) => void) => void
  openInMainWindow?: (path: string) => void
  setSubagentPanel?: (state: SubagentPanelState) => Promise<SubagentPanelAnswer | undefined>
  setWindowButtonsVisible?: (visible: boolean) => void
  onFullScreenChanged?: (cb: (fullScreen: boolean) => void) => void
  setMenuCommands?: (items: MenuCommand[]) => void
  onCommand?: (cb: (id: string) => void) => void
  pathForFile?: (file: File) => string
  chooseDirectory?: (startPath: string) => Promise<unknown>
  onUpdateState?: (cb: (state: UpdateState) => void) => void
  getUpdateState?: () => Promise<UpdateState>
  updateAction?: (action: UpdateAction) => void
  checkForUpdates?: () => Promise<UpdateCheckAnswer>
}

/**
 * An update of the desktop app, as main reports it
 * (`desktop/src/lib/updates.ts` has the same type as `UpdateView` and
 * validates it in the preload; canvas `Feature - App update`).
 *
 * - `available` — found, not downloaded: Download, and × skips it.
 * - `downloading` — the download the user asked for; `percent` is whole.
 * - `ready` — downloaded. `buttons` was fixed when it appeared: `one`
 *   (Restart) or `two` (Restart now · Restart when sessions finish);
 *   `workingCount` is live.
 * - `waiting` — restarts once no Orbital session is working.
 * - `closed` — × on Ready: the receipt that it installs on quit, with OK.
 * - `restarting` — the app is quitting into the update.
 *
 * `checkedAt` is when a check last completed (epoch ms), or null.
 */
export type UpdatePrompt =
  | { phase: 'none' }
  | { phase: 'available'; version: string; totalMB: number }
  | { phase: 'downloading'; version: string; percent: number; totalMB: number }
  | { phase: 'ready'; version: string; workingCount: number; buttons: 'one' | 'two' }
  | { phase: 'waiting'; version: string; workingCount: number }
  | { phase: 'closed'; version: string }
  | { phase: 'restarting'; version: string }

export type UpdateState = UpdatePrompt & { checkedAt: number | null }

/**
 * The prompt's buttons: Available's Download and × (`skip`), Ready's
 * buttons and × (`close`), Waiting's Cancel (`cancel-wait`), the receipt's
 * OK. Ready's single Restart is `restart-when-idle`.
 */
export type UpdateAction =
  | 'download'
  | 'skip'
  | 'restart-now'
  | 'restart-when-idle'
  | 'cancel-wait'
  | 'close'
  | 'ok'

/**
 * What a check found version-wise, as main's update flow took it
 * (`FoundOutcome` in `desktop/src/lib/updates.ts`): `offered` on the map now,
 * `downloading` by itself, `installs-on-quit` (downloaded, its prompt ended),
 * `held` behind a downloaded version waiting for its restart, `skipped`, or
 * `none` while restarting.
 */
export type FoundOutcome = 'offered' | 'downloading' | 'installs-on-quit' | 'held' | 'skipped' | 'none'

/** What a Check now found; `unsupported` in a build that does not update itself. */
export type UpdateCheckAnswer =
  | { kind: 'up-to-date' }
  | { kind: 'found'; version: string; outcome: FoundOutcome }
  | { kind: 'error' }
  | { kind: 'unsupported' }

/** The update half of the bridge, all four or nothing (`updateBridge`). */
export type UpdateBridge = {
  onUpdateState: (cb: (state: UpdateState) => void) => void
  getUpdateState: () => Promise<UpdateState>
  updateAction: (action: UpdateAction) => void
  checkForUpdates: () => Promise<UpdateCheckAnswer>
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

/** Main's answer: the width the window will have once its resize lands. */
export type SubagentPanelAnswer = { widthPx: number }

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
 * The absolute path of a dropped file, when the desktop app can tell — the
 * composer then sends the path and uploads nothing (spec:
 * 2026-10-01-file-attachments-design). Null in a browser, and for a file with
 * no path behind it.
 */
export function desktopPathFor(file: File): string | null {
  try {
    return bridge()?.pathForFile?.(file) || null
  } catch {
    return null
  }
}

/** Whether Browse… can open the native folder picker: the desktop app only. */
export function canChooseDirectory(): boolean {
  return typeof bridge()?.chooseDirectory === 'function'
}

/**
 * The native folder picker, opened at `startPath` (what the field holds).
 * Resolves to the chosen directory, or null when the user cancels.
 */
export async function chooseDirectory(startPath: string): Promise<string | null> {
  const picked = await bridge()?.chooseDirectory?.(startPath)
  return typeof picked === 'string' && picked ? picked : null
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
 * window). Resolves to the width the window will have once the resize lands
 * (spec: 2026-09-24-subagent-list-design § 4), or undefined in the browser.
 */
export async function setSubagentPanel(
  state: SubagentPanelState,
): Promise<SubagentPanelAnswer | undefined> {
  return bridge()?.setSubagentPanel?.(state)
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

/** What macOS said to the tip's Turn on (`desktop/src/lib/notificationPermission.ts`). */
export type NotificationPermissionAnswer = 'granted' | 'denied' | 'unknown'

/**
 * Asks macOS whether Orbital may notify, at the tip's Turn on (spec
 * 2026-10-08-notifications-off-by-default-design § 3). `unknown` when no
 * answer came, and in a browser, which delivers no notifications itself.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionAnswer> {
  try {
    const answer = await bridge()?.requestNotificationPermission?.()
    return answer === 'granted' || answer === 'denied' ? answer : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** System Settings → Notifications, from the refused tip. A no-op in the browser. */
export function openNotificationSettings(): void {
  bridge()?.openNotificationSettings?.()
}

/**
 * The desktop app's update bridge (canvas `Feature - App update`), or null
 * in a browser, on the phone, and in a build whose preload predates Check
 * now: the prompt and Settings › Updates exist only where all four are.
 */
export function updateBridge(): UpdateBridge | null {
  const b = bridge()
  if (!b?.onUpdateState || !b.getUpdateState || !b.updateAction || !b.checkForUpdates) return null
  return {
    onUpdateState: b.onUpdateState,
    getUpdateState: b.getUpdateState,
    updateAction: b.updateAction,
    checkForUpdates: b.checkForUpdates,
  }
}
