import { contextBridge, ipcRenderer } from 'electron';

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
});
