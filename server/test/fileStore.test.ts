import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, utimesSync } from 'node:fs';
import { dirname } from 'node:path';
import { createFileStore, safeFileName } from '../src/files/store.js';
import { makeTmpDir } from './tmp.js';

const tempDir = () => makeTmpDir('files-test');

describe('createFileStore', () => {
  it('keeps the uploaded name under a content-hash directory', () => {
    const dir = tempDir();
    const entry = createFileStore(dir).putBytes('report.xlsx', Buffer.from('cells'));
    expect(entry).toMatchObject({ kind: 'file', name: 'report.xlsx', bytes: 5 });
    expect(entry!.path).toMatch(new RegExp(`^${dir}/[a-f0-9]{64}/report\\.xlsx$`));
    expect(readFileSync(entry!.path, 'utf8')).toBe('cells');
  });

  it('stores the same bytes under the same name once', () => {
    const dir = tempDir();
    const store = createFileStore(dir);
    const a = store.putBytes('a.csv', Buffer.from('1,2'));
    const b = store.putBytes('a.csv', Buffer.from('1,2'));
    expect(a!.path).toBe(b!.path);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('refuses an empty file', () => {
    expect(createFileStore(tempDir()).putBytes('empty.txt', Buffer.alloc(0))).toBeNull();
  });

  it('prunes the oldest entries past the cap, never the one just written', () => {
    const dir = tempDir();
    const store = createFileStore(dir, { maxBytes: 10 });
    const old = store.putBytes('old.bin', Buffer.alloc(6, 1))!;
    const past = new Date(Date.now() - 60_000);
    utimesSync(dirname(old.path), past, past);
    const fresh = store.putBytes('new.bin', Buffer.alloc(6, 2))!;
    expect(readdirSync(dir)).toEqual([dirname(fresh.path).split('/').pop()]);
  });
});

describe('safeFileName', () => {
  it('keeps an ordinary name', () => {
    expect(safeFileName('Q3 report (final).xlsx')).toBe('Q3 report (final).xlsx');
  });

  it('cannot leave its directory', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a\\b\\c.txt')).toBe('c.txt');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('.')).toBe('file');
  });

  it('names a nameless upload', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('dir/')).toBe('file');
    expect(safeFileName('\u0000\u0001')).toBe('file');
  });
});
