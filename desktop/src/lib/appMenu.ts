/**
 * The application menu: macOS's defaults, plus Window → Map (spec:
 * 2026-09-24-page-headers-design § "⌘1").
 *
 * A menu of our own replaces Electron's default one whole, so every default
 * something relies on is put back here by its role: Quit (which goes through
 * `app.quit()`, and so through the quit guard), Close Window, Minimize, the
 * window list ⌘` cycles, and the Edit roles — without those, ⌘C and ⌘V do
 * nothing in an input on macOS.
 *
 * Nothing here may import electron (spec 2026-09-16-electron-wrapper-design
 * § 4 "Testing"); the shape below is the subset of Electron's
 * `MenuItemConstructorOptions` this menu uses, and main hands it to
 * `Menu.buildFromTemplate` as it is.
 */

export type MenuRole =
  | 'appMenu'
  | 'fileMenu'
  | 'editMenu'
  | 'window'
  | 'minimize'
  | 'zoom'
  | 'front'
  | 'reload'
  | 'forceReload'
  | 'toggleDevTools'
  | 'resetZoom'
  | 'zoomIn'
  | 'zoomOut'
  | 'togglefullscreen';

export interface MenuItemTemplate {
  role?: MenuRole;
  label?: string;
  accelerator?: string;
  type?: 'separator';
  click?: () => void;
  submenu?: MenuItemTemplate[];
}

const SEPARATOR: MenuItemTemplate = { type: 'separator' };

/**
 * The menu bar. `dev` adds the developer tools. Reload stays in the packaged
 * app, as it was in Electron's default menu: it is the way out of a renderer
 * that stopped updating.
 */
export function appMenuTemplate({
  dev,
  showMap,
}: {
  dev: boolean;
  /** Shows and focuses the main window, rebuilding it if it is gone. */
  showMap: () => void;
}): MenuItemTemplate[] {
  const devTools: MenuItemTemplate[] = dev ? [{ role: 'toggleDevTools' }] : [];
  return [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...devTools,
        SEPARATOR,
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        SEPARATOR,
        { role: 'togglefullscreen' },
      ],
    },
    {
      // `window`, not `windowMenu`: the latter's items are fixed, and Map has
      // to sit among them. The role is what makes macOS list the open windows
      // here and cycle them on ⌘`. An application menu's accelerator answers
      // in whichever Orbital window has focus, a detached one included.
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        SEPARATOR,
        { label: 'Map', accelerator: 'CmdOrCtrl+1', click: showMap },
        SEPARATOR,
        { role: 'front' },
      ],
    },
  ];
}
