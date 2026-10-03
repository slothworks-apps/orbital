import { isAbsolute } from 'node:path';

/**
 * Where the New session dialog's Browse… opens the native folder picker: the
 * directory already typed in the field, so Browse… starts next to what the
 * user was looking at. The field may hold `~/…` (the server expands it at the
 * API boundary, decision tilde-expands-at-the-api-boundary), which the picker
 * does not, so it is expanded here. Anything else that is not an absolute
 * path — empty, relative, not a string — opens on the home directory.
 */
export function pickerStartPath(payload: unknown, home: string): string {
  if (typeof payload !== 'string') return home;
  const typed = payload.trim();
  if (typed === '~') return home;
  if (typed.startsWith('~/')) return home + typed.slice(1);
  return isAbsolute(typed) ? typed : home;
}
