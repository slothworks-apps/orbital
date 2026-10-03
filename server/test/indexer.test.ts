import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { cpSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MIGRATIONS_FOLDER, openDb } from '../src/db/database.js';
import { sessions, sessionColumns, sessionTags, sweptSessions, sessionStats, tagRules, tags } from '../src/db/schema.js';
import { indexPaths, indexProjects } from '../src/indexer/indexer.js';
import { retentionCutoff, sweepSessions } from '../src/retention.js';
import { STATS_VERSION, CHARS_PER_TOKEN, OBESE_RESULT_TOKENS } from '../src/stats/constants.js';
import type { SessionRow } from '../src/types.js';
import { makeTmpDir } from './tmp.js';

function setup() {
  const dir = makeTmpDir('idx');
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
  const dir = makeTmpDir('idx');
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

/**
 * Writes one subagent transcript where the current CLI puts it — beside the
 * session file, under `<session-id>/subagents/` (docs/domains/
 * subagents-in-transcripts.md).
 */
function writeSubagentFile(
  projects: string,
  projectDir: string,
  sessionId: string,
  agentId: string,
  entries: unknown[],
) {
  const dir = join(projects, projectDir, sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `agent-${agentId}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join('\n'),
  );
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
  // The pass used to blank bare-command titles at its top, while extractMeta
  // still falls back to one when a transcript has nothing else: every pass
  // re-parsed those sessions and titled them "/clear" again, forever.
  it('does not re-parse a session whose only prompt is a bare command', () => {
    const { db, projects } = setupEmpty();
    writeTranscriptFile(projects, 'proj', 'sess-clear', [
      { type: 'user', timestamp: '2026-09-16T10:00:00Z', cwd: '/w/x', message: { role: 'user', content: '/clear' } },
    ]);
    expect(indexProjects(db, projects)).toEqual({ scanned: 1, indexed: 1 });
    expect(
      db.select({ title: sessions.title }).from(sessions).where(eq(sessions.id, 'sess-clear')).get()!
        .title,
    ).toBe('/clear');
    expect(indexProjects(db, projects)).toEqual({ scanned: 1, indexed: 0 });
  });
});

// The one-off title cleanup that used to open every pass (migration 0013).
describe('stranded titles migration', () => {
  /** A database migrated up to, but not including, 0013 — then the rest. */
  function migrateAcross(dirtyTitle: string) {
    const dir = makeTmpDir('idx-mig');
    const projects = join(dir, 'projects');
    mkdirSync(join(projects, 'proj'), { recursive: true });
    writeFileSync(
      join(projects, 'proj', 'aaaa-bbbb.jsonl'),
      readFileSync(join(import.meta.dirname, 'fixtures/transcript-basic.jsonl'), 'utf8'),
    );
    const before = join(dir, 'drizzle-before');
    cpSync(DEFAULT_MIGRATIONS_FOLDER, before, { recursive: true });
    const journalPath = join(before, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    // Everything from 0013 on: Drizzle skips a migration older than the newest applied.
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag.endsWith('_reset_stranded_titles')));
    writeFileSync(journalPath, JSON.stringify(journal));

    const dbPath = join(dir, 'index.db');
    const old = openDb(dbPath, before);
    // Raw SQL, not `indexProjects`: today's indexer writes today's columns,
    // which a database this old does not have yet. The row stands for one
    // indexed back then — stamped with the file's own mtime and size, so only
    // the migration's reset can make the next pass look at it again.
    const stat = statSync(join(projects, 'proj', 'aaaa-bbbb.jsonl'));
    old.$client
      .prepare(
        `INSERT INTO sessions (id, project_dir, title, indexed_mtime, indexed_size)
         VALUES ('aaaa-bbbb', 'proj', ?, ?, ?)`,
      )
      .run(dirtyTitle, Math.floor(stat.mtimeMs), stat.size);
    old.$client.close();

    const db = openDb(dbPath);
    indexProjects(db, projects);
    return db.select({ title: sessions.title }).from(sessions).where(eq(sessions.id, 'aaaa-bbbb')).get()!
      .title;
  }

  it('re-derives a title stranded on a bare slash command', () => {
    expect(migrateAcross('/clear')).toBe('Fix the login bug in the auth service please');
  });
  it('re-derives a title that was a skill body from an isMeta entry', () => {
    expect(migrateAcross('Base directory for this skill: /Users/x/.claude/skills/ask')).toBe(
      'Fix the login bug in the auth service please',
    );
  });
  it('leaves a command with arguments alone: it is a real title', () => {
    expect(migrateAcross('/clickup-branch CU-8180')).toBe('/clickup-branch CU-8180');
  });
});

describe('indexProjects', () => {
  it('returns zeros for a missing dir', () => {
    const { db } = setup();
    expect(indexProjects(db, '/nonexistent-dir-xyz')).toEqual({ scanned: 0, indexed: 0 });
  });
  it('preserves title, source, permission_mode, ended_at on re-index; backfills project_dir for web sessions', () => {
    const { db, projects, transcriptPath } = setup();
    // Simulate a web session row created (by POST /api/sessions) before its
    // transcript was ever indexed: project_dir starts out empty.
    db.insert(sessions)
      .values({ id: 'aaaa-bbbb', projectDir: '', cwd: '/some/cwd', source: 'web' })
      .run();
    indexProjects(db, projects);
    const backfilled = db
      .select({ projectDir: sessions.projectDir, source: sessions.source })
      .from(sessions)
      .where(eq(sessions.id, 'aaaa-bbbb'))
      .get()!;
    expect(backfilled.projectDir).toBe('-Users-tomin-Projects-slothworks-ergaily');
    expect(backfilled.source).toBe('web');
    // Manually update session with custom values
    db.update(sessions)
      .set({ title: 'My renamed title', source: 'web', permissionMode: 'plan', endedAt: 123 })
      .where(eq(sessions.id, 'aaaa-bbbb'))
      .run();
    // Verify the custom values were set
    let row = db.select().from(sessions).where(eq(sessions.id, 'aaaa-bbbb')).get()!;
    expect(row.title).toBe('My renamed title');
    expect(row.source).toBe('web');
    expect(row.permissionMode).toBe('plan');
    expect(row.endedAt).toBe(123);
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
    expect(row.endedAt).toBe(123);
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

// ---------------------------------------------------------------------------
// Retention tombstones (spec 2026-09-21-settings-sections-design § 4)
// ---------------------------------------------------------------------------

describe('indexProjects and swept sessions', () => {
  /**
   * The whole reason `swept_sessions` exists. Deleting the row is not enough:
   * this loop inserts every transcript the database lacks, so without a
   * tombstone a swept session is back after one scan.
   */
  it('does not re-index a session the sweep removed', () => {
    const { db, projects } = setup();
    expect(indexProjects(db, projects).indexed).toBe(1);

    const cutoff = retentionCutoff(30, Date.now());
    // Age it past the cutoff so the sweep is entitled to take it.
    db.update(sessions).set({ lastAt: Date.now() - 100 * 86_400_000 }).run();
    expect(sweepSessions(db, cutoff, Date.now())).toEqual(['aaaa-bbbb']);
    expect(db.select().from(sessions).all()).toHaveLength(0);

    indexProjects(db, projects);
    expect(db.select().from(sessions).all()).toHaveLength(0);
  });

  /**
   * And the reason the tombstone is dated rather than a bare flag. Appending
   * to the transcript is what resuming the session in the CLI looks like from
   * here, and a session someone is using again must not stay invisible.
   */
  it('brings it back once its transcript is written to again', () => {
    const { db, projects, transcriptPath } = setup();
    indexProjects(db, projects);
    db.update(sessions).set({ lastAt: Date.now() - 100 * 86_400_000 }).run();

    // Both stamps are set explicitly rather than taken from the clock: the
    // whole rule is an mtime-versus-sweptAt comparison, and letting two
    // `Date.now()` calls land in the same millisecond would make this test
    // flaky about the one thing it exists to pin down.
    const sweptAt = Date.now();
    sweepSessions(db, retentionCutoff(30, sweptAt), sweptAt);

    // Untouched since the sweep: stays gone.
    utimesSync(transcriptPath, new Date(sweptAt - 5_000), new Date(sweptAt - 5_000));
    indexProjects(db, projects);
    expect(db.select().from(sessions).all()).toHaveLength(0);
    expect(db.select().from(sweptSessions).all()).toHaveLength(1);

    // The CLI resumes it: the file is written to, so its mtime passes the
    // sweep's stamp and the session is someone's again.
    appendFileSync(transcriptPath, '\n');
    utimesSync(transcriptPath, new Date(sweptAt + 5_000), new Date(sweptAt + 5_000));
    indexProjects(db, projects);

    expect(db.select().from(sessions).all()).toHaveLength(1);
    // And the tombstone is gone, so the next scan does not have to re-decide.
    expect(db.select().from(sweptSessions).all()).toHaveLength(0);
  });

  it('leaves tombstones for transcripts it did not see alone', () => {
    const { db, projects } = setupEmpty();
    db.insert(sweptSessions).values({ id: 'gone', sweptAt: 1 }).run();
    indexProjects(db, projects);
    expect(db.select().from(sweptSessions).all()).toHaveLength(1);
  });
});

// Session stats (spec 2026-09-20-session-stats-design § Data model): the same
// pass that extracts meta rolls the transcript up into `session_stats`.
describe('indexProjects and session_stats', () => {
  const USAGE = {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 },
    output_tokens_details: { thinking_tokens: 5 },
  };

  /** One turn: a prompt, an assistant turn that calls Bash, and the result 2s later. */
  function oneTurnSession(projects: string) {
    writeTranscriptFile(projects, 'proj', 'sess-stats', [
      { type: 'user', uuid: 'u1', timestamp: '2026-09-20T10:00:00.000Z', cwd: '/w/x', message: { role: 'user', content: 'go' } },
      {
        type: 'assistant', uuid: 'a1', timestamp: '2026-09-20T10:00:05.000Z', requestId: 'r1',
        message: {
          role: 'assistant', model: 'claude-opus-5', usage: USAGE,
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }],
        },
      },
      {
        type: 'user', uuid: 'u2', timestamp: '2026-09-20T10:00:07.000Z',
        toolUseResult: '3 passing',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
      },
    ]);
  }

  const statsRow = (db: ReturnType<typeof openDb>, id: string) =>
    db.select().from(sessionStats).where(eq(sessionStats.sessionId, id)).get();

  it('rolls a changed transcript up into a session_stats row', () => {
    const { db, projects } = setupEmpty();
    oneTurnSession(projects);
    indexProjects(db, projects);

    const row = statsRow(db, 'sess-stats')!;
    expect(row.turns).toBe(1);
    expect(row.apiMs).toBe(5000);
    expect(row.localToolMs).toBe(2000);
    expect(row.mcpMs).toBe(0);
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(20);
    expect(row.cacheReadTokens).toBe(50);
    expect(row.cacheCreationTokens).toBe(10);
    expect(row.cacheCreation5mTokens).toBe(10);
    expect(row.cacheCreation1hTokens).toBe(0);
    expect(row.thinkingTokens).toBe(5);
    expect(row.toolCalls).toBe(1);
    expect(row.toolErrors).toBe(0);
    expect(row.statsVersion).toBe(STATS_VERSION);
  });

  it('counts the subagent files beside the transcript, not just the transcript', () => {
    const { db, projects } = setupEmpty();
    oneTurnSession(projects);
    writeSubagentFile(projects, 'proj', 'sess-stats', 'aaa', [
      {
        type: 'assistant', uuid: 's1', timestamp: '2026-09-20T10:00:06.000Z', requestId: 'sr1',
        isSidechain: true,
        message: {
          role: 'assistant', model: 'claude-haiku-5',
          usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ]);
    indexProjects(db, projects);

    const row = statsRow(db, 'sess-stats')!;
    expect(row.subagentTokens).toBe(13);
    expect(row.subagentUsage).toEqual({
      'claude-haiku-5': {
        input: 7, output: 3, cacheRead: 2, cacheCreation: 1, cacheCreation5m: 0, cacheCreation1h: 0,
      },
    });
    // The sidechain entries stay out of the parent's own lanes and counts.
    expect(row.turns).toBe(1);
    expect(row.inputTokens).toBe(100);
  });

  it('round-trips toolBreakdown and findings through their JSON columns', () => {
    const { db, projects } = setupEmpty();
    const fat = 'x'.repeat(OBESE_RESULT_TOKENS * CHARS_PER_TOKEN);
    writeTranscriptFile(projects, 'proj', 'sess-json', [
      { type: 'user', uuid: 'u1', timestamp: '2026-09-20T10:00:00.000Z', cwd: '/w/x', message: { role: 'user', content: 'go' } },
      {
        type: 'assistant', uuid: 'a1', timestamp: '2026-09-20T10:00:01.000Z', requestId: 'r1',
        message: {
          role: 'assistant', model: 'claude-opus-5', usage: USAGE,
          content: [{ type: 'tool_use', id: 't1', name: 'mcp__docs__search', input: { q: 'x' } }],
        },
      },
      {
        type: 'user', uuid: 'u2', timestamp: '2026-09-20T10:00:02.000Z',
        toolUseResult: fat,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
      },
    ]);
    indexProjects(db, projects);

    const row = statsRow(db, 'sess-json')!;
    expect(row.mcpMs).toBe(1000);
    expect(row.toolBreakdown['mcp__docs__search']).toMatchObject({
      calls: 1, errors: 0, ms: 1000, resultChars: fat.length,
    });
    expect(row.toolBreakdown['mcp__docs__search'].buckets).toBeInstanceOf(Array);
    expect(row.findings).toEqual([
      {
        rule: 'obese-tool-result',
        evidence: {
          tool: 'mcp__docs__search',
          chars: fat.length,
          estimatedTokens: OBESE_RESULT_TOKENS,
          toolUseId: 't1',
          turnUuid: 'a1',
        },
      },
    ]);
  });

  it('recomputes an unchanged transcript when the stored statsVersion is stale', () => {
    const { db, projects } = setupEmpty();
    oneTurnSession(projects);
    indexProjects(db, projects);
    expect(indexProjects(db, projects)).toEqual({ scanned: 1, indexed: 0 });

    // What a definition change looks like to an already-indexed session.
    db.update(sessionStats)
      .set({ statsVersion: STATS_VERSION - 1, turns: 0 })
      .where(eq(sessionStats.sessionId, 'sess-stats'))
      .run();
    expect(indexProjects(db, projects)).toEqual({ scanned: 1, indexed: 1 });

    const row = statsRow(db, 'sess-stats')!;
    expect(row.statsVersion).toBe(STATS_VERSION);
    expect(row.turns).toBe(1);
  });

  // The third of the three write paths that announce themselves (ADR
  // `the-stats-row-reads-when-the-stats-are-written`); a pass that re-indexes
  // nothing has nothing to announce.
  it('announces each session whose rollup the pass rewrote', () => {
    const { db, projects } = setupEmpty();
    oneTurnSession(projects);
    const onStats = vi.fn();

    indexProjects(db, projects, onStats);
    expect(onStats).toHaveBeenCalledExactlyOnceWith('sess-stats');

    onStats.mockClear();
    indexProjects(db, projects, onStats);
    expect(onStats).not.toHaveBeenCalled();
  });
});

// A watcher event names a path, and only that path is indexed (audit
// resource-usage-pass-2026-09-24, finding 2).
describe('indexPaths', () => {
  const userTurn = (cwd: string, content: string) => ({
    type: 'user', timestamp: '2026-09-16T10:00:00Z', cwd, message: { role: 'user', content },
  });
  const ids = (db: ReturnType<typeof openDb>) =>
    db.select({ id: sessions.id }).from(sessions).all().map((r) => r.id).sort();

  it('indexes the named transcript and nothing else', () => {
    const { db, projects } = setupEmpty();
    writeTranscriptFile(projects, 'proj', 'one', [userTurn('/w/x', 'first')]);
    writeTranscriptFile(projects, 'proj', 'two', [userTurn('/w/x', 'second')]);
    expect(indexPaths(db, projects, ['proj/one.jsonl'])).toEqual({ scanned: 1, indexed: 1 });
    expect(ids(db)).toEqual(['one']);
  });

  it('indexes every transcript of a project directory the event named alone', () => {
    const { db, projects } = setupEmpty();
    writeTranscriptFile(projects, 'proj', 'one', [userTurn('/w/x', 'first')]);
    writeTranscriptFile(projects, 'proj', 'two', [userTurn('/w/x', 'second')]);
    writeTranscriptFile(projects, 'other', 'three', [userTurn('/w/y', 'third')]);
    indexPaths(db, projects, ['proj']);
    expect(ids(db)).toEqual(['one', 'two']);
  });

  it('skips paths that are not a session transcript, and files already gone', () => {
    const { db, projects } = setupEmpty();
    writeTranscriptFile(projects, 'proj', 'one', [userTurn('/w/x', 'first')]);
    writeSubagentFile(projects, 'proj', 'one', 'aaa', [userTurn('/w/x', 'sub')]);
    mkdirSync(join(projects, 'proj', 'memory'), { recursive: true });
    writeFileSync(join(projects, 'proj', 'memory', 'MEMORY.md'), '# memory');
    const result = indexPaths(db, projects, [
      'proj/one/subagents/agent-aaa.jsonl',
      'proj/memory/MEMORY.md',
      'proj/sessions-index.json',
      'proj/deleted.jsonl',
    ]);
    expect(result).toEqual({ scanned: 1, indexed: 0 });
    expect(ids(db)).toEqual([]);
  });

  it('gives a session its rule tag when it is first indexed', () => {
    const { db, projects } = setupEmpty();
    db.insert(tags).values({ id: 10, name: 'work', hue: 210 }).run();
    db.insert(tagRules)
      .values({ tagId: 10, position: 0, enabled: 1, condition: 'path_matches', pattern: '^/w/x$' })
      .run();
    writeTranscriptFile(projects, 'proj', 'one', [userTurn('/w/x', 'first')]);
    indexPaths(db, projects, ['proj/one.jsonl']);
    expect(
      db.select().from(sessionTags).where(eq(sessionTags.sessionId, 'one')).all(),
    ).toEqual([{ sessionId: 'one', tagId: 10, origin: 'rule' }]);
  });
});
