import { expect } from 'vitest';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MIGRATIONS_FOLDER } from '../src/db/database.js';

/**
 * A copy of the migrations folder cut off just before the migration whose tag
 * ends in `suffix` — the database an older build would have left behind.
 * Truncated rather than filtered: Drizzle applies only migrations newer than
 * the last one it recorded, so leaving a later one in would make it skip the
 * one under test.
 */
export function migrationsBefore(dir: string, suffix: string): string {
  const before = join(dir, 'drizzle-before');
  cpSync(DEFAULT_MIGRATIONS_FOLDER, before, { recursive: true });
  const journalPath = join(before, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((e) => e.tag.endsWith(suffix));
  expect(cut).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  writeFileSync(journalPath, JSON.stringify(journal));
  return before;
}
