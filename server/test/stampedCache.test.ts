import { describe, it, expect, vi } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StampedCache, dirStamp, fileStamp } from '../src/transcript/stampedCache.js';
import { makeTmpDir } from './tmp.js';

describe('StampedCache', () => {
  it('builds once per stamp and rebuilds when the stamp moves', () => {
    const cache = new StampedCache<number>(2);
    const build = vi.fn(() => build.mock.calls.length);
    expect(cache.get('a', '1', build)).toBe(1);
    expect(cache.get('a', '1', build)).toBe(1);
    expect(cache.get('a', '2', build)).toBe(2);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used key past its bound', () => {
    const cache = new StampedCache<string>(2);
    cache.get('a', 's', () => 'a');
    cache.get('b', 's', () => 'b');
    cache.get('a', 's', () => 'rebuilt');
    cache.get('c', 's', () => 'c');
    // `b` was the oldest touch, so it went; `a` survived its use.
    expect(cache.get('a', 's', () => 'rebuilt')).toBe('a');
    expect(cache.get('b', 's', () => 'rebuilt')).toBe('rebuilt');
  });
});

describe('file stamps', () => {
  it('moves when a file is appended to, and is null for a missing one', () => {
    const dir = makeTmpDir('stamp');
    const path = join(dir, 't.jsonl');
    expect(fileStamp(path)).toBeNull();
    writeFileSync(path, 'a\n');
    const before = fileStamp(path);
    appendFileSync(path, 'b\n');
    expect(fileStamp(path)).not.toBe(before);
  });

  it('a directory stamp moves when a file in it appears or grows', () => {
    const root = makeTmpDir('stamp');
    const dir = join(root, 'subagents');
    expect(dirStamp(dir)).toBe('');
    mkdirSync(dir);
    writeFileSync(join(dir, 'agent-1.jsonl'), 'a\n');
    const one = dirStamp(dir);
    writeFileSync(join(dir, 'agent-2.jsonl'), 'a\n');
    const two = dirStamp(dir);
    appendFileSync(join(dir, 'agent-1.jsonl'), 'b\n');
    expect(new Set([one, two, dirStamp(dir)]).size).toBe(3);
  });
});
