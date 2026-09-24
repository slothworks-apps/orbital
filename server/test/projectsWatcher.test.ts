import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_TRANSCRIPTS,
  PROJECTS_MAX_WAIT_MS,
  PROJECTS_QUIET_MS,
  TargetBatcher,
  projectsEventTarget,
  type ProjectsBatch,
} from '../src/watcher/projects.js';
import { watchDir } from '../src/watcher/watchDir.js';

describe('projectsEventTarget', () => {
  it('keeps session transcripts and project directories', () => {
    expect(projectsEventTarget('-Users-x-proj/abc-123.jsonl')).toBe('-Users-x-proj/abc-123.jsonl');
    expect(projectsEventTarget('-Users-x-proj')).toBe('-Users-x-proj');
  });
  it('asks for everything when the event names nothing', () => {
    expect(projectsEventTarget(null)).toBe(ALL_TRANSCRIPTS);
  });
  it('drops what the index does not read', () => {
    for (const rel of [
      '-Users-x-proj/abc/subagents/agent-1.jsonl',
      '-Users-x-proj/abc/tool-results/t.txt',
      '-Users-x-proj/memory/MEMORY.md',
      '-Users-x-proj/memory',
      '-Users-x-proj/sessions-index.json',
      '-Users-x-proj/.DS_Store',
      '.DS_Store',
      '-Users-x-proj/',
    ]) {
      expect(projectsEventTarget(rel), rel).toBeNull();
    }
  });
});

describe('TargetBatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes once the events stop, with each path once', () => {
    vi.useFakeTimers();
    const batches: ProjectsBatch[] = [];
    const batcher = new TargetBatcher((b) => batches.push(b));
    batcher.add('p/a.jsonl');
    batcher.add('p/a.jsonl');
    batcher.add('p/b.jsonl');
    vi.advanceTimersByTime(PROJECTS_QUIET_MS - 1);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([{ all: false, paths: ['p/a.jsonl', 'p/b.jsonl'] }]);
  });

  // A working session writes its transcript more often than the quiet period.
  it('does not wait past the max wait for a file that never stops changing', () => {
    vi.useFakeTimers();
    const batches: ProjectsBatch[] = [];
    const batcher = new TargetBatcher((b) => batches.push(b));
    const step = PROJECTS_QUIET_MS / 2;
    for (let t = 0; t < PROJECTS_MAX_WAIT_MS; t += step) {
      batcher.add('p/a.jsonl');
      vi.advanceTimersByTime(step);
    }
    expect(batches).toEqual([{ all: false, paths: ['p/a.jsonl'] }]);
    batcher.cancel();
  });

  it('turns the whole batch into a full pass when one event named nothing', () => {
    vi.useFakeTimers();
    const batches: ProjectsBatch[] = [];
    const batcher = new TargetBatcher((b) => batches.push(b));
    batcher.add('p/a.jsonl');
    batcher.add(ALL_TRANSCRIPTS);
    vi.advanceTimersByTime(PROJECTS_QUIET_MS);
    expect(batches).toEqual([{ all: true }]);
  });
});

describe('watchDir', () => {
  /** Resolves on the first event that satisfies `accept`, or rejects after `ms`. */
  function nextEvent<T>(subscribe: (resolve: (v: T) => void) => void, ms = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no event')), ms);
      subscribe((v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }

  it('reports writes deep in the tree as paths relative to it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orbital-watchdir-'));
    mkdirSync(join(root, 'proj'));
    let onPath: (p: string) => void = () => {};
    const watch = watchDir(root, {
      recursive: true,
      onEvent: (rel) => {
        if (rel === 'proj/s.jsonl') onPath(rel);
      },
    });
    try {
      const seen = nextEvent<string>((r) => (onPath = r));
      // FSEvents starts delivering a beat after the stream is created.
      await new Promise((r) => setTimeout(r, 100));
      writeFileSync(join(root, 'proj', 's.jsonl'), '{}\n');
      expect(await seen).toBe('proj/s.jsonl');
    } finally {
      watch.close();
    }
  });

  // A fresh machine has no ~/.claude/projects until the CLI first runs.
  it('waits for a directory that does not exist yet, then watches it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orbital-watchdir-'));
    const dir = join(root, 'claude', 'projects');
    let onAppear: () => void = () => {};
    let onPath: (p: string) => void = () => {};
    const watch = watchDir(dir, {
      recursive: true,
      onAppear: () => onAppear(),
      onEvent: (rel) => {
        if (rel === 'proj/s.jsonl') onPath(rel);
      },
    });
    try {
      const appeared = nextEvent<void>((r) => (onAppear = r));
      await new Promise((r) => setTimeout(r, 100));
      mkdirSync(join(root, 'claude'));
      await new Promise((r) => setTimeout(r, 100));
      mkdirSync(dir);
      await appeared;

      const seen = nextEvent<string>((r) => (onPath = r));
      await new Promise((r) => setTimeout(r, 100));
      mkdirSync(join(dir, 'proj'));
      writeFileSync(join(dir, 'proj', 's.jsonl'), '{}\n');
      expect(await seen).toBe('proj/s.jsonl');
    } finally {
      watch.close();
    }
  });
});
