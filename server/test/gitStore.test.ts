import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitStore } from '../src/git/store.js';

let dir: string;
let store: GitStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbital-gitstore-'));
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, '.git', 'refs/heads/main'), `${'a'.repeat(40)}\n`);
  // Watching is off: these tests drive invalidation directly, and a real
  // file watch would leave the suite waiting on filesystem events.
  store = new GitStore({ watch: false });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GitStore', () => {
  it('serves a second read from the cache, not from the disk', () => {
    expect(store.locate(dir)?.ref).toBe('main');
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    expect(store.locate(dir)?.ref).toBe('main');
  });

  it('re-reads HEAD when the working tree is refreshed', () => {
    store.locate(dir);
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    store.refresh(dir);
    expect(store.locate(dir)).toMatchObject({ ref: 'other', defaultBranch: false });
  });

  it('answers from one cached working tree for every cwd inside it', () => {
    const nested = join(dir, 'server', 'src');
    mkdirSync(nested, { recursive: true });
    expect(store.locate(nested)?.ref).toBe('main');
    expect(store.locate(join(dir, 'web'))?.ref).toBe('main');
    expect(store.cwdsFor(dir).sort()).toEqual([join(dir, 'web'), nested].sort());
  });

  it('caches a directory outside any repository, so the walk happens once', () => {
    const outside = mkdtempSync(join(tmpdir(), 'orbital-nogit-'));
    try {
      expect(store.locate(outside)).toBeNull();
      expect(store.locate(outside)).toBeNull();
      expect(store.cwdsFor(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('drops the working tree when its HEAD disappears', () => {
    const nested = join(dir, 'server');
    mkdirSync(nested, { recursive: true });
    expect(store.locate(nested)?.ref).toBe('main');
    unlinkSync(join(dir, '.git', 'HEAD'));
    store.applyHeadEvent(dir, 'unlink');
    expect(store.cwdsFor(dir)).toEqual([]);
    // Not served from a stale cache: the next read walks the filesystem again
    // and finds a repository it can no longer read a branch out of.
    expect(store.locate(nested)).toBeNull();
  });

  it('names the affected cwds when HEAD moves, so their sessions can be republished', () => {
    const nested = join(dir, 'web');
    mkdirSync(nested, { recursive: true });
    store.locate(nested);
    const seen: Array<[string, string[]]> = [];
    store.on('change', (root: string, cwds: string[]) => seen.push([root, cwds]));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    store.applyHeadEvent(dir, 'change');
    expect(seen).toEqual([[dir, [nested]]]);
    expect(store.locate(nested)?.ref).toBe('other');
  });

  it('tells index writes apart from HEAD moves, so a location republish does not follow every index write', () => {
    const nested = join(dir, 'web');
    mkdirSync(nested, { recursive: true });
    store.locate(nested);
    const heads: string[] = [];
    const indexes: Array<[string, string[]]> = [];
    store.on('change', (root: string) => heads.push(root));
    store.on('index', (root: string, cwds: string[]) => indexes.push([root, cwds]));
    store.applyIndexEvent(dir);
    expect(indexes).toEqual([[dir, [nested]]]);
    expect(heads).toEqual([]);
  });
});
