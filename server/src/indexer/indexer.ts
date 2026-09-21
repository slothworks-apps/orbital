import { eq, inArray, sql } from 'drizzle-orm';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { OrbitalDb } from '../db/database.js';
import { sessions, sweptSessions } from '../db/schema.js';
import { parseTranscript, extractMeta } from '../transcript/parser.js';
import { regenerateRuleTags } from '../tags/rules.js';

export function indexProjects(
  db: OrbitalDb,
  projectsDir: string,
): { scanned: number; indexed: number } {
  let scanned = 0;
  let indexed = 0;
  // Titles indexed before cleanTitle existed may still be CLI wrapper noise
  // (<local-command-caveat>…, <command-message>…), and titles indexed before
  // extractMeta learned to skip bare slash commands are stuck on "/clear".
  // Blank both and drop the mtime short-circuit so those transcripts re-derive
  // a clean title below. A command with arguments ("/foo bar", hence the space
  // test) is a legitimate title and is left alone.
  db.update(sessions)
    .set({ title: '', indexedMtime: 0 })
    .where(sql`${sessions.title} LIKE '<local-command-%' OR ${sessions.title} LIKE '<command-%' OR ${sessions.title} LIKE '<system-reminder%' OR (${sessions.title} LIKE '/%' AND ${sessions.title} NOT LIKE '% %')`)
    .run();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(projectsDir, d.name));
  } catch {
    return { scanned: 0, indexed: 0 };
  }

  /**
   * Sessions the retention sweep removed (spec
   * 2026-09-21-settings-sections-design § 4). Loaded once per scan rather
   * than queried per file: the table is small, and a scan touches every
   * transcript on the machine.
   *
   * Without this, retention would not work at all — the loop below inserts
   * every `.jsonl` the database lacks, so a swept session whose transcript is
   * still on disk would be back within one scan.
   */
  const tombstones = new Map(
    db.select().from(sweptSessions).all().map((row) => [row.id, row.sweptAt] as const),
  );
  /** Tombstones this scan invalidated, dropped together at the end. */
  const revived: string[] = [];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      scanned++;
      const path = join(dir, file);
      try {
        const stat = statSync(path);
        const id = file.replace(/\.jsonl$/, '');

        // A swept session stays swept only while its transcript has not moved
        // since. Writing to it means the user resumed it in the CLI, and a
        // session someone is using again must not stay invisible — so the
        // tombstone is dropped and the file indexed like any other. This is
        // what keeps `swept_sessions` from becoming a permanent blocklist.
        const sweptAt = tombstones.get(id);
        if (sweptAt !== undefined) {
          if (Math.floor(stat.mtimeMs) <= sweptAt) continue;
          revived.push(id);
        }

        const existing = db
          .select({ indexedMtime: sessions.indexedMtime, indexedSize: sessions.indexedSize })
          .from(sessions)
          .where(eq(sessions.id, id))
          .get();
        if (
          existing &&
          existing.indexedMtime === Math.floor(stat.mtimeMs) &&
          existing.indexedSize === stat.size
        ) continue;
        const meta = extractMeta(parseTranscript(readFileSync(path, 'utf8')));
        db.insert(sessions)
          .values({
            id,
            projectDir: basename(dir),
            cwd: meta.cwd,
            title: meta.title,
            firstAt: meta.firstAt,
            lastAt: meta.lastAt,
            messageCount: meta.messageCount,
            fileSize: stat.size,
            resolvedModel: meta.model,
            indexedMtime: Math.floor(stat.mtimeMs),
            indexedSize: stat.size,
          })
          .onConflictDoUpdate({
            target: sessions.id,
            set: {
              projectDir: basename(dir),
              cwd: meta.cwd,
              title: sql`CASE WHEN ${sessions.title} = '' THEN ${meta.title} ELSE ${sessions.title} END`,
              firstAt: meta.firstAt,
              lastAt: meta.lastAt,
              messageCount: meta.messageCount,
              fileSize: stat.size,
              // A transcript whose assistant turns haven't been written yet
              // reports null; that must not erase what the runner already
              // recorded for a live web session.
              resolvedModel: sql`COALESCE(${meta.model ?? null}, ${sessions.resolvedModel})`,
              // New activity clears a map dismissal — but only genuinely new
              // activity (lastAt advancing), not a re-parse of the same file:
              // this branch also runs for title re-derivation and the like
              // (spec 2026-09-18-tag-clusters-design § 5).
              mapDismissedAt: sql`CASE WHEN ${meta.lastAt ?? null} > COALESCE(${sessions.lastAt}, 0) THEN NULL ELSE ${sessions.mapDismissedAt} END`,
              indexedMtime: Math.floor(stat.mtimeMs),
              indexedSize: stat.size,
            },
          })
          .run();
        indexed++;
      } catch (err) {
        console.warn(`orbital: failed to index ${path}:`, err);
      }
    }
  }
  if (revived.length > 0) {
    db.delete(sweptSessions).where(inArray(sweptSessions.id, revived)).run();
  }
  if (indexed > 0) regenerateRuleTags(db);
  return { scanned, indexed };
}
