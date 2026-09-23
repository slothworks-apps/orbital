import { isAbsolute, resolve, sep } from 'node:path';

/**
 * The editor bridge's wire facts, as pure functions over text (spec
 * 2026-09-23-ide-bridge-design). Everything here is measured against the
 * Claude Code JetBrains plugin and nothing here is a published interface —
 * a plugin release can change any of it, which is why every parse answers
 * `null` rather than throwing (adr `orbital-speaks-to-the-ide-itself`).
 */

/** The subdirectory of `~/.claude` the extension writes its locks into. */
export const IDE_LOCK_DIR = 'ide';

/** Only `<port>.lock` is a lock; the extension writes nothing else here. */
const LOCK_FILE = /^(\d+)\.lock$/;

/** The highest number a TCP port can be — anything above it is not a lock. */
const MAX_PORT = 65535;

/**
 * The WebSocket subprotocol the extension requires. Without it the upgrade
 * fails with HTTP 400 before the token is even looked at.
 */
export const IDE_SUBPROTOCOL = 'mcp';

/** Where the lock's `authToken` travels. */
export const IDE_AUTH_HEADER = 'X-Claude-Code-Ide-Authorization';

/** The MCP revision the extension was measured speaking. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** The notification the extension pushes as the caret or selection moves. */
export const SELECTION_NOTIFICATION = 'selection_changed';

/** Absolute paths of the editor's open tabs, newline separated, no arguments. */
export const OPEN_FILES_TOOL = 'get_all_opened_file_paths';

/**
 * Shown when a lock omits `ideName`. The name is decoration — the slot's
 * label — so a lock missing it is still worth connecting to.
 */
const UNNAMED_IDE = 'IDE';

/** One `~/.claude/ide/<port>.lock`, as far as Orbital cares. */
export interface IdeLock {
  /** From the file name. The JSON has no port field at all. */
  port: number;
  /** Absolute roots this editor window has open; one lock can list several. */
  workspaceFolders: string[];
  /** As the lock reports it — the product (`WebStorm`), not the vendor. */
  ideName: string;
  authToken: string;
  /** The editor process, when the lock says; nothing reads it yet. */
  pid: number | null;
}

/**
 * A selection as the rest of Orbital uses it: 1-based lines, so it matches
 * the gutter the person is looking at, and a null `text` for a caret that
 * merely moved.
 */
export interface IdeSelection {
  filePath: string;
  /** 1-based, so it matches what the editor's gutter shows. */
  lineStart: number;
  lineCount: number;
  /** null when the caret moved and nothing is selected. */
  text: string | null;
}

/**
 * The editor open on a session's workspace right now — live state of a
 * directory rather than a fact about the session, exactly as `GitLocation`
 * is (adr `orbital-speaks-to-the-ide-itself`).
 */
export interface IdeContext {
  ideName: string;
  workspaceRoot: string;
  selection: IdeSelection | null;
}

/** The port a lock file's name carries, or null when it is not a lock. */
export function lockPortOf(fileName: string): number | null {
  const match = LOCK_FILE.exec(fileName);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port > 0 && port <= MAX_PORT ? port : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Trailing separators off, so two spellings of one root compare equal. */
function normaliseRoot(path: string): string {
  const resolved = resolve(path);
  return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
}

/**
 * One lock file, from its name and its contents. Null for anything Orbital
 * cannot act on, which is ignored rather than retried: no port in the name,
 * unparseable JSON, no workspace to match a `cwd` against, no token to
 * authenticate with, or a transport that is not a WebSocket.
 *
 * A `transport` field that is present and says something other than `ws` is
 * refused rather than tried, because the only client here speaks WebSocket;
 * a lock that omits the field is taken at the word of everything else in it.
 */
export function parseIdeLock(fileName: string, content: string): IdeLock | null {
  const port = lockPortOf(fileName);
  if (port === null) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  if (typeof raw.transport === 'string' && raw.transport !== 'ws') return null;

  const authToken = raw.authToken;
  if (typeof authToken !== 'string' || authToken === '') return null;

  const folders = Array.isArray(raw.workspaceFolders) ? raw.workspaceFolders : [];
  const workspaceFolders = [
    ...new Set(
      folders
        .filter((f): f is string => typeof f === 'string' && f !== '' && isAbsolute(f))
        .map(normaliseRoot),
    ),
  ];
  if (workspaceFolders.length === 0) return null;

  return {
    port,
    workspaceFolders,
    ideName: typeof raw.ideName === 'string' && raw.ideName !== '' ? raw.ideName : UNNAMED_IDE,
    authToken,
    pid: typeof raw.pid === 'number' && Number.isFinite(raw.pid) ? raw.pid : null,
  };
}

function lineOf(point: unknown): number | null {
  if (!isRecord(point)) return null;
  const line = point.line;
  return typeof line === 'number' && Number.isFinite(line) && line >= 0 ? Math.floor(line) : null;
}

function characterOf(point: unknown): number {
  if (!isRecord(point)) return 0;
  const character = point.character;
  return typeof character === 'number' && Number.isFinite(character) ? character : 0;
}

/**
 * The `selection_changed` payload as `IdeSelection`, or null when it says
 * nothing usable — no absolute path, or no range to read lines out of.
 *
 * Two corrections turn the raw range into what the gutter shows:
 *
 * - lines and characters arrive zero-based, so `lineStart` is `start.line + 1`;
 * - a range ending at column zero stops *before* that line, so the count loses
 *   one — without it every selection dragged to the start of the next line
 *   reads one line too long. The correction applies only to a range that
 *   actually spans lines: a caret sitting in column zero is `start === end`
 *   and still sits on one line, and the unguarded form would report zero for
 *   it.
 *
 * An empty `text` is the same fact as an absent one — the caret moved — and
 * both become null, so the slot never raises a lip over nothing.
 */
export function normaliseSelection(params: unknown): IdeSelection | null {
  if (!isRecord(params)) return null;
  const filePath = params.filePath;
  if (typeof filePath !== 'string' || filePath === '' || !isAbsolute(filePath)) return null;

  const selection = isRecord(params.selection) ? params.selection : null;
  const startLine = lineOf(selection?.start);
  if (startLine === null) return null;
  const endLine = lineOf(selection?.end) ?? startLine;
  const endCharacter = characterOf(selection?.end);

  const spansLines = endLine > startLine;
  const raw = endLine - startLine + 1 - (spansLines && endCharacter === 0 ? 1 : 0);

  const text = params.text;
  return {
    filePath,
    lineStart: startLine + 1,
    lineCount: Math.max(1, raw),
    text: typeof text === 'string' && text !== '' ? text : null,
  };
}

/** Whether two readings say the same thing — the flood's duplicate filter. */
export function sameSelection(a: IdeSelection | null, b: IdeSelection | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.filePath === b.filePath &&
    a.lineStart === b.lineStart &&
    a.lineCount === b.lineCount &&
    a.text === b.text
  );
}

/**
 * Which workspace root covers this `cwd` — the longest one, so a project
 * opened inside another project wins over the one containing it. The
 * separator matters: without it `/w/x-evil` would sit inside `/w/x`.
 */
export function workspaceRootFor(cwd: string, roots: Iterable<string>): string | null {
  if (!cwd) return null;
  const target = normaliseRoot(cwd);
  let best: string | null = null;
  for (const root of roots) {
    if (target !== root && !target.startsWith(root + sep)) continue;
    if (best === null || root.length > best.length) best = root;
  }
  return best;
}

/** Whether a path the editor named lies inside a session's sandbox. */
export function insideCwd(cwd: string, path: string): boolean {
  if (!cwd || !isAbsolute(path)) return false;
  const root = normaliseRoot(cwd);
  const target = normaliseRoot(path);
  return target === root || target.startsWith(root + sep);
}
