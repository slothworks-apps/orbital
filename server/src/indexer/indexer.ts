import type Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseTranscript, extractMeta } from '../transcript/parser.js';
import { regenerateRuleTags } from '../tags/rules.js';

export function indexProjects(
  db: Database.Database,
  projectsDir: string,
): { scanned: number; indexed: number } {
  let scanned = 0;
  let indexed = 0;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(projectsDir, d.name));
  } catch {
    return { scanned: 0, indexed: 0 };
  }
  const getExisting = db.prepare(
    `SELECT indexed_mtime, indexed_size, title FROM sessions WHERE id=?`,
  );
  const upsert = db.prepare(`
    INSERT INTO sessions (id, project_dir, cwd, title, first_at, last_at,
      message_count, file_size, indexed_mtime, indexed_size)
    VALUES (@id, @project_dir, @cwd, @title, @first_at, @last_at,
      @message_count, @file_size, @indexed_mtime, @indexed_size)
    ON CONFLICT(id) DO UPDATE SET
      cwd=excluded.cwd,
      title=CASE WHEN sessions.title='' THEN excluded.title ELSE sessions.title END,
      first_at=excluded.first_at, last_at=excluded.last_at,
      message_count=excluded.message_count, file_size=excluded.file_size,
      indexed_mtime=excluded.indexed_mtime, indexed_size=excluded.indexed_size
  `);
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
        const existing = getExisting.get(id) as
          | { indexed_mtime: number; indexed_size: number }
          | undefined;
        if (
          existing &&
          existing.indexed_mtime === Math.floor(stat.mtimeMs) &&
          existing.indexed_size === stat.size
        ) continue;
        const meta = extractMeta(parseTranscript(readFileSync(path, 'utf8')));
        upsert.run({
          id,
          project_dir: basename(dir),
          cwd: meta.cwd,
          title: meta.title,
          first_at: meta.firstAt,
          last_at: meta.lastAt,
          message_count: meta.messageCount,
          file_size: stat.size,
          indexed_mtime: Math.floor(stat.mtimeMs),
          indexed_size: stat.size,
        });
        indexed++;
      } catch (err) {
        console.warn(`orbital: failed to index ${path}:`, err);
      }
    }
  }
  if (indexed > 0) regenerateRuleTags(db);
  return { scanned, indexed };
}
