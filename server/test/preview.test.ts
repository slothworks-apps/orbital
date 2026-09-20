import { describe, it, expect, afterAll } from 'vitest';
import {
  chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readFilePreview, FILE_PREVIEW_MAX_BYTES } from '../src/files/preview.js';

/** A fresh sandbox per test — realpath'd so macOS's /tmp → /private/tmp
 * symlink can't make an inside path look outside. */
function makeCwd() {
  return mkdtempSync(join(tmpdir(), 'orbital-preview-'));
}

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});
function tracked(dir: string) {
  cleanups.push(dir);
  return dir;
}

describe('readFilePreview', () => {
  it('resolves a relative path against cwd', () => {
    const cwd = tracked(makeCwd());
    writeFileSync(join(cwd, 'note.txt'), 'hello');
    const result = readFilePreview(cwd, 'note.txt');
    expect(result).toMatchObject({ kind: 'ok', content: 'hello', size: 5, lines: 1 });
    expect((result as any).mtimeMs).toBeTypeOf('number');
  });

  it('resolves a nested relative path', () => {
    const cwd = tracked(makeCwd());
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'a.ts'), 'x');
    expect(readFilePreview(cwd, 'src/a.ts')).toMatchObject({ kind: 'ok', content: 'x' });
  });

  it('accepts an absolute path inside cwd', () => {
    const cwd = tracked(makeCwd());
    const file = join(cwd, 'abs.txt');
    writeFileSync(file, 'abs');
    expect(readFilePreview(cwd, file)).toMatchObject({ kind: 'ok', content: 'abs' });
  });

  it('expands a tilde path (the API-boundary rule)', () => {
    // The fixture lives under the real homedir so `~/...` can name it.
    const cwd = tracked(mkdtempSync(join(homedir(), '.orbital-preview-test-')));
    writeFileSync(join(cwd, 'home.txt'), 'home sweet home');
    const viaTilde = `~/${relative(homedir(), join(cwd, 'home.txt'))}`;
    expect(readFilePreview(cwd, viaTilde)).toMatchObject({
      kind: 'ok', content: 'home sweet home',
    });
  });

  it('a tilde path that does not exist is not_found, never a literal ~ directory', () => {
    const cwd = tracked(makeCwd());
    const result = readFilePreview(cwd, `~/definitely-not-here-${Math.random().toString(36).slice(2)}`);
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('an empty cwd has no sandbox — outside', () => {
    expect(readFilePreview('', 'anything.txt')).toEqual({ kind: 'outside' });
  });

  it('.. traversal out of cwd is outside', () => {
    const parent = tracked(makeCwd());
    const cwd = join(parent, 'inner');
    mkdirSync(cwd);
    writeFileSync(join(parent, 'secret.txt'), 'secret');
    expect(readFilePreview(cwd, '../secret.txt')).toEqual({ kind: 'outside' });
  });

  it('a symlink pointing out of cwd is outside — realpath decides, not the spelling', () => {
    const outside = tracked(makeCwd());
    const cwd = tracked(makeCwd());
    writeFileSync(join(outside, 'target.txt'), 'leaked');
    symlinkSync(join(outside, 'target.txt'), join(cwd, 'innocent.txt'));
    expect(readFilePreview(cwd, 'innocent.txt')).toEqual({ kind: 'outside' });
  });

  it('a symlink staying inside cwd is ok', () => {
    const cwd = tracked(makeCwd());
    writeFileSync(join(cwd, 'real.txt'), 'still inside');
    symlinkSync(join(cwd, 'real.txt'), join(cwd, 'link.txt'));
    expect(readFilePreview(cwd, 'link.txt')).toMatchObject({ kind: 'ok', content: 'still inside' });
  });

  it('a missing file is not_found', () => {
    const cwd = tracked(makeCwd());
    expect(readFilePreview(cwd, 'ghost.txt')).toEqual({ kind: 'not_found' });
  });

  it('a path through a file (ENOTDIR) is not_found', () => {
    const cwd = tracked(makeCwd());
    writeFileSync(join(cwd, 'file.txt'), 'x');
    expect(readFilePreview(cwd, 'file.txt/deeper.txt')).toEqual({ kind: 'not_found' });
  });

  it('a directory is not_found', () => {
    const cwd = tracked(makeCwd());
    mkdirSync(join(cwd, 'dir'));
    expect(readFilePreview(cwd, 'dir')).toEqual({ kind: 'not_found' });
  });

  it('over FILE_PREVIEW_MAX_BYTES is too_large with the size, without reading', () => {
    const cwd = tracked(makeCwd());
    const size = FILE_PREVIEW_MAX_BYTES + 1;
    writeFileSync(join(cwd, 'big.log'), Buffer.alloc(size));
    // Stat-able but unreadable: too_large must come from the stat alone.
    chmodSync(join(cwd, 'big.log'), 0o000);
    try {
      expect(readFilePreview(cwd, 'big.log')).toEqual({ kind: 'too_large', size });
    } finally {
      chmodSync(join(cwd, 'big.log'), 0o644);
    }
  });

  it('a NUL byte in the head is binary, media type from the extension', () => {
    const cwd = tracked(makeCwd());
    const bytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]);
    writeFileSync(join(cwd, 'font.woff2'), bytes);
    expect(readFilePreview(cwd, 'font.woff2')).toEqual({
      kind: 'binary', size: bytes.length, mediaType: 'font/woff2',
    });
    writeFileSync(join(cwd, 'pic.png'), bytes);
    expect(readFilePreview(cwd, 'pic.png')).toMatchObject({
      kind: 'binary', mediaType: 'image/png',
    });
  });

  it('an unknown binary extension falls back to "binary"', () => {
    const cwd = tracked(makeCwd());
    writeFileSync(join(cwd, 'blob.xyz'), Buffer.from([0x00, 0x01, 0x02]));
    expect(readFilePreview(cwd, 'blob.xyz')).toEqual({
      kind: 'binary', size: 3, mediaType: 'binary',
    });
  });

  it('sniffing decides, not the extension — a UTF-8 .dat opens', () => {
    const cwd = tracked(makeCwd());
    writeFileSync(join(cwd, 'data.dat'), 'plain text, honestly — ün ⚡');
    expect(readFilePreview(cwd, 'data.dat')).toMatchObject({
      kind: 'ok', content: 'plain text, honestly — ün ⚡',
    });
  });

  it('counts lines as newlines + 1; the empty file is 1 line', () => {
    const cwd = tracked(makeCwd());
    writeFileSync(join(cwd, 'three.txt'), 'one\ntwo\nthree');
    expect(readFilePreview(cwd, 'three.txt')).toMatchObject({ kind: 'ok', lines: 3 });
    writeFileSync(join(cwd, 'trailing.txt'), 'one\ntwo\n');
    expect(readFilePreview(cwd, 'trailing.txt')).toMatchObject({ kind: 'ok', lines: 3 });
    writeFileSync(join(cwd, 'empty.txt'), '');
    expect(readFilePreview(cwd, 'empty.txt')).toMatchObject({ kind: 'ok', lines: 1, size: 0 });
  });
});
