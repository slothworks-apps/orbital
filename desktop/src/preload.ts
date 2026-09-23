import { contextBridge, ipcRenderer } from 'electron';
import { parseDetachedIds } from './lib/sessionWindows';

// The bridge the renderer sees. `select-session` is sent by main.ts when the
// user clicks a native notification; `web/src/lib/desktop.ts` is the other end,
// and turns it into an ordinary selection in the store.
contextBridge.exposeInMainWorld('orbitalDesktop', {
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
});
