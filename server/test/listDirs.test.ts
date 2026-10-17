import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir } from './tmp.js';

// A filesystem that reports no entry type (`DT_UNKNOWN`): every `is*` is false.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const untyped = (name: string) => ({
    name, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false,
    isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
  });
  return {
    ...fs,
    readdirSync: ((path: string, opts?: { withFileTypes?: boolean }) => opts?.withFileTypes
      ? fs.readdirSync(path).map(untyped)
      : fs.readdirSync(path)) as typeof fs.readdirSync,
  };
});

const { listDirs } = await import('../src/files/directory.js');

describe('listDirs on a filesystem without entry types', () => {
  it('asks statSync whether an untyped entry is a folder', () => {
    const dir = makeTmpDir('untyped');
    mkdirSync(join(dir, 'folder'));
    writeFileSync(join(dir, 'file.txt'), 'x');
    const listed = listDirs(dir);
    expect(listed.ok && listed.listing.dirs.map((d) => d.name)).toEqual(['folder']);
  });
});
