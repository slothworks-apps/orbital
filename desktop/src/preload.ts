import { contextBridge, ipcRenderer } from 'electron';

// The bridge the renderer sees. `select-session` is sent by main.ts when the
// user clicks a native notification; `web/src/lib/desktop.ts` is the other end,
// and turns it into an ordinary selection in the store.
contextBridge.exposeInMainWorld('orbitalDesktop', {
  onSelectSession(cb: (id: string) => void) {
    ipcRenderer.on('select-session', (_e, id) => cb(String(id)));
  },
});
