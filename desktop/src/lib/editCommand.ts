/**
 * The edit commands the text context menu asks main to run (spec
 * 2026-11-02-text-context-menu-design): the window's own Cut, Copy, Paste and
 * Select All, which do exactly what their shortcuts do. A name from the page
 * is taken only when it is one of these, so a page cannot reach any other
 * `webContents` method through it.
 */
export const EDIT_COMMANDS = ['cut', 'copy', 'paste', 'selectAll'] as const;
export type EditCommand = (typeof EDIT_COMMANDS)[number];

export function parseEditCommand(payload: unknown): EditCommand | null {
  return (EDIT_COMMANDS as readonly unknown[]).includes(payload) ? (payload as EditCommand) : null;
}
