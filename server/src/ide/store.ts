import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { IdeSocket, NO_TIMEOUT, type IdeConnection } from './client.js';
import {
  CLOSE_TAB_TOOL,
  DIAGNOSTICS_TOOL,
  IDE_LOCK_DIR,
  OPEN_DIFF_TOOL,
  OPEN_FILES_TOOL,
  OPEN_FILE_TOOL,
  insideCwd,
  lockPortOf,
  normaliseSelection,
  parseDiagnostics,
  parseIdeLock,
  readDiffOutcome,
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
}

export interface IdeStoreOptions {
  /** The `~/.claude` this server watches; the locks live one level in. */
  claudeDir: string;
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
  private lockDir: string;
  private watch: boolean;
  private coalesceMs: number;
  private connect: (lock: IdeLock) => IdeConnection;

  private byPort = new Map<number, Entry>();
  /** Workspace root → the connected entry covering it. Ready entries only. */
  private entryByRoot = new Map<string, Entry>();
  /** `cwd` → workspace root, or null for "asked, nothing covers it". */
  private rootByCwd = new Map<string, string | null>();
  /** The reverse index, so a change can name the sessions it touches. */
  private cwdsByRoot = new Map<string, Set<string>>();
  /** Every `cwd` ever asked about — re-resolved when the editors change. */
  private seenCwds = new Set<string>();
  private watcher: FSWatcher | null = null;

  constructor(opts: IdeStoreOptions) {
    super();
    this.lockDir = join(opts.claudeDir, IDE_LOCK_DIR);
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
    for (const name of this.listLocks()) this.applyLockEvent(name, 'add');
    if (!this.watch || this.watcher) return;
    // `depth: 0` because the extension writes flat into this directory, and
    // a missing directory is not an error: chokidar picks it up if it ever
    // appears, and a machine with no editor never creates it.
    const watcher = chokidar.watch(this.lockDir, { ignoreInitial: true, depth: 0 });
    watcher.on('all', (event, path) => {
      if (event === 'add' || event === 'change') this.applyLockEvent(basename(path), event);
      else if (event === 'unlink') this.applyLockEvent(basename(path), 'unlink');
    });
    watcher.on('error', () => {});
    this.watcher = watcher;
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
    const text = await entry.connection.callTool(OPEN_FILES_TOOL);
    if (text === null) return null;
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && insideCwd(cwd, line));
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
    // `startLine`/`endLine` are 1-based here, matching the gutter, which is
    // the opposite of what `selection_changed` pushes. The extension takes
    // an absent pair as "just reveal the file".
    const args: Record<string, unknown> = { filePath: path };
    if (line !== null && Number.isSafeInteger(line) && line > 0) {
      args.startLine = line;
      args.endLine = line;
      args.startText = '';
      args.endText = '';
    }
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
      // unconditionally the simple thing to do.
      void this.closeTab(cwd, args.tabName);
    }
  }

  /** Drops a tab `openDiff` opened. Safe to call for one already gone. */
  async closeTab(cwd: string, tabName: string): Promise<void> {
    const entry = this.entryFor(cwd);
    if (!entry || !entry.connection.hasTool(CLOSE_TAB_TOOL)) return;
    await entry.connection.callTool(CLOSE_TAB_TOOL, { tab_name: tabName });
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
  applyLockEvent(fileName: string, event: 'add' | 'change' | 'unlink'): void {
    const lock = event === 'unlink' ? null : this.readLock(fileName);
    if (event === 'unlink') {
      const port = lockPortOf(fileName);
      if (port !== null) this.dropLock(port);
      return;
    }
    // Unparseable, or not a lock at all: ignored, and not retried.
    if (!lock) return;

    const existing = this.byPort.get(lock.port);
    if (existing && sameLock(existing.lock, lock)) return;
    // A rewritten lock is a new editor session on that port — a token it
    // reissued, or a project it swapped. The old socket is worth nothing.
    if (existing) this.dropLock(lock.port);
    this.addLock(lock);
  }

  close(): void {
    void this.watcher?.close();
    this.watcher = null;
    // Emptied before the sockets go, so the drops have no resolution left to
    // invalidate: a server shutting down does not want a republish per
    // workspace on its way out.
    this.rootByCwd.clear();
    this.cwdsByRoot.clear();
    this.seenCwds.clear();
    for (const port of [...this.byPort.keys()]) this.dropLock(port);
  }

  private listLocks(): string[] {
    try {
      return readdirSync(this.lockDir);
    } catch {
      // No `~/.claude/ide` at all — the ordinary state of a machine whose
      // editor has never run the extension.
      return [];
    }
  }

  private readLock(fileName: string): IdeLock | null {
    if (lockPortOf(fileName) === null) return null;
    try {
      return parseIdeLock(fileName, readFileSync(join(this.lockDir, fileName), 'utf8'));
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
    };
    this.byPort.set(lock.port, entry);
    entry.connection.on('ready', () => this.onReady(entry));
    entry.connection.on('selection', (params: unknown) => this.onSelection(entry, params));
    entry.connection.on('closed', () => this.dropLock(lock.port));
  }

  private dropLock(port: number): void {
    const entry = this.byPort.get(port);
    if (!entry) return;
    this.byPort.delete(port);
    if (entry.timer) clearTimeout(entry.timer);
    entry.connection.removeAllListeners();
    entry.connection.close();
    for (const root of entry.lock.workspaceFolders) {
      if (this.entryByRoot.get(root) === entry) this.entryByRoot.delete(root);
    }
    this.reresolve();
  }

  private onReady(entry: Entry): void {
    if (!this.byPort.has(entry.lock.port)) return;
    entry.ready = true;
    // Last lock in wins a contested root. Two editors on one project is not a
    // state anyone arranges on purpose, and either answer is as true as the
    // other; the newer connection is the one more likely to still be alive.
    for (const root of entry.lock.workspaceFolders) this.entryByRoot.set(root, entry);
    this.reresolve();
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
    for (const root of entry.lock.workspaceFolders) {
      if (this.entryByRoot.get(root) !== entry) continue;
      this.emit('change', root, this.cwdsFor(root));
    }
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

/** Whether a rewritten lock still describes the connection already open. */
function sameLock(a: IdeLock, b: IdeLock): boolean {
  return (
    a.authToken === b.authToken &&
    a.ideName === b.ideName &&
    a.workspaceFolders.length === b.workspaceFolders.length &&
    a.workspaceFolders.every((root, i) => root === b.workspaceFolders[i])
  );
}
