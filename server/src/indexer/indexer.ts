import { eq, sql } from 'drizzle-orm';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { OrbitalDb } from '../db/database.js';
import { sessions } from '../db/schema.js';
import { parseTranscript, extractMeta } from '../transcript/parser.js';
import { regenerateRuleTags } from '../tags/rules.js';

export function indexProjects(
  db: OrbitalDb,
  projectsDir: string,
): { scanned: number; indexed: number } {
  let scanned = 0;
  let indexed = 0;
  // Titles indexed before cleanTitle existed may still be CLI wrapper noise
  // (<local-command-caveat>…, <command-message>…). Blank them and drop the
  // mtime short-circuit so those transcripts re-derive a clean title below.
  db.update(sessions)
    .set({ title: '', indexedMtime: 0 })
    .where(sql`${sessions.title} LIKE '<local-command-%' OR ${sessions.title} LIKE '<command-%' OR ${sessions.title} LIKE '<system-reminder%'`)
    .run();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(projectsDir, d.name));
  } catch {
    return { scanned: 0, indexed: 0 };
  }
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
  if (indexed > 0) regenerateRuleTags(db);
  return { scanned, indexed };
}
