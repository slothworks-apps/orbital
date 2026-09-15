import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';

describe('openDb', () => {
  it('creates schema, seeds defaults, and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-db-'));
    const db = openDb(join(dir, 'index.db'));
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(['sessions', 'session_tags', 'settings', 'tag_rules', 'tags']),
    );
    const def = db.prepare(`SELECT name, hue, is_default FROM tags WHERE is_default = 1`).get() as any;
    expect(def.name).toBe('personal');
    expect(def.hue).toBe(330);
    const mode = db.prepare(`SELECT value FROM settings WHERE key='default_permission_mode'`).get() as any;
    expect(mode.value).toBe('acceptEdits');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();
    const again = openDb(join(dir, 'index.db')); // must not throw on re-run
    expect(again.prepare(`SELECT COUNT(*) c FROM tags`).get()).toMatchObject({ c: 1 });
    again.close();
  });
});
