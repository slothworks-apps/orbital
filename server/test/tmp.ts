import { afterAll, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type OrbitalDb } from '../src/db/database.js';

// Every temporary directory a test file makes goes through here, so none of
// them outlives the run. One made inside a test (its body or a beforeEach) is
// removed after that test; one made at file scope or in a beforeAll is removed
// when the file ends. The hooks are registered on import, before the file's
// own, and vitest runs after-hooks in reverse — so a file's afterEach that
// stops an app or a watcher still runs while its directory exists.

interface Scope {
  dirs: string[];
  closers: (() => void)[];
}

const fileScope: Scope = { dirs: [], closers: [] };
let testScope: Scope | null = null;

function scope(): Scope {
  return testScope ?? fileScope;
}

function release(s: Scope): void {
  // Databases first: removing the directory under an open SQLite handle
  // leaves its WAL with nowhere to go.
  for (const close of s.closers.splice(0).reverse()) close();
  for (const dir of s.dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

beforeEach(() => {
  testScope = { dirs: [], closers: [] };
});

afterEach(() => {
  if (testScope) release(testScope);
  testScope = null;
});

afterAll(() => release(fileScope));

function track(dir: string): string {
  scope().dirs.push(dir);
  return dir;
}

/** `orbital-<prefix>-…` in the OS temp dir, removed after the test or the file. */
export function makeTmpDir(prefix: string): string {
  return track(mkdtempSync(join(tmpdir(), `orbital-${prefix}-`)));
}

/** `.orbital-<prefix>-…` in the real home dir, for tests that need `~/…` to name it. */
export function makeHomeDir(prefix: string): string {
  return track(mkdtempSync(join(homedir(), `.orbital-${prefix}-`)));
}

/** A fresh database in its own temp dir, closed before that dir is removed. */
export function openTmpDb(prefix: string): OrbitalDb {
  const db = openDb(join(makeTmpDir(prefix), 'index.db'));
  scope().closers.push(() => {
    if (db.$client.open) db.$client.close();
  });
  return db;
}
