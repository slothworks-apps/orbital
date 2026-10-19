import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The directory a link points at belongs to another user: stood in for by a stat that says so.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    statSync: (path: string) => ({ ...fs.statSync(path), uid: fs.lstatSync(path).uid + 1, mode: 0o40700 }),
  };
});

const { DataDirNotOwned, ensureDataDir } = await import('../src/dataDir.js');

describe('ensureDataDir and a link to another user\'s directory', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orbital-datadir-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('refuses it though the link itself is this user\'s', () => {
    const target = join(root, 'theirs');
    mkdirSync(target);
    const dir = join(root, 'orbital');
    symlinkSync(target, dir);
    expect(() => ensureDataDir(dir, 'linux', lstatSync(dir).uid)).toThrow(DataDirNotOwned);
  });
});
