import type Database from 'better-sqlite3';
import { homedir } from 'node:os';
import type { TagRule } from '../types.js';

function globToRegExp(glob: string): RegExp {
  const expanded = glob.startsWith('~') ? homedir() + glob.slice(1) : glob;
  let out = '';
  for (let i = 0; i < expanded.length; i++) {
    if (expanded.startsWith('**', i)) { out += '.*'; i++; }
    else if (expanded[i] === '*') out += '[^/]*';
    else out += expanded[i].replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function matchRule(
  rules: TagRule[],
  s: { cwd: string; title: string; permissionMode: string | null },
): TagRule | null {
  const ordered = [...rules].sort((a, b) => a.position - b.position);
  for (const rule of ordered) {
    if (!rule.enabled) continue;
    switch (rule.condition) {
      case 'path_matches':
        if (globToRegExp(rule.pattern).test(s.cwd)) return rule;
        break;
      case 'title_contains':
        if (s.title.toLowerCase().includes(rule.pattern.toLowerCase())) return rule;
        break;
      case 'permission_is':
        if (s.permissionMode === rule.pattern) return rule;
        break;
    }
  }
  return null;
}

export function regenerateRuleTags(db: Database.Database): void {
  const rules = db.prepare(`SELECT * FROM tag_rules`).all() as TagRule[];
  const sessions = db
    .prepare(`SELECT id, cwd, title, permission_mode FROM sessions`)
    .all() as Array<{ id: string; cwd: string; title: string; permission_mode: string | null }>;
  const removed = db.prepare(
    `SELECT 1 FROM session_tags WHERE session_id=? AND tag_id=? AND origin='manual_removed'`,
  );
  const insert = db.prepare(`INSERT OR IGNORE INTO session_tags VALUES (?, ?, 'rule')`);
  db.transaction(() => {
    db.prepare(`DELETE FROM session_tags WHERE origin='rule'`).run();
    for (const s of sessions) {
      const rule = matchRule(rules, {
        cwd: s.cwd, title: s.title, permissionMode: s.permission_mode,
      });
      if (rule && !removed.get(s.id, rule.tag_id)) insert.run(s.id, rule.tag_id);
    }
  })();
}

export function effectiveTagIds(db: Database.Database, sessionId: string): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT tag_id FROM session_tags
       WHERE session_id=? AND origin IN ('rule','manual') ORDER BY tag_id`,
    )
    .all(sessionId) as Array<{ tag_id: number }>;
  if (rows.length > 0) return rows.map((r) => r.tag_id);
  const def = db.prepare(`SELECT id FROM tags WHERE is_default=1`).get() as { id: number };
  return [def.id];
}
