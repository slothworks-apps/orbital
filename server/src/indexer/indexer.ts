import { eq, inArray, sql } from 'drizzle-orm';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { OrbitalDb } from '../db/database.js';
import { sessions, sweptSessions, sessionStats } from '../db/schema.js';
import { parseTranscript, extractMeta } from '../transcript/parser.js';
import { liveBranch } from '../transcript/liveBranch.js';
import { regenerateRuleTags } from '../tags/rules.js';
import { computeStats } from '../stats/compute.js';
import { STATS_VERSION } from '../stats/constants.js';
import { readPermissionWaits, upsertSessionStats, type SessionStatsWritten } from '../stats/store.js';
import { readSubagentEntries } from '../stats/transcript.js';
import { FIRST_CLAUDE_DIR_ID } from '../claudeDirs/paths.js';

/** One transcript to consider: the project directory it sits in, and its file name. */
interface TranscriptFile {
  projectDir: string;
  file: string;
}

/**
 * Which Claude directory a pass indexes for (spec
 * 2026-10-04-multiple-claude-directories-design § 1 Id collisions). A new
 * row is written with `id`. A row another configured directory already owns
 * is left alone and reported through `onCollision`; a row whose directory is
 * no longer configured is taken over, which is how adding a removed
 * directory back brings its sessions back.
 */
export interface IndexOwner {
  id: number;
  /** Whether a directory id is configured now. Absent: every id is. */
  isConfigured?: (id: number) => boolean;
  /** A transcript skipped because `ownerId` owns its session. */
  onCollision?: (sessionId: string, ownerId: number) => void;
}

/** The owner a pass has when the caller names none — the first directory. */
const FIRST_DIRECTORY: IndexOwner = { id: FIRST_CLAUDE_DIR_ID };

/**
 * The full pass: every transcript under `projectsDir`. Run at boot, and
 * whenever the watcher cannot say which file changed.
 */
export function indexProjects(
  db: OrbitalDb,
  projectsDir: string,
  /** Told for each session whose rollup this pass rewrote — see `SessionStatsWritten`. */
  onStats?: SessionStatsWritten,
  owner: IndexOwner = FIRST_DIRECTORY,
): { scanned: number; indexed: number } {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { scanned: 0, indexed: 0 };
  }
  const files = projectDirs.flatMap((d) => transcriptsIn(projectsDir, d));
  return indexFiles(db, projectsDir, files, onStats, owner);
}

/**
 * Indexes what the watcher named, relative to `projectsDir`: a transcript
 * (`<project>/<id>.jsonl`), or a whole project directory when that is all an
 * event said. Anything deeper — subagent files, `memory/` — is not a
 * transcript and is skipped, as the full pass skips it. Each transcript costs
 * what it costs in the full pass: a stat, one SELECT, and a parse only when it
 * changed.
 */
export function indexPaths(
  db: OrbitalDb,
  projectsDir: string,
  relativePaths: Iterable<string>,
  onStats?: SessionStatsWritten,
  owner: IndexOwner = FIRST_DIRECTORY,
): { scanned: number; indexed: number } {
  const files: TranscriptFile[] = [];
  for (const rel of relativePaths) {
    const [projectDir, file, ...deeper] = rel.split('/');
    if (!projectDir || deeper.length > 0) continue;
    if (file === undefined) files.push(...transcriptsIn(projectsDir, projectDir));
    else if (file.endsWith('.jsonl')) files.push({ projectDir, file });
  }
  return indexFiles(db, projectsDir, files, onStats, owner);
}

function transcriptsIn(projectsDir: string, projectDir: string): TranscriptFile[] {
  try {
    return readdirSync(join(projectsDir, projectDir))
      .filter((f) => f.endsWith('.jsonl'))
      .map((file) => ({ projectDir, file }));
  } catch {
    return [];
  }
}

function indexFiles(
  db: OrbitalDb,
  projectsDir: string,
  files: TranscriptFile[],
  onStats: SessionStatsWritten | undefined,
  owner: IndexOwner,
): { scanned: number; indexed: number } {
  let scanned = 0;
  let indexed = 0;
  /**
   * Whether this pass changed anything `regenerateRuleTags` reads. Rules match
   * on cwd, title and permission mode; the indexer never writes the mode, so a
   * new row, a moved cwd or a first title is the whole list. Without this,
   * every append to a transcript rewrote every rule tag in the database.
   */
  let ruleInputsChanged = false;
  /** Rollups rewritten, announced once the pass has committed. */
  const statsWritten: string[] = [];
  const pass = db.$client.transaction(() => {
    /**
     * Sessions the retention sweep removed (spec
     * 2026-09-21-settings-sections-design § 4). Loaded once per pass rather
     * than queried per file: the table is small, and a full pass touches
     * every transcript on the machine.
     *
     * Without this, retention would not work at all — the loop below inserts
     * every `.jsonl` the database lacks, so a swept session whose transcript
     * is still on disk would be back within one pass.
     */
    const tombstones = new Map(
      db.select().from(sweptSessions).all().map((row) => [row.id, row.sweptAt] as const),
    );
    /** Tombstones this pass invalidated, dropped together at the end. */
    const revived: string[] = [];
    for (const { projectDir, file } of files) {
      scanned++;
      const path = join(projectsDir, projectDir, file);
      try {
        let stat;
        try {
          stat = statSync(path);
        } catch (err) {
          // A watcher event can name a file that is already gone again.
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
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
          .select({
            cwd: sessions.cwd,
            title: sessions.title,
            indexedMtime: sessions.indexedMtime,
            indexedSize: sessions.indexedSize,
            statsVersion: sessionStats.statsVersion,
            claudeDirId: sessions.claudeDirId,
          })
          .from(sessions)
          .leftJoin(sessionStats, eq(sessionStats.sessionId, sessions.id))
          .where(eq(sessions.id, id))
          .get();
        // The id is the only key, so a transcript another directory already
        // owns is a copy and is skipped (adr
        // a-session-belongs-to-the-first-directory-that-indexed-it). An owner
        // that is no longer configured has no say: this directory takes the
        // row over, and the pass below rewrites it from this transcript.
        let adopted = false;
        if (existing && existing.claudeDirId !== owner.id) {
          if (owner.isConfigured?.(existing.claudeDirId) ?? true) {
            owner.onCollision?.(id, existing.claudeDirId);
            continue;
          }
          db.update(sessions).set({ claudeDirId: owner.id }).where(eq(sessions.id, id)).run();
          adopted = true;
        }
        // A stale (or missing) statsVersion re-indexes a file that has not
        // otherwise changed: that is how a definition change reaches history.
        if (
          existing &&
          !adopted &&
          existing.indexedMtime === Math.floor(stat.mtimeMs) &&
          existing.indexedSize === stat.size &&
          existing.statsVersion === STATS_VERSION
        ) continue;
        const entries = parseTranscript(readFileSync(path, 'utf8'));
        // The title, the count and the timestamps come off the live branch
        // (spec 2026-09-29-rewind-design); stats take every entry and split
        // it themselves, since a dead branch was still billed.
        const meta = extractMeta(liveBranch(entries));
        // Sidechains live in their own files beside this one, so stats read
        // both; `extractMeta` above stays on the session's own entries. A
        // permission wait needs no trigger of its own: it is recorded before
        // its tool runs, so the line that closes the tool re-indexes it here.
        const { rollup } = computeStats([...entries, ...readSubagentEntries(path)], readPermissionWaits(db, id));
        if (
          !existing ||
          existing.cwd !== meta.cwd ||
          (existing.title === '' && meta.title !== '')
        ) ruleInputsChanged = true;
        db.insert(sessions)
          .values({
            id,
            projectDir,
            cwd: meta.cwd,
            title: meta.title,
            firstAt: meta.firstAt,
            lastAt: meta.lastAt,
            messageCount: meta.messageCount,
            fileSize: stat.size,
            resolvedModel: meta.model,
            indexedMtime: Math.floor(stat.mtimeMs),
            indexedSize: stat.size,
            // Only on insert: the update below never names it.
            claudeDirId: owner.id,
          })
          .onConflictDoUpdate({
            target: sessions.id,
            set: {
              projectDir,
              cwd: meta.cwd,
              // Only a blank title is filled in. Whatever extractMeta derived —
              // a bare "/clear" included, when a transcript holds nothing else
              // — is kept as is on every later pass; the one-off cleanup of
              // stale titles is migration 0013, not something this loop redoes.
              title: sql`CASE WHEN ${sessions.title} = '' THEN ${meta.title} ELSE ${sessions.title} END`,
              firstAt: meta.firstAt,
              lastAt: meta.lastAt,
              messageCount: meta.messageCount,
              fileSize: stat.size,
              // A transcript whose assistant turns haven't been written yet
              // reports null; that must not erase what the runner already
              // recorded for a live web session.
              resolvedModel: sql`COALESCE(${meta.model ?? null}, ${sessions.resolvedModel})`,
              indexedMtime: Math.floor(stat.mtimeMs),
              indexedSize: stat.size,
            },
          })
          .run();
        upsertSessionStats(db, id, rollup, (sessionId) => statsWritten.push(sessionId));
        indexed++;
      } catch (err) {
        console.warn(`orbital: failed to index ${path}:`, err);
      }
    }
    if (revived.length > 0) {
      db.delete(sweptSessions).where(inArray(sweptSessions.id, revived)).run();
    }
    if (ruleInputsChanged) regenerateRuleTags(db);
  });
  // One transaction per pass: a full pass writes hundreds of rows, and one
  // commit instead of one per statement is most of what it costs to write
  // them. better-sqlite3's own transaction, because every write here goes
  // through `db` — including `regenerateRuleTags`, whose nested transaction
  // becomes a savepoint inside this one.
  pass();
  if (onStats) for (const id of statsWritten) onStats(id);
  return { scanned, indexed };
}
