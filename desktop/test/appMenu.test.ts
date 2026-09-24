import { describe, expect, it, vi } from 'vitest';
import {
  appMenuTemplate,
  parseMenuCommands,
  type MenuCommand,
  type MenuItemTemplate,
} from '../src/lib/appMenu';

function flatten(items: MenuItemTemplate[]): MenuItemTemplate[] {
  return items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);
}

function roles(dev: boolean): (string | undefined)[] {
  return flatten(appMenuTemplate({ dev, showMap: () => {} })).map((item) => item.role);
}

describe('appMenuTemplate', () => {
  it('keeps the defaults a replaced menu would lose, packaged and in dev', () => {
    for (const dev of [false, true]) {
      // Quit and Close Window live in appMenu and fileMenu; editMenu is what
      // makes ⌘C/⌘V work in an input; `window` is the list ⌘` cycles.
      expect(roles(dev)).toEqual(
        expect.arrayContaining(['appMenu', 'fileMenu', 'editMenu', 'window', 'minimize', 'reload']),
      );
    }
  });

  it('has the developer tools only in dev', () => {
    expect(roles(true)).toContain('toggleDevTools');
    expect(roles(false)).not.toContain('toggleDevTools');
  });

  it('puts Map in the Window menu, on ⌘1, showing the main window', () => {
    const showMap = vi.fn();
    const windowMenu = appMenuTemplate({ dev: false, showMap }).find((item) => item.role === 'window');
    const map = windowMenu?.submenu?.find((item) => item.label === 'Map');
    expect(map?.accelerator).toBe('CmdOrCtrl+1');
    map?.click?.();
    expect(showMap).toHaveBeenCalledOnce();
  });
});

const ITEM: MenuCommand = {
  id: 'global.new-session',
  label: 'New session',
  accelerator: 'CmdOrCtrl+N',
  menu: 'File',
  order: 1,
  registerAccelerator: true,
};

function cmd(overrides: Partial<MenuCommand>): MenuCommand {
  return { ...ITEM, ...overrides };
}

/** A list shaped like the keymap's, deliberately out of order within each menu. */
const COMMANDS: MenuCommand[] = [
  cmd({ id: 'global.search', label: 'Search sessions', accelerator: 'CmdOrCtrl+K', menu: 'View', order: 3 }),
  cmd({ id: 'map.fit', label: 'Fit the map', accelerator: 'CmdOrCtrl+F', menu: 'View', order: 1 }),
  cmd({ id: 'global.new-session' }),
  cmd({ id: 'session.pin', label: 'Pin / unpin', accelerator: 'CmdOrCtrl+P', menu: 'Session', order: 4 }),
  cmd({
    id: 'session.interrupt',
    label: 'Interrupt the run',
    accelerator: 'CmdOrCtrl+.',
    menu: 'Session',
    order: 1,
    registerAccelerator: false,
  }),
  cmd({ id: 'global.next-session', label: 'Next session', accelerator: 'Ctrl+Tab', menu: 'Window', order: 3 }),
  cmd({ id: 'global.stats', label: 'Stats', accelerator: 'CmdOrCtrl+2', menu: 'Window', order: 2 }),
  cmd({ id: 'global.map', label: 'Map', accelerator: 'CmdOrCtrl+1', menu: 'Window', order: 1 }),
];

function withCommands(commands: MenuCommand[] = COMMANDS) {
  const run = vi.fn();
  const runInMain = vi.fn();
  const showMap = vi.fn();
  const template = appMenuTemplate({ dev: false, showMap, commands, run, runInMain });
  const top = (name: string) => template.find((item) => item.label === name || item.role === name);
  return { template, top, run, runInMain, showMap };
}

/** What a submenu shows, one entry per item: its label, else its role, else `separator`. */
function names(items: MenuItemTemplate[] | undefined): (string | undefined)[] {
  return (items ?? []).map((item) => item.label ?? item.role ?? item.type);
}

describe('parseMenuCommands', () => {
  it('accepts a valid list', () => {
    expect(parseMenuCommands(COMMANDS)).toEqual(COMMANDS);
  });

  it('yields nothing for a payload that is not an array', () => {
    for (const payload of [undefined, null, 'global.map', 42, { 0: ITEM }]) {
      expect(parseMenuCommands(payload)).toEqual([]);
    }
  });

  it('drops a malformed item and keeps the rest', () => {
    const bad: unknown[] = [
      null,
      'global.map',
      { ...ITEM, id: 'Global.Map' },
      { ...ITEM, id: 'global' },
      { ...ITEM, id: 'global.map.x' },
      { ...ITEM, id: 'global.map;rm' },
      { ...ITEM, label: '' },
      { ...ITEM, label: 7 },
      { ...ITEM, accelerator: '' },
      { ...ITEM, accelerator: undefined },
      { ...ITEM, menu: 'Help' },
      { ...ITEM, order: 1.5 },
      { ...ITEM, order: '1' },
      { ...ITEM, registerAccelerator: 'false' },
    ];
    expect(parseMenuCommands([...bad, ITEM])).toEqual([ITEM]);
  });

  it('keeps only the known fields of an item', () => {
    expect(parseMenuCommands([{ ...ITEM, click: 'x', role: 'quit' }])).toEqual([ITEM]);
  });
});

describe('appMenuTemplate with commands', () => {
  it('is today’s menu when the list is empty', () => {
    const { template, top } = withCommands([]);
    expect(template.map((item) => item.role ?? item.label)).toEqual([
      'appMenu',
      'fileMenu',
      'editMenu',
      'View',
      'window',
    ]);
    expect(top('fileMenu')?.submenu).toBeUndefined();
    expect(names(top('View')?.submenu)[0]).toBe('reload');
    expect(names(top('window')?.submenu)).toEqual([
      'minimize',
      'zoom',
      'separator',
      'Map',
      'separator',
      'front',
    ]);
  });

  it('puts the File commands in a File menu, ahead of Close Window', () => {
    const { template, top } = withCommands();
    expect(template.some((item) => item.role === 'fileMenu')).toBe(false);
    expect(names(top('File')?.submenu)).toEqual(['New session', 'separator', 'close']);
  });

  it('adds a Session menu between Edit and View, ordered by order', () => {
    const { template, top } = withCommands();
    expect(template.map((item) => item.role ?? item.label)).toEqual([
      'appMenu',
      'File',
      'editMenu',
      'Session',
      'View',
      'window',
    ]);
    expect(names(top('Session')?.submenu)).toEqual(['Interrupt the run', 'Pin / unpin']);
  });

  it('has no Session menu without Session commands', () => {
    const { template } = withCommands(COMMANDS.filter((c) => c.menu !== 'Session'));
    expect(template.some((item) => item.label === 'Session')).toBe(false);
  });

  it('puts the View commands ahead of the reload group', () => {
    const { top } = withCommands();
    expect(names(top('View')?.submenu).slice(0, 4)).toEqual([
      'Fit the map',
      'Search sessions',
      'separator',
      'reload',
    ]);
  });

  it('lists Map once, then the other Window commands, then Bring All to Front', () => {
    const { top } = withCommands();
    expect(names(top('window')?.submenu)).toEqual([
      'minimize',
      'zoom',
      'separator',
      'Map',
      'Stats',
      'Next session',
      'separator',
      'front',
    ]);
  });

  it('runs a command item’s id on click', () => {
    const { top, run } = withCommands();
    top('Session')
      ?.submenu?.find((item) => item.label === 'Pin / unpin')
      ?.click?.();
    expect(run).toHaveBeenCalledExactlyOnceWith('session.pin');
  });

  it('has Map show the window first, then run global.map in the main window', () => {
    const { top, run, runInMain, showMap } = withCommands();
    const map = top('window')?.submenu?.find((item) => item.label === 'Map');
    expect(map?.accelerator).toBe('CmdOrCtrl+1');
    map?.click?.();
    expect(showMap).toHaveBeenCalledOnce();
    // Not `run`: the focused window may still be the detached one.
    expect(run).not.toHaveBeenCalled();
    expect(runInMain).toHaveBeenCalledExactlyOnceWith('global.map');
    expect(showMap.mock.invocationCallOrder[0]).toBeLessThan(runInMain.mock.invocationCallOrder[0]);
  });

  it('prints an accelerator only for a key macOS may claim', () => {
    const session = withCommands().top('Session')?.submenu ?? [];
    const interrupt = session.find((item) => item.label === 'Interrupt the run');
    const pin = session.find((item) => item.label === 'Pin / unpin');
    expect(interrupt).toBeDefined();
    expect(interrupt).not.toHaveProperty('accelerator');
    expect(pin?.accelerator).toBe('CmdOrCtrl+P');
  });
});
