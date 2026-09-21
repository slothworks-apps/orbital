import { and, eq, inArray } from 'drizzle-orm';
import { homedir } from 'node:os';
import type { OrbitalDb } from '../db/database.js';
import { sessions, sessionTags, tagRuleColumns, tagRules, tags } from '../db/schema.js';
import type { TagRule } from '../types.js';

/**
 * A `path_matches` pattern is a JavaScript regex, tested UNANCHORED against
 * the session's cwd — `slothworks/orbital` matches anywhere in the path, and
 * anchoring is opted into with `^`/`$` like any regex. A leading `~/` (also
 * directly after `^`) expands to the home directory, same convenience as
 * everywhere else a path is typed; the expansion is regex-escaped so a home
 * directory containing a metacharacter stays literal.
 *
 * Returns null — "matches nothing" — for an empty pattern (a freshly added
 * rule must not grab every session) and for a regex that does not compile
 * (old glob patterns like `**`; the UI flags these inline).
 */
function compilePattern(pattern: string): RegExp | null {
  let source = pattern.trim();
  if (!source) return null;
  const anchored = source.startsWith('^');
  const body = anchored ? source.slice(1) : source;
  if (body === '~' || body.startsWith('~/')) {
    const home = homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    source = (anchored ? '^' : '') + home + body.slice(1);
  }
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

export function matchRule(
  rules: TagRule[],
  s: { cwd: string; title: string; permissionMode: string | null },
): TagRule | null {
  const ordered = [...rules].sort((a, b) => a.position - b.position);
  for (const rule of ordered) {
    if (!rule.enabled) continue;
    switch (rule.condition) {
      case 'path_matches': {
        const re = compilePattern(rule.pattern);
        if (re?.test(s.cwd)) return rule;
        break;
      }
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
