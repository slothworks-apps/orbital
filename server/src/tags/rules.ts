import { and, eq, inArray } from 'drizzle-orm';
import { homedir } from 'node:os';
import type { OrbitalDb } from '../db/database.js';
import { sessions, sessionTags, tagRules, tags } from '../db/schema.js';
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

// Mirrors the TagRule shape (snake_case, matching the original sqlite
// column names) so callers throughout the codebase — and the raw
// GET /api/tag-rules passthrough — keep seeing the same field names.
export const tagRuleColumns = {
  id: tagRules.id,
  tag_id: tagRules.tagId,
  position: tagRules.position,
  enabled: tagRules.enabled,
  condition: tagRules.condition,
  pattern: tagRules.pattern,
};

export function regenerateRuleTags(db: OrbitalDb): void {
  const rules = db.select(tagRuleColumns).from(tagRules).all() as unknown as TagRule[];
  const sessionRows = db
    .select({
      id: sessions.id,
      cwd: sessions.cwd,
      title: sessions.title,
      permission_mode: sessions.permissionMode,
    })
    .from(sessions)
    .all();
  db.transaction((tx) => {
    tx.delete(sessionTags).where(eq(sessionTags.origin, 'rule')).run();
    for (const s of sessionRows) {
      const rule = matchRule(rules, {
        cwd: s.cwd, title: s.title, permissionMode: s.permission_mode,
      });
      if (!rule) continue;
      const removed = tx
        .select()
        .from(sessionTags)
        .where(
          and(
            eq(sessionTags.sessionId, s.id),
            eq(sessionTags.tagId, rule.tag_id),
            eq(sessionTags.origin, 'manual_removed'),
          ),
        )
        .get();
      if (!removed) {
        tx.insert(sessionTags)
          .values({ sessionId: s.id, tagId: rule.tag_id, origin: 'rule' })
          .onConflictDoNothing()
          .run();
      }
    }
  });
}

export function effectiveTagIds(db: OrbitalDb, sessionId: string): number[] {
  const rows = db
    .selectDistinct({ tag_id: sessionTags.tagId })
    .from(sessionTags)
    .where(
      and(eq(sessionTags.sessionId, sessionId), inArray(sessionTags.origin, ['rule', 'manual'])),
    )
    .orderBy(sessionTags.tagId)
    .all();
  if (rows.length > 0) return rows.map((r) => r.tag_id);
  const def = db.select({ id: tags.id }).from(tags).where(eq(tags.isDefault, 1)).get() as {
    id: number;
  };
  return [def.id];
}
