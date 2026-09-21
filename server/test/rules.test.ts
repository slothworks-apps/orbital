import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, type OrbitalDb } from '../src/db/database.js';
import { sessions, sessionTags, tagRules, tags } from '../src/db/schema.js';
import { matchRule, regenerateRuleTags, effectiveTagIds } from '../src/tags/rules.js';
import type { TagRule } from '../src/types.js';

const rules: TagRule[] = [
  { id: 1, tag_id: 10, position: 0, enabled: 1, condition: 'path_matches', pattern: '~/work/' },
  { id: 2, tag_id: 11, position: 1, enabled: 1, condition: 'title_contains', pattern: 'exp-' },
  { id: 3, tag_id: 12, position: 2, enabled: 0, condition: 'permission_is', pattern: 'bypassPermissions' },
];

function pathRule(pattern: string): TagRule {
  return { id: 4, tag_id: 20, position: 0, enabled: 1, condition: 'path_matches', pattern };
}

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
  it('pattern is a regex matched anywhere in the path (unanchored)', () => {
    const s = { cwd: '/Users/x/Projects/slothworks/orbital/web', title: '', permissionMode: null };
    expect(matchRule([pathRule('slothworks/orbital')], s)?.tag_id).toBe(20);
    expect(matchRule([pathRule('slothworks/atlas')], s)).toBeNull();
  });
  it('regex metacharacters work (alternation, wildcards)', () => {
    const s = { cwd: '/Users/x/Projects/acme-app/api', title: '', permissionMode: null };
    expect(matchRule([pathRule('acme.*/api')], s)?.tag_id).toBe(20);
    expect(matchRule([pathRule('/(orbital|acme)')], s)?.tag_id).toBe(20);
  });
  it('explicit anchors constrain the match', () => {
    const sExact = { cwd: '/a/b', title: '', permissionMode: null };
    const sDeep = { cwd: '/a/b/c', title: '', permissionMode: null };
    expect(matchRule([pathRule('^/a/b$')], sExact)?.tag_id).toBe(20);
    expect(matchRule([pathRule('^/a/b$')], sDeep)).toBeNull();
  });
  it('leading ~/ expands to the home directory, also after ^', () => {
    const s = { cwd: join(homedir(), 'work/platform'), title: '', permissionMode: null };
    expect(matchRule([pathRule('~/work')], s)?.tag_id).toBe(20);
    expect(matchRule([pathRule('^~/work')], s)?.tag_id).toBe(20);
    expect(matchRule([pathRule('^/work')], s)).toBeNull();
  });
  it('an invalid regex matches nothing instead of throwing', () => {
    const s = { cwd: join(homedir(), 'work/platform'), title: '', permissionMode: null };
    expect(matchRule([pathRule('~/work/**')], s)).toBeNull();
    expect(matchRule([pathRule('[')], s)).toBeNull();
  });
  it('an empty pattern matches nothing', () => {
    const s = { cwd: '/anything', title: '', permissionMode: null };
    expect(matchRule([pathRule('')], s)).toBeNull();
    expect(matchRule([pathRule('  ')], s)).toBeNull();
  });
});

describe('regenerateRuleTags + effectiveTagIds', () => {
  let db: OrbitalDb;
  beforeEach(() => {
    db = openDb(join(mkdtempSync(join(tmpdir(), 'orbital-rules-')), 'index.db'));
    db.insert(tags).values({ id: 10, name: 'work', hue: 210 }).run();
    db.insert(tagRules)
      .values({ tagId: 10, position: 0, enabled: 1, condition: 'title_contains', pattern: 'auth' })
      .run();
    db.insert(sessions)
      .values([
        { id: 's1', projectDir: 'p', cwd: '/x', title: 'auth refactor' },
        { id: 's2', projectDir: 'p', cwd: '/x', title: 'recipes' },
      ])
      .run();
  });
  it('assigns rule tags, respects manual_removed, falls back to default', () => {
    db.insert(sessionTags).values({ sessionId: 's2', tagId: 10, origin: 'manual_removed' }).run();
    regenerateRuleTags(db);
    expect(effectiveTagIds(db, 's1')).toEqual([10]);
    const defaultId = (
      db.select({ id: tags.id }).from(tags).where(eq(tags.isDefault, 1)).get() as { id: number }
    ).id;
    expect(effectiveTagIds(db, 's2')).toEqual([defaultId]);
  });

  // A session wears one tag (canvas 1b). The rows behind it can still be
  // several — a rule tag the user then overrode by picking another.
  it('resolves to a single tag, with a manual pick beating a rule tag', () => {
    db.insert(tags).values({ id: 11, name: 'experiments', hue: 150 }).run();
    regenerateRuleTags(db);
    expect(effectiveTagIds(db, 's1')).toEqual([10]);
    db.insert(sessionTags).values({ sessionId: 's1', tagId: 11, origin: 'manual' }).run();
    expect(effectiveTagIds(db, 's1')).toEqual([11]);
  });

  it('picks the lower id when a rule tag is all a session has twice over', () => {
    db.insert(tags).values({ id: 9, name: 'oncall', hue: 60 }).run();
    db.insert(sessionTags)
      .values([
        { sessionId: 's1', tagId: 9, origin: 'rule' },
        { sessionId: 's1', tagId: 10, origin: 'rule' },
      ])
      .run();
    expect(effectiveTagIds(db, 's1')).toEqual([9]);
  });
});
