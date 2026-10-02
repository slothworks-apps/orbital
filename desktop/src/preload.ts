import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { parseFullScreen } from './lib/mainWindow';
import { parseDetachedIds } from './lib/sessionWindows';

// The bridge the renderer sees. `select-session` is sent by main.ts when the
// user clicks a native notification; `web/src/lib/desktop.ts` is the other end,
// and turns it into an ordinary selection in the store.
contextBridge.exposeInMainWorld('orbitalDesktop', {
  // A dropped file's own path, so the composer can hand the agent the file
  // where it lies instead of uploading a copy (spec:
  // 2026-10-01-file-attachments-design). Empty for a file with no path behind
  // it — pasted from the clipboard, dragged out of a mail.
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
  onSelectSession(cb: (id: string) => void) {
    ipcRenderer.on('select-session', (_e, id) => cb(String(id)));
  },
  // The renderer is the only thing that writes settings, so it is also the
  // only thing that can tell main.ts the notification rows moved. Carries no
  // payload: main re-reads `GET /api/settings` rather than trust a message
  // (spec 2026-09-21-settings-sections-design § 5).
  notifySettingsChanged() {
    ipcRenderer.send('settings-changed');
  },
  // Detached session windows: main owns the list and is the only thing that
  // can bring a window forward, so the renderer asks rather than acts
  // (spec: 2026-09-23-detached-session-windows-design). Only the main window
  // ever hears `detached-changed`.
  detachSession(id: string) {
    ipcRenderer.send('detach-session', id);
  },
  focusSession(id: string) {
    ipcRenderer.send('focus-session', id);
  },
  onDetachedChanged(cb: (ids: string[]) => void) {
    ipcRenderer.on('detached-changed', (_e, ids) => cb(parseDetachedIds(ids)));
  },
  // A detached window's walkthrough control: main loads the page in the main
  // window and brings it forward (spec: 2026-09-24-page-headers-design). Main
  // lets only a walkthrough path through.
  openInMainWindow(path: string) {
    ipcRenderer.send('open-in-main-window', path);
  },
  // A detached window's subagent panel opened or closed: main grows the
  // window to make room, and shrinks it back (spec:
  // 2026-09-23-detached-session-windows-design § The subagent panel in the
  // window). Main validates the payload; the main window's is ignored. The
  // promise resolves to `{ widthPx }`, the window's width once the resize
  // lands, or undefined when main did not take the message.
  setSubagentPanel(state: unknown): Promise<unknown> {
    return ipcRenderer.invoke('session-window-subagent', state);
  },
  // The main window's chrome (spec: 2026-09-24-main-window-chrome-design):
  // the sidebar hides the traffic lights while it is collapsed, and main says
  // when the window enters or leaves full screen, where the drag band goes.
  // Main heeds the first only from the main window and sends the second only
  // to it.
  setWindowButtonsVisible(visible: boolean) {
    ipcRenderer.send('set-window-buttons-visible', visible);
  },
  onFullScreenChanged(cb: (fullScreen: boolean) => void) {
    ipcRenderer.on('full-screen-changed', (_e, fullScreen) => cb(parseFullScreen(fullScreen)));
  },
  // The keymap's menu (spec: 2026-09-23-shortcuts-design § 5): the main
  // window sends its menu-worthy commands once, and main rebuilds the menu
  // bar from them after validating the list; a detached window's list is
  // ignored. A menu item then comes back as `command` to whichever window
  // has focus, detached ones included, which runs it through its dispatcher.
  setMenuCommands(items: unknown) {
    ipcRenderer.send('set-menu-commands', items);
  },
  onCommand(cb: (id: string) => void) {
    ipcRenderer.on('command', (_e, id) => cb(String(id)));
  },
});
