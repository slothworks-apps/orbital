import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readTextFile } from '../files/preview.js';
import { watchDir, type DirWatch } from '../watcher/watchDir.js';
import { IdeSocket, NO_TIMEOUT, type IdeConnection } from './client.js';
import {
  CLOSE_TAB_TOOL,
  DIAGNOSTICS_TOOL,
  IDE_LOCK_DIR,
  OPEN_DIFF_TOOL,
  OPEN_EDITORS_TOOL,
  OPEN_FILES_TOOL,
  OPEN_FILE_TOOL,
  insideCwd,
  lockPortOf,
  normaliseSelection,
  parseDiagnostics,
  parseIdeLock,
  parseOpenEditors,
  readDiffOutcome,
  revealTextFor,
  sameSelection,
  workspaceRootFor,
  type IdeContext,
  type IdeDiagnostic,
  type IdeDiffOutcome,
  type IdeLock,
  type IdeSelection,
} from './protocol.js';

/**
 * How long a burst of `selection_changed` is allowed to settle before the
 * store publishes what it ended on.
 *
 * One ordinary five-line drag produced 92 notifications inside a second,
 * several byte-identical. Nothing about a selection is worth delivering
 * promptly enough to justify flooding the browser socket, so the trailing
 * edge is the only edge that gets sent (spec
 * 2026-09-23-ide-bridge-design § Debouncing). The two rates the canvas asks
 * for are applied in the browser, on this one publish stream.
 */
export const IDE_SELECTION_COALESCE_MS = 120;

/**
 * How soon a connection that went away is tried again while its lock is still
 * on disk, and how far that wait doubles when the new one goes too.
 *
 * The VS Code extension serves one client at a time: a second one connecting
 * — a `claude` started in its terminal, another Orbital server — closes the
 * one before it. The lock is untouched by that, so no watch event ever says
 * the editor is worth connecting to again; without a retry, Orbital stays
 * without the editor until it restarts. The doubling is for two clients that
 * both retry: each takes the editor from the other, and the waits stretch out
 * instead of the two trading it several times a second.
 */
export const IDE_RECONNECT_MIN_MS = 1_000;
export const IDE_RECONNECT_MAX_MS = 60_000;

/** A connection that lived this long went away for a new reason: its retry starts from the shortest wait again. */
export const IDE_RECONNECT_STABLE_MS = 60_000;

/** One editor window: its lock, its socket, and what it last said. */
interface Entry {
  lock: IdeLock;
  connection: IdeConnection;
  /** The handshake finished and the tool list arrived. Until then `locate`
   * does not see this entry at all, which is how a stale lock on a refusing
   * port stays invisible rather than becoming a broken editor. */
  ready: boolean;
  selection: IdeSelection | null;
  /** The latest notification of a burst, waiting for `coalesceMs`. */
  queued: IdeSelection | null;
  timer: NodeJS.Timeout | null;
  /**
   * When this editor last connected or published a selection, as a count of
   * the store's uses — which of two editors on one project takes it over when
   * the one holding it goes.
   */
  activeAt: number;
  /** When the handshake finished, for telling a lasting connection from a refused one. */
  readyAt: number | null;
}

/** A port whose connection went away while its lock stayed: when it is tried again. */
interface Reconnect {
  lockDir: string;
  timer: NodeJS.Timeout | null;
  delayMs: number;
}

export interface IdeStoreOptions {
  /**
   * A Claude directory to read from the start; the locks live one level in.
   * The server adds each configured directory with `addClaudeDir` instead.
   */
  claudeDir?: string;
  watch?: boolean;
  /** Injected by tests, so the store can be driven without an editor. */
  connect?: (lock: IdeLock) => IdeConnection;
  coalesceMs?: number;
}

/**
 * The editors open on this machine, as live state of the directories they
 * have open (spec 2026-09-23-ide-bridge-design § Where it lives).
 *
 * Shaped after `GitStore`, and for the same reason: what is being tracked
 * belongs to a directory, several sessions share one, and a change has to be
 * turned back into the sessions it touches. `locate(cwd)` answers by longest
 * workspace root; `change` carries that root and the `cwd`s under it, which
 * `index.ts` republishes exactly as it does for a `HEAD` that moved.
 *
 * Nothing here can fail a session. No lock, an unparseable lock, a port that
 * refuses, an editor that quits — each leaves `locate` answering null, which
 * is the behaviour Orbital has when no editor is running at all.
 */
export class IdeStore extends EventEmitter {
  /**
   * Every Claude directory's `ide/`, and its watch once started. The editors
   * are the machine's, not a directory's: an extension writes its lock into
   * whichever directory its CLI uses, so every configured one is read into
   * the one store (spec 2026-10-04-multiple-claude-directories-design § 2).
   */
  private lockDirs = new Map<string, DirWatch | null>();
  /** Which lock directory each port's lock was read from. */
  private lockDirByPort = new Map<number, string>();
  private started = false;
  private watch: boolean;
  private coalesceMs: number;
  private connect: (lock: IdeLock) => IdeConnection;

  private byPort = new Map<number, Entry>();
  private reconnects = new Map<number, Reconnect>();
  /** Counts uses, so `activeAt` orders editors whatever the wall clock does. */
  private uses = 0;
  /**
   * Workspace root → the connected entry covering it. Ready entries only. Two
   * editors open on one project share a root, and it belongs to whichever
   * was used last.
   */
  private entryByRoot = new Map<string, Entry>();
  /** `cwd` → workspace root, or null for "asked, nothing covers it". */
  private rootByCwd = new Map<string, string | null>();
  /** The reverse index, so a change can name the sessions it touches. */
  private cwdsByRoot = new Map<string, Set<string>>();
  /** Every `cwd` ever asked about — re-resolved when the editors change. */
  private seenCwds = new Set<string>();

  constructor(opts: IdeStoreOptions) {
    super();
    if (opts.claudeDir !== undefined) this.lockDirs.set(join(opts.claudeDir, IDE_LOCK_DIR), null);
    this.watch = opts.watch ?? true;
    this.coalesceMs = opts.coalesceMs ?? IDE_SELECTION_COALESCE_MS;
    this.connect = opts.connect ?? ((lock) => new IdeSocket(lock));
  }

  /**
   * Reads the locks already on disk and starts watching for more. Separate
   * from the constructor because it touches the filesystem and opens sockets,
   * and because a store that is never started is the right thing for a test
   * that only wants `locate`.
   */
  start(): void {
    this.started = true;
    for (const lockDir of this.lockDirs.keys()) this.startDir(lockDir);
  }

  /** Reads one more Claude directory's locks — at once when the store is started. */
  addClaudeDir(claudeDir: string): void {
    const lockDir = join(claudeDir, IDE_LOCK_DIR);
    if (this.lockDirs.has(lockDir)) return;
    this.lockDirs.set(lockDir, null);
    if (this.started) this.startDir(lockDir);
  }

  /** Stops reading a Claude directory's locks, and drops the editors they named. */
  removeClaudeDir(claudeDir: string): void {
    const lockDir = join(claudeDir, IDE_LOCK_DIR);
    if (!this.lockDirs.has(lockDir)) return;
    this.lockDirs.get(lockDir)?.close();
    this.lockDirs.delete(lockDir);
    for (const [port, dir] of [...this.lockDirByPort]) if (dir === lockDir) this.dropLock(port);
    for (const [port, reconnect] of [...this.reconnects]) if (reconnect.lockDir === lockDir) this.cancelReconnect(port);
  }

  private startDir(lockDir: string): void {
    for (const name of this.listLocks(lockDir)) this.applyLockEvent(name, 'add', lockDir);
    if (!this.watch || this.lockDirs.get(lockDir)) return;
    // Not recursive because the extension writes flat into this directory, and
    // a missing directory is not an error: the watch picks it up if it ever
    // appears, and a machine with no editor never creates it. An event does
    // not say what happened to the file, so its existence decides; `add` and
    // `change` are handled alike.
    this.lockDirs.set(lockDir, watchDir(lockDir, {
      onEvent: (name) => {
        if (name === null) return;
        const fileName = basename(name);
        this.applyLockEvent(fileName, existsSync(join(lockDir, fileName)) ? 'change' : 'unlink', lockDir);
      },
      onAppear: () => {
        for (const name of this.listLocks(lockDir)) this.applyLockEvent(name, 'add', lockDir);
      },
    }));
  }

  /** The editor open on this `cwd`'s workspace, or null when there is none. */
  locate(cwd: string): IdeContext | null {
    if (!this.seenCwds.has(cwd)) {
      this.seenCwds.add(cwd);
      this.setRoot(cwd, workspaceRootFor(cwd, this.entryByRoot.keys()));
    }
    const root = this.rootByCwd.get(cwd) ?? null;
    if (root === null) return null;
    const entry = this.entryByRoot.get(root);
    if (!entry) return null;
    return { ideName: entry.lock.ideName, workspaceRoot: root, selection: entry.selection };
  }

  /** The `cwd`s that resolved to this workspace — its sessions' addresses. */
  cwdsFor(root: string): string[] {
    return [...(this.cwdsByRoot.get(root) ?? [])];
  }

  /**
   * The editor's open tabs that lie inside this session's `cwd`, or null when
   * no editor covers it and when the connected one does not offer the tool.
   *
   * The order is the editor's own — the order the tabs sit in, which is what
   * the person is looking at. It is not recency; the extension does not
   * report any (spec § Open files, measured 2026-09-23). Paths outside the
   * `cwd` are dropped, because the sandbox rule wins over the editor's idea
   * of what is interesting.
   */
  async openFiles(cwd: string): Promise<string[] | null> {
    const entry = this.entryFor(cwd);
    if (!entry) return null;
    let paths: string[];
    if (entry.connection.hasTool(OPEN_FILES_TOOL)) {
      const text = await entry.connection.callTool(OPEN_FILES_TOOL);
      if (text === null) return null;
      paths = text.split('\n').map((line) => line.trim());
    } else {
      // VS Code: the same question under another name, answered as JSON.
      const text = await entry.connection.callTool(OPEN_EDITORS_TOOL);
      if (text === null) return null;
      paths = parseOpenEditors(text);
    }
    return paths.filter((path) => path !== '' && insideCwd(cwd, path));
  }

  // -------------------------------------------------------------------------
  // Talking back to the editor
  // -------------------------------------------------------------------------

  /**
   * Whether the editor covering this `cwd` offers a tool. Asked rather than
   * assumed everywhere, so a build that does not have one simply does not
   * show the feature that needs it (adr `orbital-speaks-to-the-ide-itself`).
   */
  supports(cwd: string, tool: string): boolean {
    return this.entryFor(cwd)?.connection.hasTool(tool) ?? false;
  }

  /**
   * Reveals a path in the editor, optionally on a line. `false` for every
   * kind of "no": no editor, no such tool, a path outside the session's
   * sandbox, a call that errored or timed out.
   *
   * The sandbox check is the same one the open-files list is filtered by. A
   * path Orbital would refuse to *read* for a session is not one it should
   * ask an editor to open on that session's behalf.
   */
  async openFile(cwd: string, path: string, line: number | null = null): Promise<boolean> {
    const entry = this.entryFor(cwd);
    if (!entry || !insideCwd(cwd, path)) return false;
    // Neither build takes a line: the line travels as the text that starts
    // it, which VS Code looks for. The JetBrains plugin (0.1.14-beta) reads
    // `startText` and ignores it, so there the file opens where it was.
    // VS Code refuses a call without both texts; empty ones select nothing.
    const args = { filePath: path, ...(line === null ? NO_LINE : lineTexts(cwd, path, line)) };
    return (await entry.connection.callTool(OPEN_FILE_TOOL, args)) !== null;
  }

  /**
   * The editor's own findings, for one file or for everything it has open,
   * or null when no editor covers the `cwd` or the connected one does not
   * offer the tool.
   *
   * Filtered to the session's `cwd`, for the same reason the open-files list
   * is: a finding in someone else's project is not this session's business.
   */
  async diagnostics(cwd: string, path?: string): Promise<IdeDiagnostic[] | null> {
    const entry = this.entryFor(cwd);
    if (!entry) return null;
    if (path !== undefined && !insideCwd(cwd, path)) return null;
    const text = await entry.connection.callTool(
      DIAGNOSTICS_TOOL,
      path === undefined ? {} : { uri: `file://${path}` },
    );
    if (text === null) return null;
    return parseDiagnostics(text).filter((d) => insideCwd(cwd, d.filePath));
  }

  /**
   * Opens a review tab and waits for the human — the one call here with no
   * deadline, because the thing it waits for is a person reading a diff.
   *
   * `signal` is how the wait is abandoned when the verdict arrives from
   * somewhere else; aborting also drops the tab, so the editor is never left
   * holding a review of a decision that is already settled.
   *
   * Null for every kind of no-answer, which the caller must treat as "no
   * verdict" rather than as a refusal.
   */
  async openDiff(
    cwd: string,
    args: { oldPath: string; newPath: string; contents: string; tabName: string },
    signal: AbortSignal,
  ): Promise<IdeDiffOutcome | null> {
    const entry = this.entryFor(cwd);
    if (!entry || !insideCwd(cwd, args.oldPath)) return null;
    try {
      const content = await entry.connection.callToolContent(
        OPEN_DIFF_TOOL,
        {
          old_file_path: args.oldPath,
          new_file_path: args.newPath,
          new_file_contents: args.contents,
          tab_name: args.tabName,
        },
        { timeoutMs: NO_TIMEOUT, signal },
      );
      return content === null ? null : readDiffOutcome(content);
    } finally {
      // Whatever happened — a verdict, an abort, a socket that went away —
      // the tab is this call's to clean up. `close_tab` on a tab the editor
      // has already dropped is a no-op there, which is what makes calling it
      // unconditionally the simple thing to do. Asked of the editor that
      // opened the tab, which need not be the one holding the project now.
      void closeTabIn(entry, args.tabName);
    }
  }

  /** The connected editor covering this `cwd`, or undefined. */
  private entryFor(cwd: string): Entry | undefined {
    const root = this.locate(cwd)?.workspaceRoot;
    return root ? this.entryByRoot.get(root) : undefined;
  }

  /**
   * What one lock file's appearance, rewrite or removal does to the store,
   * separated from the watch that normally raises it so it can be driven
   * directly — the way `GitStore.applyHeadEvent` is.
   */
  applyLockEvent(
    fileName: string,
    event: 'add' | 'change' | 'unlink',
    lockDir: string | undefined = this.lockDirs.keys().next().value,
  ): void {
    if (lockDir === undefined) return;
    const lock = event === 'unlink' ? null : this.readLock(lockDir, fileName);
    if (event === 'unlink') {
      const port = lockPortOf(fileName);
      // Only the directory the lock came from can take it away: another
      // directory's copy of the same port's file is not this one's editor.
      if (port === null) return;
      if ((this.lockDirByPort.get(port) ?? lockDir) === lockDir) this.dropLock(port);
      if (this.reconnects.get(port)?.lockDir === lockDir) this.cancelReconnect(port);
      return;
    }
    // Unparseable, or not a lock at all: ignored, and not retried.
    if (!lock) return;

    const existing = this.byPort.get(lock.port);
    if (existing && sameLock(existing.lock, lock)) return;
    // The lock says to connect now, so a retry still waiting is beside the
    // point; its wait is kept, in case this connection goes the same way.
    this.stopReconnectTimer(lock.port);
    // A rewritten lock is a new editor session on that port — a token it
    // reissued, or a project it swapped. The old socket is worth nothing.
    if (existing) this.dropLock(lock.port);
    this.addLock(lock);
    this.lockDirByPort.set(lock.port, lockDir);
  }

  close(): void {
    for (const watch of this.lockDirs.values()) watch?.close();
    for (const lockDir of this.lockDirs.keys()) this.lockDirs.set(lockDir, null);
    this.started = false;
    for (const port of [...this.reconnects.keys()]) this.cancelReconnect(port);
    // Emptied before the sockets go, so the drops have no resolution left to
    // invalidate: a server shutting down does not want a republish per
    // workspace on its way out.
    this.rootByCwd.clear();
    this.cwdsByRoot.clear();
    this.seenCwds.clear();
    for (const port of [...this.byPort.keys()]) this.dropLock(port);
  }

  private listLocks(lockDir: string): string[] {
    try {
      return readdirSync(lockDir);
    } catch {
      // No `~/.claude/ide` at all — the ordinary state of a machine whose
      // editor has never run the extension.
      return [];
    }
  }

  private readLock(lockDir: string, fileName: string): IdeLock | null {
    if (lockPortOf(fileName) === null) return null;
    try {
      return parseIdeLock(fileName, readFileSync(join(lockDir, fileName), 'utf8'));
    } catch {
      return null;
    }
  }

  private addLock(lock: IdeLock): void {
    const entry: Entry = {
      lock,
      connection: this.connect(lock),
      ready: false,
      selection: null,
      queued: null,
      timer: null,
      activeAt: 0,
      readyAt: null,
    };
    this.byPort.set(lock.port, entry);
    entry.connection.on('ready', () => this.onReady(entry));
    entry.connection.on('selection', (params: unknown) => this.onSelection(entry, params));
    entry.connection.on('closed', () => this.onClosed(entry));
  }

  /**
   * The socket went away while the lock may still be there — an editor that
   * served another client instead, most often (`IDE_RECONNECT_MIN_MS`). The
   * editor is dropped at once, so nothing waits on a dead socket, and the
   * lock is read again after a wait: still there, it is connected to again;
   * gone or changed, the watch has already said so or the read does.
   */
  private onClosed(entry: Entry): void {
    const port = entry.lock.port;
    const lockDir = this.lockDirByPort.get(port);
    this.dropLock(port);
    if (lockDir === undefined) return;
    const lasted = entry.readyAt !== null && Date.now() - entry.readyAt >= IDE_RECONNECT_STABLE_MS;
    const previous = this.reconnects.get(port)?.delayMs;
    const delayMs = lasted || previous === undefined
      ? IDE_RECONNECT_MIN_MS
      : Math.min(previous * 2, IDE_RECONNECT_MAX_MS);
    const reconnect: Reconnect = { lockDir, delayMs, timer: null };
    reconnect.timer = setTimeout(() => {
      reconnect.timer = null;
      this.reopen(port, reconnect);
    }, delayMs);
    reconnect.timer.unref?.();
    this.reconnects.set(port, reconnect);
  }

  /** The retry `onClosed` scheduled: the lock as it is on disk now, or the end of retrying. */
  private reopen(port: number, reconnect: Reconnect): void {
    if (this.reconnects.get(port) !== reconnect || this.byPort.has(port)) return;
    const lock = this.readLock(reconnect.lockDir, `${port}.lock`);
    if (!lock) {
      this.reconnects.delete(port);
      return;
    }
    this.addLock(lock);
    this.lockDirByPort.set(port, reconnect.lockDir);
  }

  private stopReconnectTimer(port: number): void {
    const reconnect = this.reconnects.get(port);
    if (reconnect?.timer) clearTimeout(reconnect.timer);
    if (reconnect) reconnect.timer = null;
  }

  private cancelReconnect(port: number): void {
    this.stopReconnectTimer(port);
    this.reconnects.delete(port);
  }

  private dropLock(port: number): void {
    const entry = this.byPort.get(port);
    if (!entry) return;
    this.byPort.delete(port);
    this.lockDirByPort.delete(port);
    if (entry.timer) clearTimeout(entry.timer);
    entry.connection.removeAllListeners();
    entry.connection.close();
    // A root another editor also has open passes to it rather than going
    // dark: the project is still open, just in one editor fewer.
    const inherited: string[] = [];
    for (const root of entry.lock.workspaceFolders) {
      if (this.entryByRoot.get(root) !== entry) continue;
      const heir = this.heirOf(root);
      if (heir) {
        this.entryByRoot.set(root, heir);
        inherited.push(root);
      } else {
        this.entryByRoot.delete(root);
      }
    }
    this.reresolve();
    // The root did not move, so `reresolve` saw nothing; the editor behind it did.
    for (const root of inherited) this.emitChange(root);
  }

  /** The most recently used ready editor that has this root open, if any. */
  private heirOf(root: string): Entry | undefined {
    let heir: Entry | undefined;
    for (const entry of this.byPort.values()) {
      if (!entry.ready || !entry.lock.workspaceFolders.includes(root)) continue;
      if (!heir || entry.activeAt > heir.activeAt) heir = entry;
    }
    return heir;
  }

  private onReady(entry: Entry): void {
    if (!this.byPort.has(entry.lock.port)) return;
    entry.ready = true;
    entry.readyAt = Date.now();
    entry.activeAt = ++this.uses;
    // An editor that has just opened the project takes it, the way one that
    // has just been used does (`flush`). The newer connection is also the one
    // more likely to still be alive.
    const taken: string[] = [];
    for (const root of entry.lock.workspaceFolders) {
      const holder = this.entryByRoot.get(root);
      if (holder && holder !== entry) taken.push(root);
      this.entryByRoot.set(root, entry);
    }
    this.reresolve();
    // A root taken from another editor did not move, so `reresolve` saw
    // nothing; the editor behind it — its name, its selection — did.
    for (const root of taken) this.emitChange(root);
  }

  /**
   * A burst in, one publish out. The timer starts on the first notification
   * of a burst and is not extended by the rest, so a drag that never stops
   * still publishes; what it publishes is whatever the drag had reached.
   */
  private onSelection(entry: Entry, params: unknown): void {
    const next = normaliseSelection(params);
    if (!next) return;
    entry.queued = next;
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.flush(entry);
    }, this.coalesceMs);
    entry.timer.unref?.();
  }

  private flush(entry: Entry): void {
    const next = entry.queued;
    entry.queued = null;
    // Byte-identical repeats are a third of the flood, and publishing one
    // would republish every session in the workspace for no change at all.
    if (!next || sameSelection(entry.selection, next)) return;
    entry.selection = next;
    if (!entry.ready) return;
    entry.activeAt = ++this.uses;
    // A selection is someone working in this editor, so a project open in
    // another editor as well comes over to this one (spec
    // 2026-09-23-ide-bridge-design § Two editors on one project).
    for (const root of entry.lock.workspaceFolders) {
      this.entryByRoot.set(root, entry);
      this.emitChange(root);
    }
  }

  private emitChange(root: string): void {
    const cwds = this.cwdsFor(root);
    if (cwds.length > 0) this.emit('change', root, cwds);
  }

  /**
   * Re-answers `locate` for every `cwd` already asked about, and says which
   * ones moved. Needed because an editor opening or closing changes the
   * answer for directories that were resolved long before — unlike a working
   * tree, whose membership does not change under a session's feet.
   */
  private reresolve(): void {
    const roots = [...this.entryByRoot.keys()];
    const touched = new Map<string, string[]>();
    for (const cwd of this.seenCwds) {
      const before = this.rootByCwd.get(cwd) ?? null;
      const after = workspaceRootFor(cwd, roots);
      if (after === before) continue;
      this.setRoot(cwd, after);
      // Grouped under whichever root is the news: the one gained, or the one
      // lost when nothing covers the directory any more.
      const key = after ?? before;
      if (key === null) continue;
      const list = touched.get(key);
      if (list) list.push(cwd);
      else touched.set(key, [cwd]);
    }
    for (const [root, cwds] of touched) this.emit('change', root, cwds);
  }

  private setRoot(cwd: string, root: string | null): void {
    const previous = this.rootByCwd.get(cwd) ?? null;
    if (previous !== null) {
      const cwds = this.cwdsByRoot.get(previous);
      cwds?.delete(cwd);
      if (cwds && cwds.size === 0) this.cwdsByRoot.delete(previous);
    }
    this.rootByCwd.set(cwd, root);
    if (root === null) return;
    let cwds = this.cwdsByRoot.get(root);
    if (!cwds) this.cwdsByRoot.set(root, (cwds = new Set()));
    cwds.add(cwd);
  }
}

/** `openFile`'s texts for no line: VS Code requires both, and empty ones select nothing. */
const NO_LINE = { startText: '', endText: '' };

/**
 * An `endText` the file does not contain. VS Code, finding `startText` but no
 * `endText` after it, puts the caret at the start of the match instead of
 * selecting it — and a selection would come straight back as
 * `selection_changed` and ride along with the next message as if the person
 * had made it.
 */
const CARET_END_TEXT = '\u0000';

/**
 * `openFile`'s texts for a line of the file as it is on disk, or `NO_LINE`
 * when the file is not one the viewer would read for the session. The editor
 * searches its own buffer, so unsaved edits above the line can move where it
 * lands.
 */
function lineTexts(cwd: string, path: string, line: number): typeof NO_LINE {
  try {
    const read = readTextFile(cwd, path);
    if (read.kind !== 'ok') return NO_LINE;
    const content = read.bytes.toString('utf8');
    const startText = revealTextFor(content, line);
    if (!startText) return NO_LINE;
    // A file holding the sentinel gets the run selected rather than a caret.
    return { startText, endText: content.includes(CARET_END_TEXT) ? '' : CARET_END_TEXT };
  } catch {
    return NO_LINE;
  }
}

/** Drops a tab `openDiff` opened. Safe to call for one already gone. */
async function closeTabIn(entry: Entry, tabName: string): Promise<void> {
  if (!entry.connection.hasTool(CLOSE_TAB_TOOL)) return;
  await entry.connection.callTool(CLOSE_TAB_TOOL, { tab_name: tabName });
}

/** Whether a rewritten lock still describes the connection already open. */
function sameLock(a: IdeLock, b: IdeLock): boolean {
  return (
    a.authToken === b.authToken &&
    a.ideName === b.ideName &&
    a.workspaceFolders.length === b.workspaceFolders.length &&
    a.workspaceFolders.every((root, i) => root === b.workspaceFolders[i])
  );
}
