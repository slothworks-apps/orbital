import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A filesystem that keeps no modes (vfat, CIFS) refuses the chmod.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    chmodSync: () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    },
  };
});

const { ensureDataDir } = await import('../src/dataDir.js');

describe('ensureDataDir on a filesystem that refuses chmod', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orbital-datadir-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('goes on with a warning that names the dir and why, rather than throwing', () => {
    const dir = join(root, 'orbital');
    mkdirSync(dir, { mode: 0o755 });
    let warning: string | null = null;
    expect(() => {
      warning = ensureDataDir(dir, 'linux', statSync(dir).uid);
    }).not.toThrow();
    expect(warning).toContain(dir);
    expect(warning).toContain('EPERM');
  });
});
