import { contextBridge, ipcRenderer } from 'electron';

// The bridge the renderer sees. Task 4 (notifications) fills it out; the shape
// is fixed now so main.ts's BrowserWindow wiring does not have to change again.
contextBridge.exposeInMainWorld('orbitalDesktop', {
  onSelectSession(cb: (id: string) => void) {
    ipcRenderer.on('select-session', (_e, id) => cb(String(id)));
  },
});
