import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';
import { sessions, sessionColumns } from '../src/db/schema.js';
import { indexProjects } from '../src/indexer/indexer.js';
import type { SessionRow } from '../src/types.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-idx-'));
  const projects = join(dir, 'projects');
  const pdir = join(projects, '-Users-tomin-Projects-slothworks-ergaily');
  mkdirSync(pdir, { recursive: true });
  const fixture = readFileSync(
    join(import.meta.dirname, 'fixtures/transcript-basic.jsonl'), 'utf8',
  );
  writeFileSync(join(pdir, 'aaaa-bbbb.jsonl'), fixture);
  const db = openDb(join(dir, 'index.db'));
  return { db, projects, transcriptPath: join(pdir, 'aaaa-bbbb.jsonl') };
}

/** A fresh temp projects dir/db pair, without the fixed transcript-basic.jsonl fixture. */
function setupEmpty() {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-idx-'));
  const projects = join(dir, 'projects');
  mkdirSync(projects, { recursive: true });
  const db = openDb(join(dir, 'index.db'));
  return { db, projects };
}

/** Writes a JSONL transcript for one session into a project dir under `projects`. */
function writeTranscriptFile(
  projects: string,
  projectDir: string,
  sessionId: string,
  entries: unknown[],
) {
  const pdir = join(projects, projectDir);
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, `${sessionId}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n'));
}

describe('indexProjects', () => {
  it('indexes new transcripts and extracts meta', () => {
    const { db, projects } = setup();
    const result = indexProjects(db, projects);
    expect(result).toEqual({ scanned: 1, indexed: 1 });
    const row = db.select().from(sessions).where(eq(sessions.id, 'aaaa-bbbb')).get()!;
    expect(row.cwd).toBe('/Users/tomin/Projects/slothworks/ergaily');
    expect(row.title).toBe('Fix the login bug in the auth service please');
    expect(row.messageCount).toBe(3);
  });
  it('is incremental: unchanged files are skipped, changed files re-indexed', () => {
    const { db, projects, transcriptPath } = setup();
    indexProjects(db, projects);
    expect(indexProjects(db, projects)).toEqual({ scanned: 1, indexed: 0 });
    appendFileSync(
      transcriptPath,
      '\n{"type":"user","uuid":"u9","timestamp":"2026-09-01T12:00:00.000Z","message":{"role":"user","content":"more"}}',
    );
    expect(indexProjects(db, projects)).toEqual({ scanned: 1, indexed: 1 });
    const row = db
      .select({ messageCount: sessions.messageCount })
      .from(sessions)
      .where(eq(sessions.id, 'aaaa-bbbb'))
      .get()!;
    expect(row.messageCount).toBe(4);
  });
  it('re-derives titles stranded on a bare slash command, but leaves ones with arguments', () => {
    const { db, projects } = setup();
    indexProjects(db, projects);

    // A row indexed before extractMeta learned to skip "/clear".
    db.update(sessions).set({ title: '/clear' }).where(eq(sessions.id, 'aaaa-bbbb')).run();
    indexProjects(db, projects);
    expect(
      db.select({ title: sessions.title }).from(sessions).where(eq(sessions.id, 'aaaa-bbbb')).get()!
        .title,
    ).toBe('Fix the login bug in the auth service please');

    // A command with arguments is a real title and survives untouched.
    db.update(sessions)
      .set({ title: '/clickup-branch CU-8180' })
      .where(eq(sessions.id, 'aaaa-bbbb'))
      .run();
    indexProjects(db, projects);
    expect(
      db.select({ title: sessions.title }).from(sessions).where(eq(sessions.id, 'aaaa-bbbb')).get()!
        .title,
    ).toBe('/clickup-branch CU-8180');
  });
  it('returns zeros for a missing dir', () => {
    const { db } = setup();
    expect(indexProjects(db, '/nonexistent-dir-xyz')).toEqual({ scanned: 0, indexed: 0 });
  });
  it('preserves title, source, permission_mode, parent_id on re-index; backfills project_dir for web sessions', () => {
    const { db, projects, transcriptPath } = setup();
    // Simulate a web session row created (by POST /api/sessions) before its
    // transcript was ever indexed: project_dir starts out empty.
    db.insert(sessions)
      .values({ id: 'aaaa-bbbb', projectDir: '', cwd: '/some/cwd', source: 'web' })
      .run();
    indexProjects(db, projects);
    let backfilled = db
      .select({ projectDir: sessions.projectDir, source: sessions.source })
      .from(sessions)
      .where(eq(sessions.id, 'aaaa-bbbb'))
      .get()!;
    expect(backfilled.projectDir).toBe('-Users-tomin-Projects-slothworks-ergaily');
    expect(backfilled.source).toBe('web');
    // Manually update session with custom values
    db.update(sessions)
      .set({ title: 'My renamed title', source: 'web', permissionMode: 'plan', parentId: 'xyz' })
      .where(eq(sessions.id, 'aaaa-bbbb'))
      .run();
    // Verify the custom values were set
    let row = db.select().from(sessions).where(eq(sessions.id, 'aaaa-bbbb')).get()!;
    expect(row.title).toBe('My renamed title');
    expect(row.source).toBe('web');
    expect(row.permissionMode).toBe('plan');
    expect(row.parentId).toBe('xyz');
    expect(row.messageCount).toBe(3);
    // Append a line and re-index
    appendFileSync(
      transcriptPath,
      '\n{"type":"user","uuid":"u9","timestamp":"2026-09-01T12:00:00.000Z","message":{"role":"user","content":"more"}}',
    );
    expect(indexProjects(db, projects)).toEqual({ scanned: 1, indexed: 1 });
    // Verify title and other fields are preserved, but message_count updated
    row = db.select().from(sessions).where(eq(sessions.id, 'aaaa-bbbb')).get()!;
    expect(row.title).toBe('My renamed title');
    expect(row.source).toBe('web');
    expect(row.permissionMode).toBe('plan');
    expect(row.parentId).toBe('xyz');
    expect(row.messageCount).toBe(4);
    expect(row.projectDir).toBe('-Users-tomin-Projects-slothworks-ergaily');
  });
});

describe('resolved_model', () => {
  it('writes the transcript model into resolved_model', () => {
    const { db, projects } = setupEmpty();
    writeTranscriptFile(projects, 'proj', 'sess-model', [
      { type: 'user', timestamp: '2026-09-16T10:00:00Z', cwd: '/w/x', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', timestamp: '2026-09-16T10:00:01Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }] } },
    ]);
    indexProjects(db, projects);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'sess-model')).get() as SessionRow;
    expect(row.resolved_model).toBe('claude-opus-5');
  });

  it('does not erase a known resolved_model when the transcript has no assistant entry', () => {
    const { db, projects } = setupEmpty();
    writeTranscriptFile(projects, 'proj', 'sess-empty', [
      { type: 'user', timestamp: '2026-09-16T10:00:00Z', cwd: '/w/x', message: { role: 'user', content: 'hi' } },
    ]);
    db.insert(sessions)
      .values({ id: 'sess-empty', projectDir: 'proj', cwd: '/w/x', resolvedModel: 'claude-sonnet-5' })
      .onConflictDoUpdate({ target: sessions.id, set: { resolvedModel: 'claude-sonnet-5' } })
      .run();
    indexProjects(db, projects);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'sess-empty')).get() as SessionRow;
    expect(row.resolved_model).toBe('claude-sonnet-5');
  });
});
