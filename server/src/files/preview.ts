import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { expandHome } from '../paths.js';
import { dirStamp, fileStamp } from '../transcript/stampedCache.js';
import { subagentDirOf } from '../walkthrough/subagents.js';

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
 * (`completeFilePath`) confine identically. The viewer's reads go through
 * `resolveForSession`, which asks this first and widens only past it.
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

/** Bytes that continue a path: a match with one of these on either side is
 * part of a longer path, so `/tmp/ab` does not name `/tmp/a`. */
const PATH_CHAR = /[A-Za-z0-9._-]/;

/** What also may not come just before a match: `/x` inside `~/x` or `//x`
 * is a different file. */
const LEADING_PATH_CHAR = /[A-Za-z0-9._~/-]/;

/** The letters of JSON's one-character escapes. In a JSONL line,
 * `\n/tmp/shot.png` is a newline before the path, not an `n` glued to it. */
const JSON_ESCAPE_LETTER = /[bfnrt]/;

/**
 * Whether the letter just before `at` is escaped — an odd run of backslashes
 * before it, since `\\n` is an escaped backslash and then a plain `n`.
 */
function escapedLetterBefore(haystack: Buffer, at: number): boolean {
  let slashes = 0;
  for (let i = at - 2; i >= 0 && haystack[i] === 0x5c; i--) slashes++;
  return slashes % 2 === 1;
}

/** Whether `needle` occurs in `haystack` with no path byte on either side;
 * a rejected occurrence does not end the search. */
function containsBounded(haystack: Buffer, needle: Buffer): boolean {
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = at > 0 ? String.fromCharCode(haystack[at - 1]) : '';
    // Dots that end a sentence, "saved to /tmp/shot.png.", end the path
    // too — unless the path goes on after them, as in `/tmp/shot.png.bak`.
    let end = at + needle.length;
    while (end < haystack.length && haystack[end] === 0x2e) end++;
    const after = end < haystack.length ? String.fromCharCode(haystack[end]) : '';
    const beforeOk =
      !LEADING_PATH_CHAR.test(before) ||
      (JSON_ESCAPE_LETTER.test(before) && escapedLetterBefore(haystack, at));
    if (beforeOk && !PATH_CHAR.test(after)) return true;
  }
  return false;
}

/**
 * Whether a session's transcripts name `rawPath` — the second way into the
 * file viewer (spec 2026-10-03-api-token-and-named-files-design § 2). Only an
 * absolute path qualifies; a relative one is the cwd's business alone.
 *
 * A byte search, no parsing: each spelling is looked for as written and in
 * its JSON string forms, since JSONL writers escape `"`, `\` and non-ASCII. A
 * `~/` path and its expansion name the same file and the transcript may hold
 * either, so both are searched whichever one the client sent. A transcript
 * that cannot be read names nothing.
 */
export function namedInTranscript(
  transcriptPaths: string[],
  rawPath: string,
  home: string = homedir(),
): boolean {
  const written = rawPath.trim();
  const expanded = expandHome(written, home);
  if (!isAbsolute(expanded)) return false;

  const spellings = new Set([written, expanded]);
  if (expanded.startsWith(home + sep)) spellings.add('~' + expanded.slice(home.length));
  const needles: Buffer[] = [];
  for (const spelling of spellings) {
    needles.push(Buffer.from(spelling));
    const json = JSON.stringify(spelling).slice(1, -1);
    if (json !== spelling) needles.push(Buffer.from(json));
    // `JSON.stringify` keeps non-ASCII as is; ASCII-only writers do not.
    const ascii = json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (ascii !== json) needles.push(Buffer.from(ascii));
  }

  for (const path of transcriptPaths) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    if (needles.some((needle) => containsBounded(bytes, needle))) return true;
  }
  return false;
}

/** A session's transcript files: the main JSONL, then every subagent's. */
export function sessionTranscriptFiles(transcriptPath: string): string[] {
  const dir = subagentDirOf(transcriptPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const agents = names.filter((name) => name.endsWith('.jsonl')).sort();
  return [transcriptPath, ...agents.map((name) => join(dir, name))];
}

/** Whether the session at hand named a path; see `namedInTranscript`. */
export type NamedCheck = (rawPath: string) => boolean;

/** Names nothing — the cwd alone confines. */
const NAMES_NOTHING: NamedCheck = () => false;

/**
 * `namedInTranscript` per (session, path), held under the stamp of the
 * session's transcript files the way `spineFor` holds its spines.
 *
 * A yes is kept whatever the stamp does: the CLI only appends to a
 * transcript, so a path once named stays named. A no is asked again once the
 * stamp moves. Bounded by count, the least recently asked out first.
 */
export class NamedPathCache {
  private entries = new Map<string, { stamp: string; named: boolean }>();

  constructor(private readonly max: number) {}

  /** The check for one session, whose main transcript is `transcriptPath`. */
  forSession(sessionId: string, transcriptPath: string): NamedCheck {
    return (rawPath) => {
      const key = `${sessionId}\0${rawPath}`;
      const hit = this.entries.get(key);
      // Re-inserted either way, so the Map's order stays most-recent-last.
      if (hit) this.entries.delete(key);
      let entry: { stamp: string; named: boolean };
      if (hit?.named) {
        entry = hit;
      } else {
        // The subagents' files are part of the stamp: an agent can name a
        // path while the parent file sits still.
        const stamp = `${fileStamp(transcriptPath) ?? '-'}#${dirStamp(subagentDirOf(transcriptPath))}`;
        entry = hit?.stamp === stamp
          ? hit
          : { stamp, named: namedInTranscript(sessionTranscriptFiles(transcriptPath), rawPath) };
      }
      this.entries.set(key, entry);
      while (this.entries.size > this.max) {
        this.entries.delete(this.entries.keys().next().value as string);
      }
      return entry.named;
    };
  }
}

/**
 * Confines a path to what a session may show: inside its cwd
 * (`resolveInsideCwd`, asked first and unchanged), or an absolute path its
 * transcripts name.
 *
 * The spelling decides the check and the realpath decides the read: the
 * agent writes `/tmp/shot.png`, the transcript and the client spell it so,
 * and on macOS the bytes come from `/private/tmp/shot.png`. A named symlink
 * is therefore followed wherever it leads — the agent that named it could
 * read the target itself.
 */
export function resolveForSession(cwd: string, rawPath: string, named: NamedCheck): ConfinedPath {
  const confined = resolveInsideCwd(cwd, rawPath);
  if (confined.kind !== 'outside') return confined;

  const expanded = expandHome(rawPath);
  if (!isAbsolute(expanded) || !named(rawPath)) return confined;
  try {
    return { kind: 'ok', path: realpathSync(expanded) };
  } catch {
    return { kind: 'not_found' };
  }
}

/**
 * The directories a file request is confined to, tried in order (adr
 * `a-file-link-resolves-against-the-cwd-it-was-written-in`). A `cwd` the
 * client sent counts only when the session's transcripts recorded it, and
 * then it is the only one: the link was written there, and a file of the
 * same name in another tree is the wrong version. Without one, or with one
 * the transcripts never named, the tree the session works in now, then its
 * home. `recorded` is asked only when there is a `cwd` to check.
 */
export function fileSandboxes(
  home: string, workingDir: string, requested: string | undefined, recorded: () => ReadonlySet<string>,
): string[] {
  if (requested && recorded().has(requested)) return [requested];
  return workingDir === home ? [home] : [workingDir, home];
}

/**
 * Reads in each sandbox in turn: the first that has the file answers,
 * refusal or not. When none has it, the last one's answer stands — the
 * home's, so `outside` and `not_found` keep meaning what they meant before
 * there was more than one.
 */
export function readInSandboxes<R extends { kind: string }>(sandboxes: string[], read: (cwd: string) => R): R {
  let result: R | undefined;
  for (const cwd of sandboxes) {
    result = read(cwd);
    if (result.kind !== 'not_found' && result.kind !== 'outside') return result;
  }
  return result ?? read('');
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
 * sandbox, widened by `named` to the files its transcript names, and
 * `resolveForSession` is what holds the path to it.
 */
export function readFilePreview(cwd: string, rawPath: string, named: NamedCheck = NAMES_NOTHING): PreviewResult {
  const read = readTextFile(cwd, rawPath, named, FILE_PREVIEW_MAX_BYTES);
  if (read.kind !== 'ok') return read;

  const content = read.bytes.toString('utf8');
  let lines = 1;
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lines++;
  return { kind: 'ok', content, size: read.size, mtimeMs: read.mtimeMs, lines };
}

export type TextFileResult =
  | { kind: 'ok'; bytes: Buffer; size: number; mtimeMs: number }
  | { kind: 'not_found' }
  | { kind: 'outside' }
  | { kind: 'too_large'; size: number }
  | { kind: 'binary'; size: number; mediaType: string };

/**
 * A text file's bytes, undecoded, refusals first: confined by
 * `resolveForSession`, refused past `maxBytes` from the stat alone, refused
 * as binary by the sniff. The viewer's read decodes them; the phone's
 * `file_get` sends them as they are, under its own smaller cap.
 */
export function readTextFile(
  cwd: string, rawPath: string, named: NamedCheck = NAMES_NOTHING, maxBytes: number = FILE_PREVIEW_MAX_BYTES,
): TextFileResult {
  const confined = resolveForSession(cwd, rawPath, named);
  if (confined.kind !== 'ok') return confined;
  const resolved = confined.path;

  const stat = statSync(resolved);
  if (stat.isDirectory()) return { kind: 'not_found' };
  if (stat.size > maxBytes) return { kind: 'too_large', size: stat.size };

  const bytes = readFileSync(resolved);
  // The file may have grown between the stat and the read.
  if (bytes.length > maxBytes) return { kind: 'too_large', size: bytes.length };
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(resolved)?.[1]?.toLowerCase();
    return {
      kind: 'binary',
      size: stat.size,
      mediaType: (ext && BINARY_MEDIA_TYPES[ext]) || 'binary',
    };
  }
  return { kind: 'ok', bytes, size: bytes.length, mtimeMs: stat.mtimeMs };
}

/** Content type per extension for `readImageFile` — the formats an `<img>`
 * shows, matched by the web's `IMAGE_EXTENSIONS` in `pathLinks.ts`. */
export const IMAGE_FILE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

export type ImageFileResult =
  | { kind: 'ok'; bytes: Buffer; contentType: string }
  | { kind: 'not_found' }
  | { kind: 'outside' }
  | { kind: 'too_large'; size: number }
  | { kind: 'not_image' };

/**
 * Reads an image a prose path names, for the lightbox. Confined exactly like
 * `readFilePreview`, under the same size cap; the extension decides the type
 * because it is all an `<img>` needs and nothing here interprets the bytes.
 */
export function readImageFile(cwd: string, rawPath: string, named: NamedCheck = NAMES_NOTHING): ImageFileResult {
  const confined = resolveForSession(cwd, rawPath, named);
  if (confined.kind !== 'ok') return confined;
  const resolved = confined.path;

  const ext = /\.([A-Za-z0-9]+)$/.exec(resolved)?.[1]?.toLowerCase();
  const contentType = ext ? IMAGE_FILE_CONTENT_TYPES[ext] : undefined;
  if (!contentType) return { kind: 'not_image' };

  const stat = statSync(resolved);
  if (stat.isDirectory()) return { kind: 'not_found' };
  if (stat.size > FILE_PREVIEW_MAX_BYTES) return { kind: 'too_large', size: stat.size };

  return { kind: 'ok', bytes: readFileSync(resolved), contentType };
}
