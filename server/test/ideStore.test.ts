import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdeStore, IDE_SELECTION_COALESCE_MS } from '../src/ide/store.js';
import {
  CLOSE_TAB_TOOL,
  DIAGNOSTICS_TOOL,
  OPEN_DIFF_TOOL,
  OPEN_FILES_TOOL,
  OPEN_FILE_TOOL,
  type IdeLock,
} from '../src/ide/protocol.js';
import type { IdeConnection } from '../src/ide/client.js';

/**
 * The store without an editor. Every test here writes real lock files and
 * drives `applyLockEvent` directly, the way `gitStore.test.ts` drives
 * `applyHeadEvent` — the chokidar watch that normally raises those events is
 * glue, and a suite waiting on filesystem notifications is a flaky one.
 *
 * The socket is the one part of this feature a test cannot own, so it is
 * injected: `FakeConnection` stands in for `IdeSocket` and is driven by hand.
 */
class FakeConnection extends EventEmitter implements IdeConnection {
  tools = new Set<string>([OPEN_FILES_TOOL]);
  answer: string | null = '';
  closed = false;
  /** Every `tools/call` this connection was asked for, in order. */
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  /** Per-tool text answers, falling back to `answer`. */
  answers = new Map<string, string | null>();
  /** What `callToolContent` answers with, per tool. */
  content = new Map<string, unknown[] | null>();
  /** Resolves the next `callToolContent` by hand — the blocking `openDiff`. */
  blockContent: ((value: unknown[] | null) => void) | null = null;

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string | null> {
    this.calls.push({ name, args });
    if (!this.hasTool(name)) return null;
    return this.answers.has(name) ? (this.answers.get(name) ?? null) : this.answer;
  }
  async callToolContent(
    name: string,
    args: Record<string, unknown> = {},
    opts: { signal?: AbortSignal } = {},
  ): Promise<unknown[] | null> {
    this.calls.push({ name, args });
    if (!this.hasTool(name)) return null;
    if (this.content.has(name)) return this.content.get(name) ?? null;
    // The measured `openDiff`: nothing comes back until a human acts, or
    // until the wait is abandoned.
    return new Promise((resolve) => {
      this.blockContent = resolve;
      opts.signal?.addEventListener('abort', () => resolve(null), { once: true });
    });
  }
  close(): void {
    this.closed = true;
  }
}

let claudeDir: string;
let lockDir: string;
let made: Array<{ lock: IdeLock; connection: FakeConnection }>;
let store: IdeStore;

/** One lock on disk, in the shape the JetBrains plugin writes. */
function writeLock(port: number, folders: string[], extra: Record<string, unknown> = {}): string {
  const name = `${port}.lock`;
  writeFileSync(
    join(lockDir, name),
    JSON.stringify({
      workspaceFolders: folders,
      pid: 1,
      ideName: 'WebStorm',
      transport: 'ws',
      authToken: `token-${port}`,
      ...extra,
    }),
  );
  return name;
}

/** A lock, seen by the store, with its editor having finished the handshake. */
function connect(port: number, folders: string[]): FakeConnection {
  store.applyLockEvent(writeLock(port, folders), 'add');
  const entry = made[made.length - 1];
  entry.connection.emit('ready', [...entry.connection.tools]);
  return entry.connection;
}

function selectionAt(filePath: string, line: number, text: string | null): Record<string, unknown> {
  return {
    selection: { start: { line, character: 0 }, end: { line, character: 12 } },
    ...(text === null ? {} : { text }),
    filePath,
  };
}

beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), 'orbital-ide-'));
  lockDir = join(claudeDir, 'ide');
  mkdirSync(lockDir, { recursive: true });
  made = [];
  store = new IdeStore({
    claudeDir,
    watch: false,
    connect: (lock) => {
      const connection = new FakeConnection();
      made.push({ lock, connection });
      return connection;
    },
  });
});

afterEach(() => {
  store.close();
  rmSync(claudeDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('IdeStore: which editor covers a cwd', () => {
  it('answers null for every directory when no editor is running', () => {
    store.start();
    expect(made).toEqual([]);
    expect(store.locate('/w/a/src')).toBeNull();
    expect(store.cwdsFor('/w/a')).toEqual([]);
  });

  it('names the editor for a cwd inside its workspace, and nothing outside it', () => {
    connect(60108, ['/w/a']);
    expect(store.locate('/w/a/src')).toEqual({
      ideName: 'WebStorm',
      workspaceRoot: '/w/a',
      selection: null,
    });
    expect(store.locate('/w/b')).toBeNull();
    expect(store.locate('/w/a-evil')).toBeNull();
  });

  it('gives a nested workspace to the editor that has it open', () => {
    connect(1, ['/w/a']);
    connect(2, ['/w/a/inner']);
    expect(store.locate('/w/a/inner/src')?.workspaceRoot).toBe('/w/a/inner');
    expect(store.locate('/w/a/src')?.workspaceRoot).toBe('/w/a');
  });

  it('keeps the reverse index, so a change can name the sessions it touches', () => {
    connect(1, ['/w/a']);
    store.locate('/w/a/src');
    store.locate('/w/a/web');
    store.locate('/w/b');
    expect(store.cwdsFor('/w/a').sort()).toEqual(['/w/a/src', '/w/a/web']);
    expect(store.cwdsFor('/w/b')).toEqual([]);
  });

  it('stays null while a lock is on disk but its port has not answered', () => {
    store.applyLockEvent(writeLock(60108, ['/w/a']), 'add');
    expect(made).toHaveLength(1);
    expect(store.locate('/w/a/src')).toBeNull();
  });

  it('reads the locks already on disk when it starts', () => {
    writeLock(60108, ['/w/a']);
    store.start();
    expect(made).toHaveLength(1);
    expect(made[0].lock.port).toBe(60108);
  });
});

describe('IdeStore: locks appearing and disappearing', () => {
  it('republishes the sessions a connecting editor now covers', () => {
    // Asked about before any editor existed, so its null is already cached.
    expect(store.locate('/w/a/src')).toBeNull();
    const seen: Array<[string, string[]]> = [];
    store.on('change', (root: string, cwds: string[]) => seen.push([root, cwds]));
    connect(60108, ['/w/a']);
    expect(seen).toEqual([['/w/a', ['/w/a/src']]]);
    expect(store.locate('/w/a/src')?.ideName).toBe('WebStorm');
  });

  it('drops the editor when its lock goes, and says whose sessions changed', () => {
    const connection = connect(60108, ['/w/a']);
    store.locate('/w/a/src');
    const seen: Array<[string, string[]]> = [];
    store.on('change', (root: string, cwds: string[]) => seen.push([root, cwds]));
    unlinkSync(join(lockDir, '60108.lock'));
    store.applyLockEvent('60108.lock', 'unlink');
    expect(seen).toEqual([['/w/a', ['/w/a/src']]]);
    expect(store.locate('/w/a/src')).toBeNull();
    expect(connection.closed).toBe(true);
  });

  it('drops the editor when the socket closes under it', () => {
    const connection = connect(60108, ['/w/a']);
    expect(store.locate('/w/a/src')).not.toBeNull();
    connection.emit('closed');
    expect(store.locate('/w/a/src')).toBeNull();
  });

  it('ignores a lock it cannot act on, and does not retry it', () => {
    writeFileSync(join(lockDir, '60108.lock'), 'half-written {');
    store.applyLockEvent('60108.lock', 'add');
    store.applyLockEvent('60108.lock', 'change');
    writeFileSync(join(lockDir, 'README.txt'), 'not a lock');
    store.applyLockEvent('README.txt', 'add');
    store.applyLockEvent('missing.lock', 'add');
    expect(made).toEqual([]);
    expect(store.locate('/w/a')).toBeNull();
  });

  it('leaves a rewritten lock alone unless it changed, and reconnects when it did', () => {
    connect(60108, ['/w/a']);
    store.applyLockEvent(writeLock(60108, ['/w/a']), 'change');
    expect(made).toHaveLength(1);

    // A reissued token means a different editor session on that port.
    store.applyLockEvent(writeLock(60108, ['/w/a'], { authToken: 'fresh' }), 'change');
    expect(made).toHaveLength(2);
    expect(made[0].connection.closed).toBe(true);
  });
});

describe('IdeStore: the selection flood', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('publishes once for a burst, and what the burst ended on', () => {
    connect(60108, ['/w/a']);
    store.locate('/w/a/src');
    const seen: string[][] = [];
    store.on('change', (_root: string, cwds: string[]) => seen.push(cwds));

    const connection = made[0].connection;
    for (let line = 0; line < 92; line++) {
      connection.emit('selection', selectionAt('/w/a/x.ts', line, 'text'));
    }
    expect(seen).toEqual([]);

    vi.advanceTimersByTime(IDE_SELECTION_COALESCE_MS);
    expect(seen).toEqual([['/w/a/src']]);
    expect(store.locate('/w/a/src')?.selection).toEqual({
      filePath: '/w/a/x.ts',
      lineStart: 92,
      lineCount: 1,
      text: 'text',
    });
  });

  it('suppresses a payload identical to the one before it', () => {
    connect(60108, ['/w/a']);
    store.locate('/w/a/src');
    const connection = made[0].connection;
    const seen: string[][] = [];
    store.on('change', (_root: string, cwds: string[]) => seen.push(cwds));

    connection.emit('selection', selectionAt('/w/a/x.ts', 3, 'text'));
    vi.advanceTimersByTime(IDE_SELECTION_COALESCE_MS);
    connection.emit('selection', selectionAt('/w/a/x.ts', 3, 'text'));
    vi.advanceTimersByTime(IDE_SELECTION_COALESCE_MS);
    expect(seen).toEqual([['/w/a/src']]);

    // A caret move in the same place is still a change: the selection went.
    connection.emit('selection', selectionAt('/w/a/x.ts', 3, null));
    vi.advanceTimersByTime(IDE_SELECTION_COALESCE_MS);
    expect(seen).toHaveLength(2);
    expect(store.locate('/w/a/src')?.selection?.text).toBeNull();
  });

  it('ignores a notification it cannot read at all', () => {
    connect(60108, ['/w/a']);
    store.locate('/w/a/src');
    const seen: string[][] = [];
    store.on('change', (_root: string, cwds: string[]) => seen.push(cwds));
    made[0].connection.emit('selection', { filePath: 'relative.ts' });
    vi.advanceTimersByTime(IDE_SELECTION_COALESCE_MS);
    expect(seen).toEqual([]);
  });
});

describe('IdeStore: open files', () => {
  it('lists the editor tabs inside the session sandbox, in the editor order', async () => {
    const connection = connect(60108, ['/w/a']);
    connection.answer = ['/w/a/src/z.ts', '/w/a/README.md', '/w/b/other.ts', '  '].join('\n');
    expect(await store.openFiles('/w/a')).toEqual(['/w/a/src/z.ts', '/w/a/README.md']);
    // The session's cwd is the sandbox, not the workspace root.
    expect(await store.openFiles('/w/a/src')).toEqual(['/w/a/src/z.ts']);
  });

  it('answers null when no editor covers the cwd', async () => {
    connect(60108, ['/w/a']);
    expect(await store.openFiles('/w/b')).toBeNull();
  });

  it('answers null when the connected editor does not list the tool', async () => {
    const connection = connect(60108, ['/w/a']);
    connection.tools.clear();
    expect(await store.openFiles('/w/a')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Talking back to the editor (spec § Talking back to the editor)
// ---------------------------------------------------------------------------

/** An editor with every outbound tool listed, covering `/w/a`. */
function connectSpeaking(folders = ['/w/a']): FakeConnection {
  const connection = connect(60108, folders);
  for (const tool of [OPEN_FILE_TOOL, DIAGNOSTICS_TOOL, OPEN_DIFF_TOOL, CLOSE_TAB_TOOL]) {
    connection.tools.add(tool);
  }
  return connection;
}

describe('IdeStore: opening a file in the editor', () => {
  it('sends the path, and the line as the gutter numbers it', async () => {
    const connection = connectSpeaking();
    expect(await store.openFile('/w/a', '/w/a/src/x.ts', 88)).toBe(true);
    expect(connection.calls.at(-1)).toMatchObject({
      name: OPEN_FILE_TOOL,
      args: { filePath: '/w/a/src/x.ts', startLine: 88, endLine: 88 },
    });
  });

  it('asks for no line when there is none to ask for', async () => {
    const connection = connectSpeaking();
    await store.openFile('/w/a', '/w/a/src/x.ts');
    expect(connection.calls.at(-1)?.args).toEqual({ filePath: '/w/a/src/x.ts' });
    // A line that is not a line is the same as none at all.
    await store.openFile('/w/a', '/w/a/src/x.ts', 0);
    expect(connection.calls.at(-1)?.args).toEqual({ filePath: '/w/a/src/x.ts' });
  });

  it('refuses a path outside the session sandbox without calling the editor', async () => {
    const connection = connectSpeaking();
    const before = connection.calls.length;
    // Orbital will not READ this path for the session, so it does not ask an
    // editor to open it on the session's behalf either.
    expect(await store.openFile('/w/a', '/w/b/secret.ts')).toBe(false);
    expect(connection.calls).toHaveLength(before);
  });

  it('answers false with no editor, and with an editor that lacks the tool', async () => {
    const connection = connectSpeaking();
    expect(await store.openFile('/w/b', '/w/b/x.ts')).toBe(false);
    connection.tools.delete(OPEN_FILE_TOOL);
    expect(await store.openFile('/w/a', '/w/a/x.ts')).toBe(false);
  });
});

describe('IdeStore: the editor’s own findings', () => {
  const ANSWER = JSON.stringify([
    { uri: 'file:///w/a/src/x.ts', diagnostics: [{ message: 'boom', severity: 'Error' }] },
    { uri: 'file:///w/b/other.ts', diagnostics: [{ message: 'not ours', severity: 'Error' }] },
  ]);

  it('drops findings outside the session sandbox', async () => {
    const connection = connectSpeaking();
    connection.answers.set(DIAGNOSTICS_TOOL, ANSWER);
    const found = await store.diagnostics('/w/a');
    expect(found?.map((d) => d.filePath)).toEqual(['/w/a/src/x.ts']);
  });

  it('asks about one file when given one, as a URI', async () => {
    const connection = connectSpeaking();
    connection.answers.set(DIAGNOSTICS_TOOL, ANSWER);
    await store.diagnostics('/w/a', '/w/a/src/x.ts');
    expect(connection.calls.at(-1)).toMatchObject({
      name: DIAGNOSTICS_TOOL,
      args: { uri: 'file:///w/a/src/x.ts' },
    });
  });

  it('answers null for no editor, a path outside the sandbox, and a missing tool', async () => {
    const connection = connectSpeaking();
    connection.answers.set(DIAGNOSTICS_TOOL, ANSWER);
    expect(await store.diagnostics('/w/b')).toBeNull();
    expect(await store.diagnostics('/w/a', '/w/b/other.ts')).toBeNull();
    connection.tools.delete(DIAGNOSTICS_TOOL);
    expect(await store.diagnostics('/w/a')).toBeNull();
  });
});

describe('IdeStore: the diff tab', () => {
  const ARGS = {
    oldPath: '/w/a/src/x.ts',
    newPath: '/w/a/src/x.ts',
    contents: 'next',
    tabName: 'x.ts · Orbital (abc123)',
  };

  it('names both sides of the file and the tab, and reads the verdict back', async () => {
    const connection = connectSpeaking();
    connection.content.set(OPEN_DIFF_TOOL, [
      { type: 'text', text: 'FILE_SAVED' },
      { type: 'text', text: 'hand edited' },
    ]);
    const outcome = await store.openDiff('/w/a', ARGS, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'saved', contents: 'hand edited' });
    expect(connection.calls.find((c) => c.name === OPEN_DIFF_TOOL)?.args).toEqual({
      old_file_path: ARGS.oldPath,
      new_file_path: ARGS.newPath,
      new_file_contents: 'next',
      tab_name: ARGS.tabName,
    });
  });

  it('drops the tab whatever happened, so no review outlives its decision', async () => {
    const connection = connectSpeaking();
    connection.content.set(OPEN_DIFF_TOOL, [{ type: 'text', text: 'DIFF_REJECTED' }]);
    await store.openDiff('/w/a', ARGS, new AbortController().signal);
    expect(connection.calls.at(-1)).toEqual({
      name: CLOSE_TAB_TOOL,
      args: { tab_name: ARGS.tabName },
    });
  });

  it('abandons the wait when the verdict came from somewhere else, and still drops the tab', async () => {
    const connection = connectSpeaking();
    // No scripted answer: the call blocks, exactly as the real one does.
    const controller = new AbortController();
    const pending = store.openDiff('/w/a', ARGS, controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    expect(connection.calls.at(-1)?.name).toBe(CLOSE_TAB_TOOL);
  });

  it('answers null with no editor, a path outside the sandbox, or no such tool', async () => {
    const connection = connectSpeaking();
    connection.content.set(OPEN_DIFF_TOOL, [{ type: 'text', text: 'DIFF_REJECTED' }]);
    const signal = new AbortController().signal;
    expect(await store.openDiff('/w/b', ARGS, signal)).toBeNull();
    expect(
      await store.openDiff('/w/a', { ...ARGS, oldPath: '/w/b/x.ts' }, signal),
    ).toBeNull();
    connection.tools.delete(OPEN_DIFF_TOOL);
    expect(await store.openDiff('/w/a', ARGS, signal)).toBeNull();
  });

  it('reports which tools the editor listed, so a feature can simply not appear', () => {
    const connection = connectSpeaking();
    expect(store.supports('/w/a', OPEN_DIFF_TOOL)).toBe(true);
    expect(store.supports('/w/b', OPEN_DIFF_TOOL)).toBe(false);
    connection.tools.delete(OPEN_DIFF_TOOL);
    expect(store.supports('/w/a', OPEN_DIFF_TOOL)).toBe(false);
  });
});
