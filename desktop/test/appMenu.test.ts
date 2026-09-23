import { describe, expect, it, vi } from 'vitest';
import { appMenuTemplate, type MenuItemTemplate } from '../src/lib/appMenu';

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
