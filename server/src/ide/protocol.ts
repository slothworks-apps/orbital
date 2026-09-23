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

// ---------------------------------------------------------------------------
// Talking back to the editor
// ---------------------------------------------------------------------------

/*
 * The tools Orbital calls rather than listens to (spec
 * 2026-09-23-ide-bridge-design § Talking back to the editor). Every one of
 * them is checked against `tools/list` before it is called: these are the
 * JetBrains names, and a VS Code build offers a different set
 * (adr `orbital-speaks-to-the-ide-itself`).
 */

/** Reveals a path in the editor. Takes `filePath`, plus an optional range. */
export const OPEN_FILE_TOOL = 'openFile';

/** The editor's own inspections — for one file, or for the whole workspace. */
export const DIAGNOSTICS_TOOL = 'getDiagnostics';

/** Opens a review tab and does not answer until the human acts on it. */
export const OPEN_DIFF_TOOL = 'openDiff';

/** Drops a tab `openDiff` opened, by the `tab_name` it was opened under. */
export const CLOSE_TAB_TOOL = 'close_tab';

/** How severe the editor thinks one of its findings is. */
export type IdeDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/** One finding, flattened out of the editor's per-file grouping. */
export interface IdeDiagnostic {
  filePath: string;
  /** 1-based, so it matches the gutter — the same correction a selection gets. */
  line: number;
  severity: IdeDiagnosticSeverity;
  message: string;
  /** The inspection that raised it, when the editor names one. */
  source: string | null;
}

/**
 * The LSP severity numbers, which the editor may send instead of the words.
 * An unrecognised value becomes `info` rather than a dropped finding — one
 * Orbital cannot rank is still one worth showing.
 */
const SEVERITY_BY_NUMBER: Record<number, IdeDiagnosticSeverity> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

function severityOf(raw: unknown): IdeDiagnosticSeverity {
  if (typeof raw === 'number') return SEVERITY_BY_NUMBER[raw] ?? 'info';
  if (typeof raw !== 'string') return 'info';
  const word = raw.toLowerCase();
  if (word.startsWith('err')) return 'error';
  if (word.startsWith('warn')) return 'warning';
  if (word.startsWith('hint')) return 'hint';
  return 'info';
}

/**
 * An absolute path out of a `file://` URI, or the string itself when it is
 * already one. The extension was measured answering with URIs; taking a bare
 * path as well costs nothing and is what a different build may send.
 */
export function pathFromFileUri(raw: string): string | null {
  if (raw === '') return null;
  if (!raw.startsWith('file://')) return isAbsolute(raw) ? raw : null;
  try {
    const path = decodeURIComponent(new URL(raw).pathname);
    // `file://` on its own parses to a pathname of `/`, which is absolute and
    // names nothing. Everything here is a file, so the root is not one.
    return isAbsolute(path) && path !== '/' ? path : null;
  } catch {
    return null;
  }
}

/**
 * `getDiagnostics`' answer as a flat list. The tool answers with one text
 * block holding JSON: an array of `{uri, diagnostics}` groups, each finding
 * carrying an LSP-shaped `range`.
 *
 * Total and forgiving, like every other parse here — unreadable JSON, a
 * group without a path, a finding without a message all drop out silently
 * rather than throwing. The alternative is a panel that fails because a
 * plugin release renamed a field.
 */
export function parseDiagnostics(text: string): IdeDiagnostic[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const groups = Array.isArray(raw) ? raw : [raw];
  const out: IdeDiagnostic[] = [];
  for (const group of groups) {
    if (!isRecord(group)) continue;
    const uri = group.uri ?? group.filePath ?? group.file;
    const filePath = typeof uri === 'string' ? pathFromFileUri(uri) : null;
    if (filePath === null) continue;
    const findings = Array.isArray(group.diagnostics) ? group.diagnostics : [];
    for (const finding of findings) {
      if (!isRecord(finding)) continue;
      const message = finding.message;
      if (typeof message !== 'string' || message === '') continue;
      const range = isRecord(finding.range) ? finding.range : null;
      // Zero-based on the wire, like a selection's. A finding whose range is
      // missing is still worth showing, so it lands on the first line rather
      // than nowhere at all.
      const line = lineOf(range?.start);
      const source = finding.source;
      out.push({
        filePath,
        line: (line ?? 0) + 1,
        severity: severityOf(finding.severity),
        message,
        source: typeof source === 'string' && source !== '' ? source : null,
      });
    }
  }
  return out;
}

/**
 * What the human did to a diff tab. `openDiff` does not answer until one of
 * these happens, which is why it is the only call here without a timeout.
 *
 * `closed` is deliberately NOT a verdict: closing the tab says "not here",
 * neither yes nor no, so the decision stays parked and the browser card goes
 * on owning it (adr `the-editor-is-a-second-route-to-one-verdict`).
 */
export type IdeDiffOutcome =
  | { kind: 'saved'; contents: string | null }
  | { kind: 'rejected' }
  | { kind: 'closed' };

/** The measured first-element markers of `openDiff`'s answer. */
const DIFF_SAVED = 'FILE_SAVED';
const DIFF_REJECTED = 'DIFF_REJECTED';
const DIFF_TAB_CLOSED = 'TAB_CLOSED';

/** The text of one MCP content block, or null when it carries none. */
function blockText(block: unknown): string | null {
  if (!isRecord(block)) return null;
  const text = block.text;
  return typeof text === 'string' ? text : null;
}

/**
 * `openDiff`'s content array as an outcome, or null when it says nothing
 * this build understands — which counts as no verdict rather than being
 * guessed at, because guessing wrong here approves an edit nobody approved.
 *
 * Element one is the marker; on `FILE_SAVED`, element two carries the file
 * as the human left it, which need not be what Orbital proposed.
 */
export function readDiffOutcome(content: unknown): IdeDiffOutcome | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  const marker = blockText(content[0])?.trim();
  if (marker === DIFF_REJECTED) return { kind: 'rejected' };
  if (marker === DIFF_TAB_CLOSED) return { kind: 'closed' };
  if (marker === DIFF_SAVED) return { kind: 'saved', contents: blockText(content[1]) };
  return null;
}
