import { isAbsolute } from 'node:path';

/**
 * The path the media viewer's Show in Finder asks main to reveal (spec
 * 2026-10-26-media-viewer-context-menu-design), or null for anything that is
 * not one. It comes from a page, so only an absolute path gets through:
 * `shell.showItemInFolder` resolves nothing on its own, and a relative path
 * would be resolved against wherever main happens to run.
 */
export function parseRevealPath(payload: unknown): string | null {
  if (typeof payload !== 'string' || payload.includes('\0')) return null;
  return isAbsolute(payload) ? payload : null;
}
