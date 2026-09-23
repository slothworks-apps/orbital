import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdeStore, IDE_SELECTION_COALESCE_MS } from '../src/ide/store.js';
import { OPEN_FILES_TOOL, type IdeLock } from '../src/ide/protocol.js';
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

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }
  async callTool(name: string): Promise<string | null> {
    return this.hasTool(name) ? this.answer : null;
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
