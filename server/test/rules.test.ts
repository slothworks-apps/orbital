import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/database.js';
import { matchRule, regenerateRuleTags, effectiveTagIds } from '../src/tags/rules.js';
import type { TagRule } from '../src/types.js';

const rules: TagRule[] = [
  { id: 1, tag_id: 10, position: 0, enabled: 1, condition: 'path_matches', pattern: '~/work/**' },
  { id: 2, tag_id: 11, position: 1, enabled: 1, condition: 'title_contains', pattern: 'exp-' },
  { id: 3, tag_id: 12, position: 2, enabled: 0, condition: 'permission_is', pattern: 'bypassPermissions' },
];

describe('matchRule', () => {
  it('first enabled match wins, in position order', () => {
    const s = { cwd: join(homedir(), 'work/platform'), title: 'exp-vector', permissionMode: null };
    expect(matchRule(rules, s)?.tag_id).toBe(10);
  });
  it('skips disabled rules', () => {
    const s = { cwd: '/elsewhere', title: 'x', permissionMode: 'bypassPermissions' };
    expect(matchRule(rules, s)).toBeNull();
  });
  it('title_contains is case-insensitive', () => {
    const s = { cwd: '/elsewhere', title: 'EXP-run', permissionMode: null };
    expect(matchRule(rules, s)?.tag_id).toBe(11);
  });
  it('** glob matches deep paths (multiple segments)', () => {
    const deepRule: TagRule = { id: 4, tag_id: 20, position: 0, enabled: 1, condition: 'path_matches', pattern: '~/work/**' };
    const s = { cwd: join(homedir(), 'work/a/b/c.ts'), title: '', permissionMode: null };
    expect(matchRule([deepRule], s)?.tag_id).toBe(20);
  });
  it('** glob matches zero segments (directory itself)', () => {
    const deepRule: TagRule = { id: 4, tag_id: 20, position: 0, enabled: 1, condition: 'path_matches', pattern: '~/work/**' };
    const s = { cwd: join(homedir(), 'work/'), title: '', permissionMode: null };
    expect(matchRule([deepRule], s)?.tag_id).toBe(20);
  });
  it('single * does not cross directory boundaries', () => {
    const singleRule: TagRule = { id: 5, tag_id: 21, position: 0, enabled: 1, condition: 'path_matches', pattern: '/a/*/b' };
    const sMatch = { cwd: '/a/x/b', title: '', permissionMode: null };
    const sNoMatch = { cwd: '/a/x/y/b', title: '', permissionMode: null };
    expect(matchRule([singleRule], sMatch)?.tag_id).toBe(21);
    expect(matchRule([singleRule], sNoMatch)).toBeNull();
  });
  it('dot in pattern is literal, not regex wildcard', () => {
    const dotRule: TagRule = { id: 6, tag_id: 22, position: 0, enabled: 1, condition: 'path_matches', pattern: '~/work/*.ts' };
    const sMatch = { cwd: join(homedir(), 'work/file.ts'), title: '', permissionMode: null };
    const sNoMatch = { cwd: join(homedir(), 'work/fileXts'), title: '', permissionMode: null };
    expect(matchRule([dotRule], sMatch)?.tag_id).toBe(22);
    expect(matchRule([dotRule], sNoMatch)).toBeNull();
  });
});

describe('regenerateRuleTags + effectiveTagIds', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(join(mkdtempSync(join(tmpdir(), 'orbital-rules-')), 'index.db'));
    db.prepare(`INSERT INTO tags (id, name, hue) VALUES (10, 'work', 210)`).run();
    db.prepare(
      `INSERT INTO tag_rules (tag_id, position, enabled, condition, pattern)
       VALUES (10, 0, 1, 'title_contains', 'auth')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, project_dir, cwd, title) VALUES
       ('s1', 'p', '/x', 'auth refactor'), ('s2', 'p', '/x', 'recipes')`,
    ).run();
  });
  it('assigns rule tags, respects manual_removed, falls back to default', () => {
    db.prepare(`INSERT INTO session_tags VALUES ('s2', 10, 'manual_removed')`).run();
    regenerateRuleTags(db);
    expect(effectiveTagIds(db, 's1')).toEqual([10]);
    const defaultId = (db.prepare(`SELECT id FROM tags WHERE is_default=1`).get() as any).id;
    expect(effectiveTagIds(db, 's2')).toEqual([defaultId]);
  });
});
