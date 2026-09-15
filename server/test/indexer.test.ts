import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';
import { indexProjects } from '../src/indexer/indexer.js';

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

describe('indexProjects', () => {
  it('indexes new transcripts and extracts meta', () => {
    const { db, projects } = setup();
    const result = indexProjects(db, projects);
    expect(result).toEqual({ scanned: 1, indexed: 1 });
    const row = db.prepare(`SELECT * FROM sessions WHERE id='aaaa-bbbb'`).get() as any;
    expect(row.cwd).toBe('/Users/tomin/Projects/slothworks/ergaily');
    expect(row.title).toBe('Fix the login bug in the auth service please');
    expect(row.message_count).toBe(3);
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
    const row = db.prepare(`SELECT message_count FROM sessions WHERE id='aaaa-bbbb'`).get() as any;
    expect(row.message_count).toBe(4);
  });
  it('returns zeros for a missing dir', () => {
    const { db } = setup();
    expect(indexProjects(db, '/nonexistent-dir-xyz')).toEqual({ scanned: 0, indexed: 0 });
  });
  it('preserves title, source, permission_mode, parent_id on re-index', () => {
    const { db, projects, transcriptPath } = setup();
    indexProjects(db, projects);
    // Manually update session with custom values
    db.prepare(
      `UPDATE sessions SET title='My renamed title', source='web', permission_mode='plan', parent_id='xyz' WHERE id='aaaa-bbbb'`,
    ).run();
    // Verify the custom values were set
    let row = db.prepare(`SELECT title, source, permission_mode, parent_id, message_count FROM sessions WHERE id='aaaa-bbbb'`).get() as any;
    expect(row.title).toBe('My renamed title');
    expect(row.source).toBe('web');
    expect(row.permission_mode).toBe('plan');
    expect(row.parent_id).toBe('xyz');
    expect(row.message_count).toBe(3);
    // Append a line and re-index
    appendFileSync(
      transcriptPath,
      '\n{"type":"user","uuid":"u9","timestamp":"2026-09-01T12:00:00.000Z","message":{"role":"user","content":"more"}}',
    );
    expect(indexProjects(db, projects)).toEqual({ scanned: 1, indexed: 1 });
    // Verify title and other fields are preserved, but message_count updated
    row = db.prepare(`SELECT title, source, permission_mode, parent_id, message_count FROM sessions WHERE id='aaaa-bbbb'`).get() as any;
    expect(row.title).toBe('My renamed title');
    expect(row.source).toBe('web');
    expect(row.permission_mode).toBe('plan');
    expect(row.parent_id).toBe('xyz');
    expect(row.message_count).toBe(4);
  });
});
