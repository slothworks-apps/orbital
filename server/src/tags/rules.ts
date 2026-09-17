import { and, eq, inArray } from 'drizzle-orm';
import type { OrbitalDb } from '../db/database.js';
import { sessions, sessionTags, tagRuleColumns, tagRules, tags } from '../db/schema.js';
import { expandHome } from '../paths.js';
import type { TagRule } from '../types.js';

function globToRegExp(glob: string): RegExp {
  const expanded = expandHome(glob);
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

export function regenerateRuleTags(db: OrbitalDb): void {
  const rules = db.select(tagRuleColumns).from(tagRules).all();
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

/**
 * The tag a session wears. A session carries exactly ONE (canvas 1b: "one tag
 * per session · sets planet hue"), so this resolves the pile of `session_tags`
 * rows down to a single id: a manual pick beats a rule-derived tag, and a
 * session with neither falls back to the default tag.
 *
 * `session_tags` stays a many-row table because the origins have to be told
 * apart — `manual_removed` is how a rule tag is suppressed without deleting
 * the rule — and the result stays an array because that is the wire shape
 * (`ApiSession.tagIds`) the map, sidebar and tag filter already read.
 */
export function effectiveTagIds(db: OrbitalDb, sessionId: string): number[] {
  const rows = db
    .selectDistinct({ tag_id: sessionTags.tagId, origin: sessionTags.origin })
    .from(sessionTags)
    .where(
      and(eq(sessionTags.sessionId, sessionId), inArray(sessionTags.origin, ['rule', 'manual'])),
    )
    .orderBy(sessionTags.tagId)
    .all();
  // Lowest id within the winning origin, so the answer never depends on row
  // order — a session that somehow holds two manual rows still reads stably.
  const manual = rows.find((r) => r.origin === 'manual');
  const chosen = manual ?? rows[0];
  if (chosen) return [chosen.tag_id];
  const def = db.select({ id: tags.id }).from(tags).where(eq(tags.isDefault, 1)).get() as {
    id: number;
  };
  return [def.id];
}
