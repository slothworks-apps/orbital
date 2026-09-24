/**
 * The application menu: macOS's defaults, plus Window → Map (spec:
 * 2026-09-24-page-headers-design § "⌘1"), plus the keymap's menu-worthy
 * commands once the main window's renderer has sent them (spec:
 * 2026-09-23-shortcuts-design § 5).
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
  | 'close'
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

const MENU_NAMES = ['File', 'Session', 'View', 'Window'] as const;

/**
 * One keymap command as the renderer sends it (`web/src/lib/desktop.ts` has
 * the same type; the workspaces do not import each other). `accelerator` is
 * already in Electron's syntax. `registerAccelerator` is the command's
 * `whileTyping`: false means a text field keeps the key.
 */
export type MenuCommand = {
  id: string;
  label: string;
  accelerator: string;
  menu: (typeof MENU_NAMES)[number];
  order: number;
  registerAccelerator: boolean;
};

/** A keymap id: a scope, a dot, a kebab-case name (`session.interrupt`). */
const COMMAND_ID = /^[a-z]+\.[a-z-]+$/;

function parseMenuCommand(item: unknown): MenuCommand | null {
  if (typeof item !== 'object' || item === null) return null;
  const { id, label, accelerator, menu, order, registerAccelerator } = item as Record<string, unknown>;
  if (typeof id !== 'string' || !COMMAND_ID.test(id)) return null;
  if (typeof label !== 'string' || label === '') return null;
  if (typeof accelerator !== 'string' || accelerator === '') return null;
  if (!(MENU_NAMES as readonly unknown[]).includes(menu)) return null;
  if (typeof order !== 'number' || !Number.isInteger(order)) return null;
  if (typeof registerAccelerator !== 'boolean') return null;
  return { id, label, accelerator, menu: menu as MenuCommand['menu'], order, registerAccelerator };
}

/**
 * The renderer's `set-menu-commands` payload, validated: it comes from a web
 * page and ends up in the menu bar. A malformed item is dropped on its own
 * rather than failing the list, and only the known fields are copied, so
 * nothing else a page sends (a `role`, say) reaches `Menu.buildFromTemplate`.
 */
export function parseMenuCommands(payload: unknown): MenuCommand[] {
  if (!Array.isArray(payload)) return [];
  return payload.map(parseMenuCommand).filter((item): item is MenuCommand => item !== null);
}

const SEPARATOR: MenuItemTemplate = { type: 'separator' };

/** The command Window → Map runs. Map itself stays main's own item. */
const MAP_COMMAND = 'global.map';

/**
 * The menu bar. `dev` adds the developer tools. Reload stays in the packaged
 * app, as it was in Electron's default menu: it is the way out of a renderer
 * that stopped updating.
 *
 * With `commands` empty — before the main window's renderer has sent them —
 * this is the menu as it was before the keymap, item for item.
 */
export function appMenuTemplate({
  dev,
  showMap,
  commands = [],
  run = () => {},
  runInMain = () => {},
}: {
  dev: boolean;
  /** Shows and focuses the main window, rebuilding it if it is gone. */
  showMap: () => void;
  commands?: MenuCommand[];
  /** Runs a command id in the window that has focus. */
  run?: (id: string) => void;
  /** Runs a command id in the main window, whichever window has focus. */
  runInMain?: (id: string) => void;
}): MenuItemTemplate[] {
  const devTools: MenuItemTemplate[] = dev ? [{ role: 'toggleDevTools' }] : [];
  const itemsOf = (menu: MenuCommand['menu']): MenuItemTemplate[] =>
    commands
      .filter((command) => command.menu === menu && command.id !== MAP_COMMAND)
      .sort((a, b) => a.order - b.order)
      .map((command) => commandItem(command, run));
  const fileItems = itemsOf('File');
  const sessionItems = itemsOf('Session');
  const viewItems = itemsOf('View');
  const windowItems = itemsOf('Window');

  return [
    { role: 'appMenu' },
    // A role's submenu cannot be added to, so File is spelled out as soon as
    // it holds a command of ours; `close` is the Close Window the role had.
    fileItems.length > 0
      ? { label: 'File', submenu: [...fileItems, SEPARATOR, { role: 'close' }] }
      : { role: 'fileMenu' },
    { role: 'editMenu' },
    ...(sessionItems.length > 0 ? [{ label: 'Session', submenu: sessionItems }] : []),
    {
      label: 'View',
      submenu: [
        ...viewItems,
        ...(viewItems.length > 0 ? [SEPARATOR] : []),
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
        {
          label: 'Map',
          accelerator: 'CmdOrCtrl+1',
          // Showing the window works with no renderer listening — before the
          // page has loaded, or after it crashed; `MAP_COMMAND` then takes a
          // main window that is on another page back to the map. It goes to
          // the main window by name rather than through `run`: right after
          // `showMap` focuses it, the focused window can still be the
          // detached one Map was picked from. The keymap's own Map entry is
          // this item, so `itemsOf` leaves it out.
          click: () => {
            showMap();
            runInMain(MAP_COMMAND);
          },
        },
        ...windowItems,
        SEPARATOR,
        { role: 'front' },
      ],
    },
  ];
}

/**
 * A keymap command as a menu item. Electron's `registerAccelerator: false` —
 * print the key but leave it to the page — is documented for Linux and
 * Windows only (`electron.d.ts`: `@platform linux,win32`), so a command that
 * must not fire in a text field is listed without its accelerator instead
 * (spec 2026-09-23-shortcuts-design § 5). The renderer's own listener
 * handles the key either way, typing guard included.
 */
function commandItem(command: MenuCommand, run: (id: string) => void): MenuItemTemplate {
  return {
    label: command.label,
    ...(command.registerAccelerator ? { accelerator: command.accelerator } : {}),
    click: () => run(command.id),
  };
}
