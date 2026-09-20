import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { expandHome } from '../paths.js';

/** Over this, the viewer refuses rather than the render path suffering —
 * `too_large` is decided from the stat alone, without reading a byte. */
export const FILE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

/** How far into the file the binary sniff looks for a NUL byte. Sniffing,
 * not the extension, decides — a UTF-8 `.dat` opens. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Media type per extension for the `binary` refusal's label. Deliberately
 * small: the viewer only names what it will not show. */
const BINARY_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  wasm: 'application/wasm',
};

/** What `resolveInsideCwd` found: a real path that is inside the sandbox, a
 * path that names nothing, or one that leads out of it. */
export type ConfinedPath =
  | { kind: 'ok'; path: string }
  | { kind: 'not_found' }
  | { kind: 'outside' };

/**
 * Resolves a path a client asked for against a session's cwd and refuses
 * anything that is not inside it.
 *
 * This is the whole security story for every route that takes a path, which is
 * why it is one function rather than a rule each of them re-implements: the
 * file viewer's read (`readFilePreview`) and the composer's `@` completion
 * (`completeFilePath`) confine identically.
 *
 * Both sides are realpath'd before comparing, so a symlink inside cwd pointing
 * out resolves to where it actually leads and is refused — the spelling of the
 * path never decides. A path that does not exist answers `not_found` before
 * the confinement check runs: realpath is what resolves the symlinks, and
 * there is nothing to resolve for a path that is not there.
 */
export function resolveInsideCwd(cwd: string, rawPath: string): ConfinedPath {
  // No cwd, no sandbox — nothing to confine to means nothing is inside.
  if (!cwd) return { kind: 'outside' };

  const expanded = expandHome(rawPath);
  const candidate = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);

  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    // ENOENT and ENOTDIR both mean the path names nothing on disk.
    return { kind: 'not_found' };
  }

  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    // A sandbox that itself is gone confines nothing.
    return { kind: 'outside' };
  }
  // The separator matters: without it, `/w/x-evil` would pass for `/w/x`.
  // cwd itself is inside cwd — which `readFilePreview` does not care about (a
  // directory is not previewable) but completion does: `@` with no prefix
  // lists the project root.
  if (resolved !== realCwd && !resolved.startsWith(realCwd + sep)) return { kind: 'outside' };

  return { kind: 'ok', path: resolved };
}

export type PreviewResult =
  | { kind: 'ok'; content: string; size: number; mtimeMs: number; lines: number }
  | { kind: 'not_found' }
  | { kind: 'outside' }
  | { kind: 'too_large'; size: number }
  | { kind: 'binary'; size: number; mediaType: string };

/**
 * Reads a file for the viewer, refusals first
 * (spec: 2026-09-19-file-viewer-design § Server). The session's cwd is the
 * sandbox and `resolveInsideCwd` is what holds the path to it.
 */
export function readFilePreview(cwd: string, rawPath: string): PreviewResult {
  const confined = resolveInsideCwd(cwd, rawPath);
  if (confined.kind !== 'ok') return confined;
  const resolved = confined.path;

  const stat = statSync(resolved);
  if (stat.isDirectory()) return { kind: 'not_found' };
  if (stat.size > FILE_PREVIEW_MAX_BYTES) return { kind: 'too_large', size: stat.size };

  const bytes = readFileSync(resolved);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(resolved)?.[1]?.toLowerCase();
    return {
      kind: 'binary',
      size: stat.size,
      mediaType: (ext && BINARY_MEDIA_TYPES[ext]) || 'binary',
    };
  }

  const content = bytes.toString('utf8');
  let lines = 1;
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lines++;
  return { kind: 'ok', content, size: stat.size, mtimeMs: stat.mtimeMs, lines };
}
