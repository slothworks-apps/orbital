import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FILE_PREVIEW_MAX_BYTES } from '../src/files/preview.js';
import { FILE_COMPLETE_MAX } from '../src/files/complete.js';
import { ATTACHMENT_MAX_BYTES } from '../src/api/routes.js';
import { openDb, type OrbitalDb } from '../src/db/database.js';
import {
  countSweepable,
  parseRetentionDays,
  retentionCutoff,
  sweepSessions,
  RETENTION_KEY,
} from '../src/retention.js';
import {
  pendingRewinds, sessionColumns, sessions, sessionStats, sessionTags, settings as settingsTable, tags,
} from '../src/db/schema.js';
import type { Finding } from '../src/stats/compute.js';
import { HIST_BUCKET_COUNT } from '../src/stats/constants.js';
import { recordPermissionWait } from '../src/stats/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { McpConfig } from '../src/mcp/config.js';
import { buildServer, publishLiveSession, republishCwds } from '../src/index.js';
import { Hub } from '../src/api/hub.js';
import { GitStore } from '../src/git/store.js';
import { BranchStatusStore } from '../src/git/branchStatusStore.js';
import { IdeStore } from '../src/ide/store.js';
import { Runner } from '../src/runner/runner.js';
import { resolveClaudeCodeVersion } from '../src/runner/version.js';
import type { SessionRow, SessionStatus } from '../src/types.js';
import { SubagentStore, SubagentTranscripts } from '../src/transcript/subagents.js';
import { BackgroundTaskStore } from '../src/transcript/backgroundTasks.js';
import { createImageStore } from '../src/images/store.js';
import { ErrorLog } from '../src/errors/log.js';
import { Narrator, type NarrateQueryFn } from '../src/walkthrough/narrator.js';
import { SESSION_TIPS, composeAppendix } from '../src/runner/sessionInstructions.js';

/**
 * The narrate query when a test does not script one: it fails, which no
 * test that leaves it in place ever reaches.
 */
const noNarrateQuery: NarrateQueryFn = () => { throw new Error('no narrate query in this test'); };

/**
 * The retitle route's one dependency. No test in this file asks it to name
 * anything — `autoTitleEndToEnd.test.ts` drives it against a real titler with
 * a fake model behind it.
 */
const stubTitler = () =>
  ({ retitleNow: async () => ({ title: '', changed: false }) }) as any;

/**
 * One git store for the whole suite. These tests use invented cwds like
 * `/w/x`, so every lookup resolves to "no repository" and the cache makes
 * that free; watching is off so no watch handle outlives a test.
 */
const gitStore = new GitStore({ watch: false });

/**
 * One IDE store for the whole suite, never started: no lock is read, nothing
 * connects, and `locate` answers null for every cwd — which is the state of
 * every machine with no editor running, and what these tests are about.
 * `ideStore.test.ts` drives a started one against locks it writes itself.
 */
const ideStore = new IdeStore({ claudeDir: '/nonexistent', watch: false });

/**
 * One branch status store for the suite, both settings off: it reads nothing,
 * and every session shapes without a `branch` key. The branch status routes'
 * own tests build one with injected readers.
 */
const branchStatusStore = new BranchStatusStore({ git: gitStore, settings: { get: () => '' } });

/**
 * MCP config with no CLI and no config file: nothing here touches it, and
 * nothing may reach the real `~/.claude.json`. `mcpRoutes.test.ts` drives
 * the MCP routes against an injected one.
 */
const noMcp = new McpConfig({ cliPath: null, claudeJsonPath: '/nonexistent/.claude.json' });

/**
 * A real retention context wired to the test's own database, so the route
 * tests exercise the sweep and its preview rather than a stub that could
 * agree with a broken implementation.
 */
function retentionFor(db: OrbitalDb) {
  const stored = () =>
    db.select({ value: settingsTable.value }).from(settingsTable)
      .where(eq(settingsTable.key, RETENTION_KEY)).get()?.value ?? '';
  return {
    sweep: () => {
      const now = Date.now();
      return sweepSessions(db, retentionCutoff(parseRetentionDays(stored()), now), now);
    },
    preview: (value: string) =>
      countSweepable(db, retentionCutoff(parseRetentionDays(value), Date.now())),
  };
}

function makeApp(opts: { projectsDir?: string; ide?: IdeStore; narrateQueryFn?: NarrateQueryFn; branchStatus?: BranchStatusStore } = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'orbital-api-')), 'index.db'));
  db.insert(tags).values({ id: 10, name: 'work', hue: 210 }).run();
  db.insert(sessions)
    .values([
      {
        id: 's1', projectDir: 'p', cwd: '/w/x', title: 'auth fix', lastAt: 200,
        source: 'terminal', permissionMode: 'acceptEdits',
      },
      {
        id: 's2', projectDir: 'p', cwd: '/w/y', title: 'recipe', lastAt: 100,
        source: 'terminal', permissionMode: null,
      },
    ])
    .run();
  db.insert(sessionTags).values({ sessionId: 's1', tagId: 10, origin: 'manual' }).run();
  const registry = {
    get: (id: string) => (id === 's1' ? { sessionId: 's1', status: 'working' } : undefined),
    all: () => [{ sessionId: 's1', status: 'working' }],
  };
  const startCalls: any[] = [];
  const sendCalls: any[] = [];
  const runner = {
    // Idle by default; the walkthrough tests reassign it to a mid-turn status.
    status: (_id: string): SessionStatus | undefined => undefined, active: () => [],
    // Nothing is out working for any of these by default — see
    // `Runner.awaitingSubagents`.
    awaitingSubagents: (_id: string) => false,
    compacting: (_id: string) => null,
    lastCompacted: (_id: string) => null,
    start: async (body: any) => { startCalls.push(body); return 'web-9'; },
    send: (id: string, text: string, attachments?: string[]): void => {
      sendCalls.push({ id, text, attachments });
      throw new Error(`session ${id} is not active`);
    },
    // No live query by default — the fs catalog alone, which is what an ended
    // session and the dialog get. Tests that want the SDK half replace this.
    commands: async (): Promise<any[] | null> => null,
    // Nothing parked on a question by default — the state of every session
    // that is not waiting on one. Tests that want a decision replace both.
    pendingDecision: (_id: string): any => null,
    answerDecision: (_id: string, _decisionId: string, _answers: Record<string, string>) => false,
    interrupt: async () => {}, stop: async () => {}, hasRun: (_id: string) => false,
  };
  const hub = new Hub();
  const modelCatalog = {
    list: async () => [
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', shortVersion: 'Sonnet 5', variant: null, blurb: 'Efficient', contextWindow: 200_000 },
    ],
    recordContextWindows: () => {},
    learnedContextWindows: () => ({ 'claude-fable-5': 1_000_000 }),
    validate: vi.fn(async (model: string) => ({
      ok: true, model, resolvedModel: model, contextWindow: 200_000,
    })),
  };
  const app = Fastify();
  // The attachments route is multipart, so the parser the real server installs
  // has to be here too — without it every upload would 415 before reaching a
  // single one of its own checks.
  app.register(multipart);
  const subagents = new SubagentStore();
  const subagentTranscripts = new SubagentTranscripts();
  const backgroundTasks = new BackgroundTaskStore({ db });
  const errors = new ErrorLog({ db, hub });
  const imagesDir = mkdtempSync(join(tmpdir(), 'orbital-images-'));
  const imageStore = createImageStore(imagesDir);
  // An empty `~/.claude` per app: the command catalog reads real files, so a
  // test that wants commands writes them.
  const claudeDir = mkdtempSync(join(tmpdir(), 'orbital-claude-'));
  const narrator = new Narrator({
    db, queryFn: opts.narrateQueryFn ?? noNarrateQuery, model: () => '',
    onFinish: (id) => hub.publish(`session:${id}`, { event: 'walkthrough_narration' }),
  });
  registerRoutes(app, {
    db, registry: registry as any, runner: runner as any, projectsDir: opts.projectsDir ?? '/nonexistent', hub,
    images: imageStore, imagesDir, claudeDir,
    models: modelCatalog as any,
    subagents,
    backgroundTasks,
    git: gitStore,
    ide: opts.ide ?? ideStore,
    branchStatus: opts.branchStatus ?? branchStatusStore,
    subagentTranscripts,
    errors,
    titler: stubTitler(),
    narrator,
    settings: {
      get: (k: string) =>
        db.select({ value: settingsTable.value }).from(settingsTable)
          .where(eq(settingsTable.key, k)).get()?.value ?? '',
      set: (k: string, v: string) =>
        void db
          .insert(settingsTable)
          .values({ key: k, value: v })
          .onConflictDoUpdate({ target: settingsTable.key, set: { value: v } })
          .run(),
    },
    mcp: noMcp,
    retention: retentionFor(db),
  });
  return {
    app, db, runner, hub, registry, startCalls, sendCalls, modelCatalog, subagents, subagentTranscripts, backgroundTasks, errors,
    imageStore, imagesDir, claudeDir,
  };
}

/** The body of a response that had to succeed — a 500 reads as a diff in the
 * shape assertion otherwise, which is a slow way to find out. */
function res200(res: { statusCode: number; json: () => any }): any {
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** Subscribes a fake socket to a Hub topic and collects published payloads. */
function subscribeFake(hub: Hub, topic: string) {
  const received: any[] = [];
  const socket: any = {
    send: (d: string) => received.push(JSON.parse(d)),
    handlers: {} as Record<string, Function>,
    on(ev: string, cb: Function) { this.handlers[ev] = cb; },
  };
  hub.handleSocket(socket);
  socket.handlers['message'](JSON.stringify({ type: 'subscribe', topic }));
  return received;
}

describe('REST routes', () => {
  let app: FastifyInstance;
  let db: any;
  let runner: any;
  let hub: Hub;
  let registry: any;
  let startCalls: any[];
  let subagents: SubagentStore;
  let subagentTranscripts: SubagentTranscripts;
  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    db = result.db;
    runner = result.runner;
    hub = result.hub;
    registry = result.registry;
    startCalls = result.startCalls;
    subagents = result.subagents;
    subagentTranscripts = result.subagentTranscripts;
  });

  it('GET /api/sessions carries each session\'s running subagents', async () => {
    subagents.feed('s1', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Task', input: { description: 'reviewer' } },
          ],
        },
      },
    ]);
    const body = (await app.inject({ method: 'GET', url: '/api/sessions' })).json();
    expect(body.sessions[0].subagents).toEqual([
      { id: 't1', name: 'reviewer', state: 'working', startedAt: expect.any(Number) },
    ]);
    // A session with none says so explicitly rather than omitting the field.
    expect(body.sessions[1].subagents).toEqual([]);
  });

  it('GET /api/sessions carries the decision a session is parked on', async () => {
    const decision = { id: 'tu-1', kind: 'question', input: { questions: [] }, createdAt: 1 };
    runner.pendingDecision = (id: string) => (id === 's1' ? decision : null);
    const body = (await app.inject({ method: 'GET', url: '/api/sessions' })).json();
    // This is how a reloaded page gets its question back.
    expect(body.sessions[0].pendingDecision).toEqual(decision);
    expect(body.sessions[1].pendingDecision).toBeNull();
  });

  it('GET /api/sessions lists by recency with merged status and tags', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessions.map((s: any) => s.id)).toEqual(['s1', 's2']);
    expect(body.sessions[0]).toMatchObject({ status: 'working', tagIds: [10] });
    expect(body.sessions[1].status).toBe('ended');
  });

  it('GET /api/sessions?tag=10&q=auth filters', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions?tag=10&q=auth' });
    expect(res.json().sessions.map((s: any) => s.id)).toEqual(['s1']);
  });

  it('PATCH /api/sessions/:id renames', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/sessions/s1', payload: { title: 'renamed' },
    });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/sessions?q=renamed' });
    expect(list.json().sessions).toHaveLength(1);
  });

  it('PATCH /api/sessions/:id marks the title as one a person typed', async () => {
    await app.inject({
      method: 'PATCH', url: '/api/sessions/s1', payload: { title: 'renamed by hand' },
    });
    const row = db.select().from(sessions).where(eq(sessions.id, 's1')).get();
    expect(row.titleSource).toBe('manual');
  });

  it('PUT /api/sessions/:id/tags records manual add and removal', async () => {
    await app.inject({ method: 'PUT', url: '/api/sessions/s2/tags', payload: { tagIds: [10] } });
    const list = await app.inject({ method: 'GET', url: '/api/sessions?tag=10' });
    expect(list.json().sessions.map((s: any) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('PUT /api/sessions/:id/tags removing a rule-derived tag actually removes it (C1)', async () => {
    // s1 is seeded with a manual tag, and a manual pick outranks a rule tag
    // (one tag per session) — so drop it first, or the rule tag below would
    // never be the effective one.
    await app.inject({ method: 'PUT', url: '/api/sessions/s1/tags', payload: { tagIds: [] } });

    // Create a tag whose rule matches s1's cwd, so session_tags gets a
    // 'rule'-origin row for it.
    const tagRes = await app.inject({
      method: 'POST', url: '/api/tags', payload: { name: 'ruletag', hue: 5 },
    });
    const ruleTagId = tagRes.json().id;
    const ruleRes = await app.inject({
      method: 'POST', url: '/api/tag-rules',
      payload: { tagId: ruleTagId, condition: 'path_matches', pattern: '/w/x' },
    });
    const ruleId = ruleRes.json().id;

    const before = await app.inject({ method: 'GET', url: '/api/sessions/s1' });
    expect(before.json().session.tagIds).toContain(ruleTagId);

    // Remove every tag via PUT, including the rule-derived one.
    await app.inject({ method: 'PUT', url: '/api/sessions/s1/tags', payload: { tagIds: [] } });
    const after = await app.inject({ method: 'GET', url: '/api/sessions/s1' });
    expect(after.json().session.tagIds).not.toContain(ruleTagId);

    // An unrelated rule mutation re-runs regenerateRuleTags; the manual
    // removal must still be honored (the tag must not come back).
    await app.inject({ method: 'PATCH', url: `/api/tag-rules/${ruleId}`, payload: { position: 0 } });
    const afterMutation = await app.inject({ method: 'GET', url: '/api/sessions/s1' });
    expect(afterMutation.json().session.tagIds).not.toContain(ruleTagId);
  });

  it('tags + rules CRUD and preview', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/tags', payload: { name: 'oncall', hue: 60 },
    });
    expect(created.statusCode).toBe(201);
    const tagId = created.json().id;
    const rule = await app.inject({
      method: 'POST', url: '/api/tag-rules',
      payload: { tagId, condition: 'path_matches', pattern: '^/oncall/' },
    });
    expect(rule.statusCode).toBe(201);
    const preview = await app.inject({
      method: 'POST', url: '/api/tag-rules/preview',
      payload: { cwd: '/oncall/runbooks', title: '', permissionMode: null },
    });
    expect(preview.json()).toMatchObject({ tagId });
  });

  it('GET /api/tags lists the default tag first, whatever its id', async () => {
    db.update(tags).set({ isDefault: 0 }).run();
    db.update(tags).set({ isDefault: 1 }).where(eq(tags.id, 10)).run();
    await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'later', hue: 40 } });
    const res = await app.inject({ method: 'GET', url: '/api/tags' });
    const ids = res.json().tags.map((t: { id: number }) => t.id);
    expect(ids[0]).toBe(10);
    expect(ids.slice(1)).toEqual([...ids.slice(1)].sort((a: number, b: number) => a - b));
  });

  it('GET /api/tags and /api/tag-rules preserve original snake_case key order (derived projection maps)', async () => {
    const tagsRes = await app.inject({ method: 'GET', url: '/api/tags' });
    expect(Object.keys(tagsRes.json().tags[0])).toEqual([
      'id', 'name', 'hue', 'is_default', 'anchor_x', 'anchor_y',
    ]);

    await app.inject({
      method: 'POST', url: '/api/tag-rules',
      payload: { tagId: 10, condition: 'path_matches', pattern: '/w/x' },
    });
    const rulesRes = await app.inject({ method: 'GET', url: '/api/tag-rules' });
    expect(Object.keys(rulesRes.json().rules[0])).toEqual([
      'id', 'tag_id', 'position', 'enabled', 'condition', 'pattern',
    ]);
  });

  // A just-launched session has a row (`project_dir: ''`) and no transcript
  // yet — the CLI writes that file a moment later. The first fetch after a
  // launch used to 404 on it, which left a red line in the console on every
  // single launch.
  it('GET /api/sessions/:id/messages returns an empty transcript for a session with no file yet', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messages: [] });
  });

  it('GET /api/images/:ref serves stored bytes with the right type and an immutable cache header', async () => {
    const { app, imageStore } = makeApp();
    // A real PNG signature so the stored file is what the route claims it is.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(25),
    ]);
    const entry = imageStore.put('image/png', png.toString('base64'))!;

    const res = await app.inject({ method: 'GET', url: `/api/images/${entry.ref}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.rawPayload.equals(png)).toBe(true);
  });

  it('GET /api/images/:ref 404s malformed refs — traversal never reaches the filesystem', async () => {
    const { app } = makeApp();
    for (const ref of ['..%2F..%2Fetc%2Fpasswd', 'abc.png', `${'a'.repeat(64)}.svg`]) {
      const res = await app.inject({ method: 'GET', url: `/api/images/${ref}` });
      expect(res.statusCode).toBe(404);
    }
  });

  it('GET /api/images/:ref 404s a well-formed ref whose file was pruned', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/images/${'0'.repeat(64)}.png` });
    expect(res.statusCode).toBe(404);
  });

  describe('GET /api/sessions/:id/messages paging', () => {
    function appWithTurns(count: number) {
      const projectsDir = mkdtempSync(join(tmpdir(), 'orbital-msg-routes-'));
      mkdirSync(join(projectsDir, 'p'), { recursive: true });
      const lines = Array.from({ length: count }, (_, i) =>
        JSON.stringify({
          type: 'user', uuid: `u${i}`, timestamp: new Date(Date.UTC(2026, 8, 9, 14, 0, i)).toISOString(),
          message: { role: 'user', content: `turn ${i}` },
        }),
      );
      writeFileSync(join(projectsDir, 'p', 's1.jsonl'), lines.join('\n') + '\n');
      return makeApp({ projectsDir }).app;
    }
    const texts = (res: { json(): { messages: { text: string }[] } }) =>
      res.json().messages.map((m) => m.text);

    it('pages backwards from a cursor, oldest first within the page', async () => {
      const app = appWithTurns(5);
      const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/messages?before=u3:0&limit=2' });
      expect(texts(res)).toEqual(['turn 1', 'turn 2']);
    });

    // Parsed transcripts are cached between pages; a line the CLI appends has
    // to show up on the next read, not be hidden behind the cached parse.
    it('serves what was appended to the transcript since the last read', async () => {
      const projectsDir = mkdtempSync(join(tmpdir(), 'orbital-msg-routes-'));
      mkdirSync(join(projectsDir, 'p'), { recursive: true });
      const path = join(projectsDir, 'p', 's1.jsonl');
      const turn = (i: number) =>
        JSON.stringify({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `turn ${i}` } }) + '\n';
      writeFileSync(path, turn(0));
      const { app } = makeApp({ projectsDir });
      expect(texts(await app.inject({ method: 'GET', url: '/api/sessions/s1/messages' }))).toEqual(['turn 0']);
      appendFileSync(path, turn(1));
      expect(texts(await app.inject({ method: 'GET', url: '/api/sessions/s1/messages' }))).toEqual(['turn 0', 'turn 1']);
    });

    // The cursor a launched session's client holds oldest is a live id or the
    // optimistic `local:` first prompt — never a file id. The tail it used to
    // get back was the whole transcript again, under ids its dedupe could not
    // match, printed above the live copy.
    it('answers a cursor the transcript does not contain with an empty page, not the tail', async () => {
      const app = appWithTurns(5);
      for (const before of ['local:1758000000000:1', 's1:7:0']) {
        const res = await app.inject({
          method: 'GET', url: `/api/sessions/s1/messages?before=${encodeURIComponent(before)}`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ messages: [] });
      }
    });
  });

  // Spec 2026-09-29-rewind-design § Reading the live branch: the file keeps
  // every abandoned turn, the API returns only the branch that ends at the
  // newest leaf.
  it('GET /api/sessions/:id/messages returns only the live branch of a rewound transcript', async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), 'orbital-msg-routes-'));
    mkdirSync(join(projectsDir, 'p'), { recursive: true });
    copyFileSync(join(import.meta.dirname, 'fixtures/transcript-rewind-cli.jsonl'), join(projectsDir, 'p', 's1.jsonl'));
    const { app } = makeApp({ projectsDir });
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/messages' });
    const users = (res.json().messages as Array<{ role: string; text?: string }>)
      .filter((m) => m.role === 'user' && m.text)
      .map((m) => m.text);
    expect(users).toEqual([
      'say A (reply with just the letter)',
      'say E (reply with just the letter)',
      'say F (reply with just the letter)',
      'say I (reply with just the letter)',
    ]);
  });

  it('GET /api/sessions/:id/messages still 404s for a session nobody has heard of', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/does-not-exist/messages' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not found' });
  });

  // ---------------------------------------------------------------------
  // GET /api/sessions/:id/subagents/:toolUseId/messages (task-4 brief).
  // ---------------------------------------------------------------------

  /** Registers `s1`'s agent `k1` (toolUseId `tu1`) as known to `SubagentStore`,
   * the way a real `task_started` would — without this, every route under
   * test would see an agent `SubagentStore` never heard of. */
  function knownAgent() {
    subagents.feedTask('s1', {
      type: 'system', subtype: 'task_started', session_id: 's1',
      task_id: 'k1', tool_use_id: 'tu1', description: 'reviewer', task_type: 'local_agent',
    });
  }

  it('GET .../subagents/:toolUseId/messages 404s for a session nobody has heard of', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/does-not-exist/subagents/tu1/messages' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not found' });
  });

  it('GET .../subagents/:toolUseId/messages 404s when the session exists but the agent is unknown to the store — the server-restarted case', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/subagents/tu1/messages' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not found' });
  });

  // The important one: a known agent that has not been appended to yet must
  // read as an honest empty panel, not as STREAM LOST. Would fail if the
  // handler were "simplified" to 404-on-missing-buffer.
  it('GET .../subagents/:toolUseId/messages 200s with an empty list for a known agent with no buffer yet', async () => {
    knownAgent();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/subagents/tu1/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messages: [], droppedCount: 0 });
  });

  it('GET .../subagents/:toolUseId/messages 200s with the buffered messages and droppedCount for a known agent with a buffer', async () => {
    knownAgent();
    subagentTranscripts.append('s1', 'tu1', [
      { id: 'm1', role: 'assistant', text: 'looking' },
      { id: 'm2', role: 'tool_use', toolName: 'Read', toolUseId: 'r1' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/subagents/tu1/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      messages: [
        { id: 'm1', role: 'assistant', text: 'looking' },
        { id: 'm2', role: 'tool_use', toolName: 'Read', toolUseId: 'r1' },
      ],
      droppedCount: 0,
    });
  });

  it('GET .../subagents/:toolUseId/messages 404s an agent whose toolUseId is absent — it can never be addressed this way', async () => {
    // `feed()` (the transcript-only path) never learns a `toolUseId`; only
    // `feedTask()` does, from the SDK's task events.
    subagents.feed('s1', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'ag1', name: 'Task', input: { description: 'reviewer' } }],
        },
      },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/subagents/ag1/messages' });
    expect(res.statusCode).toBe(404);
  });

  // Moon dismissal is gone (subagent list spec § 5): a finished moon leaves
  // the map on its own, so there is nothing left for the user to dismiss.
  it('no longer serves POST .../subagents/:agentId/dismiss', async () => {
    knownAgent();
    const received = subscribeFake(hub, 'sessions');
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s1/subagents/k1/dismiss' });
    expect(res.statusCode).toBe(404);
    expect(received).toEqual([]);
  });

  it('POST /api/sessions starts a web session via the runner', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sessionId: 'web-9' });
  });

  it('POST /api/sessions expands a ~ cwd before the runner and the row see it', async () => {
    // The New Session dialog prefills its directory field from
    // `default_project_dir`, a hand-typed setting that routinely holds
    // `~/...`. A literal tilde reaches the SDK as a directory that does not
    // exist: the spawn fails with ENOENT inside the runner's pump, and the
    // user is left with a session row whose session never ran.
    const { app, db, startCalls } = makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '~/Projects/slothworks/atlas', prompt: 'go', permissionMode: 'acceptEdits' },
    });
    expect(res.statusCode).toBe(201);
    expect(startCalls[0].cwd).toBe(`${homedir()}/Projects/slothworks/atlas`);
    // Stored expanded too, or `/api/projects` lists the same directory twice,
    // once per spelling, and the per-project model memory splits with it.
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'web-9')).get() as SessionRow;
    expect(row.cwd).toBe(`${homedir()}/Projects/slothworks/atlas`);
  });

  // `auto` is the SDK's unattended mode, added to Orbital's union with the
  // permission-mode dots. The column is untyped text, so nothing but this
  // test catches the union and the route body type drifting apart again.
  it('POST /api/sessions accepts auto and round-trips it onto the row', async () => {
    const { app, db, startCalls } = makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/p', prompt: 'go', permissionMode: 'auto' },
    });
    expect(res.statusCode).toBe(201);
    expect(startCalls[0].permissionMode).toBe('auto');
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'web-9')).get() as SessionRow;
    expect(row.permission_mode).toBe('auto');
  });

  it('POST /api/sessions publishes an upsert on the sessions topic (I3)', async () => {
    const received = subscribeFake(hub, 'sessions');
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' },
    });
    expect(res.statusCode).toBe(201);
    const upserts = received.filter((r) => r.event === 'upsert');
    expect(upserts).toHaveLength(1);
    // The fake Runner holds no process, and nobody has ended it: `idle`.
    expect(upserts[0].session).toMatchObject({ id: 'web-9', status: 'idle' });
  });

  it('stores the requested model when launching a session', async () => {
    const { app, db, startCalls } = makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/w/z', prompt: 'go', permissionMode: 'acceptEdits', model: 'opus[1m]' },
    });
    expect(res.statusCode).toBe(201);
    expect(startCalls[0].model).toBe('opus[1m]');
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'web-9')).get() as SessionRow;
    expect(row.model).toBe('opus[1m]');
  });

  it('exposes model and resolvedModel on the API shape', async () => {
    const { app, db } = makeApp();
    db.update(sessions).set({ model: 'sonnet', resolvedModel: 'claude-sonnet-5' }).where(eq(sessions.id, 's1')).run();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1' });
    expect(res.json().session).toMatchObject({ model: 'sonnet', resolvedModel: 'claude-sonnet-5' });
  });

  it('exposes contextUsedTokens, null for a session nothing ever measured', async () => {
    // A terminal session has no usage to read, so its arc is not "0 %" — it
    // is absent (spec context-fill-arc § Where the number comes from).
    const { app, db } = makeApp();
    expect(res200(await app.inject({ method: 'GET', url: '/api/sessions/s2' })).session)
      .toMatchObject({ contextUsedTokens: null });

    db.update(sessions).set({ contextUsedTokens: 124_400 }).where(eq(sessions.id, 's1')).run();
    expect(res200(await app.inject({ method: 'GET', url: '/api/sessions/s1' })).session)
      .toMatchObject({ contextUsedTokens: 124_400 });
  });

  it('POST /sessions/:id/messages revives an ended session via resume', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s2/messages', payload: { text: 'wake up' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, revived: true });
    expect(startCalls.at(-1)).toMatchObject({ resume: 's2', prompt: 'wake up', cwd: '/w/y' });
  });

  it('revives a session on the model it was launched with', async () => {
    const { app, db, startCalls } = makeApp();
    db.update(sessions).set({ model: 'haiku' }).where(eq(sessions.id, 's2')).run();
    await app.inject({ method: 'POST', url: '/api/sessions/s2/messages', payload: { text: 'again' } });
    expect(startCalls[0]).toMatchObject({ resume: 's2', model: 'haiku' });
  });

  it('POST /sessions/:id/messages revive publishes an upsert with status "working" on the sessions topic (F1)', async () => {
    // The runner reports the revived session as 'working' once start() has
    // registered it — mirrors a real runner picking the resumed session up.
    runner.status = (id: string) => (id === 's2' ? 'working' : undefined);
    const received = subscribeFake(hub, 'sessions');
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s2/messages', payload: { text: 'wake up' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, revived: true });
    const upserts = received.filter((r) => r.event === 'upsert' && r.session.id === 's2');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].session).toMatchObject({ id: 's2', status: 'working' });
  });

  it('revive flips a terminal session to source "web"', async () => {
    // The contract `web/src/lib/types.ts` documents on `isReadOnly`: continue
    // resumes an ended terminal session as Orbital's own. Without the flip the
    // revived session is {source: 'terminal', status: live} — exactly the
    // shape the composer refuses input on, locking the session read-only.
    runner.status = (id: string) => (id === 's2' ? 'working' : undefined);
    const received = subscribeFake(hub, 'sessions');
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s2/messages', payload: { text: 'wake up' },
    });
    expect(res.statusCode).toBe(200);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
    expect(row.source).toBe('web');
    const upsert = received.find((r) => r.event === 'upsert' && r.session.id === 's2');
    expect(upsert.session).toMatchObject({ source: 'web', status: 'working' });
  });

  it('POST /sessions/:id/messages 409s for a live terminal session', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s1/messages', payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(409); // s1 is live in the registry fake
  });

  it('POST /sessions/:id/messages 404s for an unknown session', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/does-not-exist/messages', payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('registry upsert publishes REST-shaped session on the sessions topic', () => {
    const received = subscribeFake(hub, 'sessions');
    const live = {
      sessionId: 's1', pid: 1, cwd: '/w/x', name: 'auth fix',
      status: 'working' as const, kind: 'claude', startedAt: 0, updatedAt: 500,
    };
    publishLiveSession({ hub, db, registry: registry, runner: runner, subagents, backgroundTasks: new BackgroundTaskStore(), git: gitStore, ide: ideStore, branchStatus: branchStatusStore }, live);
    const upserts = received.filter((r) => r.event === 'upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].session).toMatchObject({ id: 's1', status: 'working', tagIds: [10] });
  });

  it('registry upsert for a session with no DB row falls back to the live-only shape', () => {
    const received = subscribeFake(hub, 'sessions');
    const live = {
      sessionId: 'term-9', pid: 1, cwd: '/w/z', name: 'untracked',
      status: 'idle' as const, kind: 'claude', startedAt: 0, updatedAt: 700,
    };
    publishLiveSession({ hub, db, registry: registry, runner: runner, subagents, backgroundTasks: new BackgroundTaskStore(), git: gitStore, ide: ideStore, branchStatus: branchStatusStore }, live);
    const upserts = received.filter((r) => r.event === 'upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].session).toMatchObject({
      id: 'term-9', cwd: '/w/z', title: 'untracked', source: 'terminal',
      status: 'idle', tagIds: [], lastAt: 700,
    });
  });

  // A selection drag in a big workspace used to republish every session ever
  // run there (audit resource-usage-pass-2026-09-24, finding 4).
  it('a directory change republishes live sessions and open ones, not every ended one', () => {
    const ctx = { hub, db, registry, runner, subagents, backgroundTasks: new BackgroundTaskStore(), git: gitStore, ide: ideStore, branchStatus: branchStatusStore };
    db.insert(sessions)
      .values({ id: 's3', projectDir: 'p', cwd: '/w/x', title: 'ended', lastAt: 50, source: 'web' })
      .run();
    const received = subscribeFake(hub, 'sessions');
    const upserted = () => received.filter((r) => r.event === 'upsert').map((r) => r.session.id).sort();

    // s1 is live in the registry fake; s2 and s3 ended long ago.
    republishCwds(ctx, ['/w/x', '/w/y']);
    expect(upserted()).toEqual(['s1']);

    // A window with s3 open shows its branch and sends its selection.
    received.length = 0;
    subscribeFake(hub, 'session:s3');
    republishCwds(ctx, ['/w/x', '/w/y']);
    expect(upserted()).toEqual(['s1', 's3']);

    // A session Orbital's runner owns counts as live without the registry.
    received.length = 0;
    runner.status = (id: string) => (id === 's2' ? 'idle' : undefined);
    republishCwds(ctx, ['/w/y']);
    expect(upserted()).toEqual(['s2']);
  });

  it('GET /api/models serves the catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json().models[0]).toMatchObject({ value: 'sonnet', family: 'Sonnet', contextWindow: 200_000 });
  });

  it('GET /api/models serves the learned context windows beside the catalog', async () => {
    // The client's exact-resolved-id fallback denominator — a session whose
    // resolved model matches no catalog row would otherwise have no window
    // at all (fix: revived-session-shows-no-context-gauge).
    const res = await app.inject({ method: 'GET', url: '/api/models' });
    expect(res.json().contextWindows).toEqual({ 'claude-fable-5': 1_000_000 });
  });

  it('POST /api/models/validate rejects a body that is not one model id', async () => {
    const { app, modelCatalog } = makeApp();
    for (const payload of [{}, { model: '' }, { model: '   ' }, { model: 42 }, { model: 'claude opus' }, { model: 'x'.repeat(101) }]) {
      const res = await app.inject({ method: 'POST', url: '/api/models/validate', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'model is required' });
    }
    expect(modelCatalog.validate).not.toHaveBeenCalled();
  });

  it('POST /api/models/validate passes the catalog\'s answer through, trimmed id in', async () => {
    const { app, modelCatalog } = makeApp();
    modelCatalog.validate.mockResolvedValueOnce({ ok: false, model: 'claude-opus-nope', reason: 'no such model' } as any);
    const res = await app.inject({ method: 'POST', url: '/api/models/validate', payload: { model: ' claude-opus-nope ' } });
    expect(res200(res)).toEqual({ ok: false, model: 'claude-opus-nope', reason: 'no such model' });
    expect(modelCatalog.validate).toHaveBeenCalledWith('claude-opus-nope');
  });

  it('a custom model id is stored as the default and handed to a new session unchanged', async () => {
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { default_model: 'claude-opus-4-6' } });
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).json().default_model).toBe('claude-opus-4-6');
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/w/x', prompt: 'hi', permissionMode: 'default', model: 'claude-opus-4-6' },
    });
    expect(res.statusCode).toBe(201);
    expect(startCalls.at(-1).model).toBe('claude-opus-4-6');
  });

  it('GET and PATCH /api/settings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.json().default_permission_mode).toBe('acceptEdits');
    await app.inject({
      method: 'PATCH', url: '/api/settings', payload: { confirm_before_clear: 'false' },
    });
    const after = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(after.json().confirm_before_clear).toBe('false');
  });

  describe('GET /api/session-instructions/tips', () => {
    // Spec 2026-09-30-session-instructions-design § 4: the preview shows what
    // the running server sends, so the route and the composer share one list.
    it('returns the shipped tips in the order the composer emits them', async () => {
      const { app } = makeApp();
      const res = await app.inject({ method: 'GET', url: '/api/session-instructions/tips' });
      expect(res.statusCode).toBe(200);
      const { tips } = res.json() as { tips: { id: string; title: string; text: string }[] };
      expect(tips.map((t) => t.id)).toEqual(SESSION_TIPS.map((t) => t.id));
      const appendix = composeAppendix({ tipsOn: true, commentary: false, customOn: false, customText: '' });
      expect(appendix).toBe(tips.map((t) => t.text).join('\n\n'));
      for (const tip of tips) {
        expect(tip.title.length).toBeGreaterThan(0);
        expect(tip.text.length).toBeGreaterThan(0);
      }
    });

    it('seeds the three instruction rows with their defaults', async () => {
      const { app } = makeApp();
      const settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
      expect(settings.session_instructions_tips).toBe('true');
      expect(settings.session_instructions_custom).toBe('true');
      expect(settings.session_instructions_custom_text).toBe('');
    });
  });

  it('POST /api/sessions/:id/end stops the process, with the stamp already written', async () => {
    // What the row says at the moment of the stop is what the release gets
    // announced with, so the stamp has to be there first.
    const stampAtStop: Array<number | null> = [];
    runner.stop = async (id: string) => {
      const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
      stampAtStop.push(row.ended_at);
    };
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s1/end' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(stampAtStop).toEqual([expect.any(Number)]);
  });

  it('POST /api/sessions/:id/end stamps ended_at and publishes the session as ended', async () => {
    db.update(sessions).set({ source: 'web' }).where(eq(sessions.id, 's2')).run();
    const received = subscribeFake(hub, 'sessions');
    const before = Date.now();
    await app.inject({ method: 'POST', url: '/api/sessions/s2/end' });
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
    expect(row.ended_at).toBeGreaterThanOrEqual(before);
    expect(received).toContainEqual(
      expect.objectContaining({ event: 'upsert', session: expect.objectContaining({ id: 's2', status: 'ended' }) }),
    );
  });

  it('POST /api/sessions/:id/end 404s an unknown session without touching the runner', async () => {
    const ended: string[] = [];
    runner.stop = async (id: string) => { ended.push(id); };
    const res = await app.inject({ method: 'POST', url: '/api/sessions/nope/end' });
    expect(res.statusCode).toBe(404);
    expect(ended).toEqual([]);
  });

  it('POST /api/sessions/:id/clear with startNew uses computed permission mode', async () => {
    // Capture runner.start() calls
    const startCalls: any[] = [];
    runner.start = async (body: any) => {
      startCalls.push(body);
      return 'web-10';
    };

    // Set inherit_permission_mode to false, default to plan, and inherit_tags to false
    await app.inject({
      method: 'PATCH', url: '/api/settings',
      payload: {
        inherit_permission_mode: 'false',
        default_permission_mode: 'plan',
        inherit_tags: 'false',
      },
    });

    // Old session has acceptEdits mode, but we should use default (plan) because inherit is false
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s1/clear',
      payload: { startNew: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessionId: 'web-10' });

    // Verify runner.start() received the default (plan) mode, not old session's mode
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].permissionMode).toBe('plan');

    // Verify new session in DB has the default mode
    const newSession = db
      .select({ permissionMode: sessions.permissionMode })
      .from(sessions)
      .where(eq(sessions.id, 'web-10'))
      .get()!;
    expect(newSession.permissionMode).toBe('plan');

    // Verify manual tags are NOT copied (inherit_tags=false)
    const newTags = db
      .select({ tagId: sessionTags.tagId })
      .from(sessionTags)
      .where(eq(sessionTags.sessionId, 'web-10'))
      .all();
    expect(newTags).toHaveLength(0);

    // Now test with inherit_tags=true
    await app.inject({
      method: 'PATCH', url: '/api/settings',
      payload: { inherit_tags: 'true' },
    });

    const res2 = await app.inject({
      method: 'POST', url: '/api/sessions/s1/clear',
      payload: { startNew: true },
    });
    expect(res2.statusCode).toBe(200);
    const newSessionId = res2.json().sessionId;

    // Verify manual tags ARE copied
    const copiedTags = db
      .select({ tagId: sessionTags.tagId })
      .from(sessionTags)
      .where(eq(sessionTags.sessionId, newSessionId))
      .all();
    expect(copiedTags).toHaveLength(1);
    expect(copiedTags[0].tagId).toBe(10);
  });

  it('POST /api/sessions/:id/clear with startNew publishes an upsert for the new session on the sessions topic', async () => {
    const received = subscribeFake(hub, 'sessions');
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s1/clear',
      payload: { startNew: true },
    });
    expect(res.statusCode).toBe(200);
    const newId = res.json().sessionId;
    const upserts = received.filter((r) => r.event === 'upsert' && r.session.id === newId);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].session).toMatchObject({ id: newId, source: 'web' });
    // Lineage is gone (spec 2026-09-24-sessions-end-only-by-hand-design § 4):
    // the new session carries no link back to the one it replaced.
    expect(upserts[0].session).not.toHaveProperty('parentId');
  });

  it('POST /api/sessions/:id/clear stamps ended_at on the old session, not the new one', async () => {
    db.update(sessions).set({ source: 'web' }).where(eq(sessions.id, 's2')).run();
    const received = subscribeFake(hub, 'sessions');
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s2/clear', payload: { startNew: true },
    });
    const rowOf = (id: string) =>
      db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;
    expect(typeof rowOf('s2').ended_at).toBe('number');
    expect(rowOf(res.json().sessionId).ended_at).toBeNull();
    expect(received).toContainEqual(
      expect.objectContaining({ event: 'upsert', session: expect.objectContaining({ id: 's2', status: 'ended' }) }),
    );
  });

  it('POST /api/sessions/:id/clear without startNew still stamps ended_at', async () => {
    await app.inject({ method: 'POST', url: '/api/sessions/s2/clear', payload: {} });
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
    expect(typeof row.ended_at).toBe('number');
  });

  it('clear + startNew uses the settings default model, not the parent one', async () => {
    const { app, db, startCalls } = makeApp();
    db.update(sessions).set({ model: 'haiku', source: 'web' }).where(eq(sessions.id, 's2')).run();
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { default_model: 'sonnet' } });
    await app.inject({ method: 'POST', url: '/api/sessions/s2/clear', payload: { startNew: true } });
    expect(startCalls[0].model).toBe('sonnet');
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 'web-9')).get() as SessionRow;
    expect(row.model).toBe('sonnet');
  });

  it('switches the model of a live session', async () => {
    const { app, db, runner } = makeApp();
    const calls: Array<[string, string]> = [];
    (runner as any).setModel = async (id: string, model: string) => { calls.push([id, model]); };
    (runner as any).status = (id: string) => (id === 's2' ? 'needs_input' : undefined);
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: { model: 'haiku' } });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([['s2', 'haiku']]);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
    expect(row.model).toBe('haiku');
  });

  it('records the model of an ended session without touching the runner', async () => {
    const { app, db, runner } = makeApp();
    let called = false;
    (runner as any).setModel = async () => { called = true; };
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: { model: 'sonnet' } });
    expect(res.statusCode).toBe(200);
    expect(called).toBe(false);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
    expect(row.model).toBe('sonnet');
  });

  it('switches the permission mode of a live session', async () => {
    const { app, db, runner } = makeApp();
    const calls: Array<[string, string]> = [];
    (runner as any).setPermissionMode = async (id: string, mode: string) => { calls.push([id, mode]); };
    (runner as any).status = (id: string) => (id === 's2' ? 'working' : undefined);
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s2/permission-mode', payload: { mode: 'bypassPermissions' } });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([['s2', 'bypassPermissions']]);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
    expect(row.permission_mode).toBe('bypassPermissions');
  });

  it('records the permission mode of an ended session without touching the runner', async () => {
    const { app, db, runner } = makeApp();
    let called = false;
    (runner as any).setPermissionMode = async () => { called = true; };
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s2/permission-mode', payload: { mode: 'plan' } });
    expect(res.statusCode).toBe(200);
    expect(called).toBe(false);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
    expect(row.permission_mode).toBe('plan');
  });

  it('rejects a permission mode Orbital does not offer', async () => {
    const { app } = makeApp();
    for (const mode of ['default', 'dontAsk', '', 42, undefined]) {
      const res = await app.inject({ method: 'POST', url: '/api/sessions/s2/permission-mode', payload: { mode } });
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses to change the permission mode of a session live in a terminal', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s1/permission-mode', payload: { mode: 'plan' } });
    expect(res.statusCode).toBe(409);
  });

  it('refuses to switch a session that is live in a terminal', async () => {
    const { app, db } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s1/model', payload: { model: 'haiku' } });
    expect(res.statusCode).toBe(409);
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's1')).get() as SessionRow;
    expect(row.model).toBeNull();
  });

  it('404s for an unknown session', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/nope/model', payload: { model: 'haiku' } });
    expect(res.statusCode).toBe(404);
  });

  it('400s on a missing or non-string model rather than clearing the row', async () => {
    const { app, db } = makeApp();
    db.update(sessions).set({ model: 'haiku' }).where(eq(sessions.id, 's2')).run();

    const missing = await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: {} });
    expect(missing.statusCode).toBe(400);

    const wrongType = await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: { model: 42 } });
    expect(wrongType.statusCode).toBe(400);

    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, 's2')).get() as SessionRow;
    expect(row.model).toBe('haiku');
  });

  it('publishes an upsert after a switch', async () => {
    const { app, hub, runner } = makeApp();
    (runner as any).setModel = async () => {};
    const received = subscribeFake(hub, 'sessions');
    await app.inject({ method: 'POST', url: '/api/sessions/s2/model', payload: { model: 'haiku' } });
    expect(received.at(-1).session).toMatchObject({ id: 's2', model: 'haiku' });
  });

  it('reports each project with the model its newest session used', async () => {
    const { app, db } = makeApp();
    db.update(sessions).set({ model: 'opus[1m]' }).where(eq(sessions.id, 's1')).run();
    db.update(sessions).set({ model: null, resolvedModel: 'claude-haiku-4-5-20251001' }).where(eq(sessions.id, 's2')).run();
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.json().projects).toEqual([
      { cwd: '/w/x', lastModel: 'opus[1m]' },
      { cwd: '/w/y', lastModel: 'claude-haiku-4-5-20251001' },
    ]);
  });
});

describe('buildServer smoke', () => {
  it('boots, serves /api/sessions and /ws upgrade route exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-boot-'));
    const app = await buildServer({
      dbPath: join(dir, 'index.db'),
      claudeDir: dir, // empty: no projects/, no sessions/ — must still boot
    });
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessions: [] });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// POST /api/sessions with an id the browser minted (it subscribes first)
// ---------------------------------------------------------------------------

describe('POST /api/sessions with a browser-minted session id', () => {
  const CLIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const SERVER_MINTED = '8c2a1f6e-7b3d-4c5a-9e1f-2a3b4c5d6e7f';

  /** SDK fake that parks on stdin: the session stays alive and says nothing. */
  const idleSdk = ({ prompt }: any) => {
    async function* gen(): AsyncGenerator<any> {
      for await (const _msg of prompt) { /* take the turn, answer nothing */ }
    }
    return gen() as any;
  };

  // A real Runner, not the fake at the top of this file: the point of the
  // 400 case is that no CLI was spawned, and a fake whose `active()` is a
  // hardcoded `[]` could never show that.
  function makeLaunchApp() {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'orbital-mint-')), 'index.db'));
    const hub = new Hub();
    const runner = new Runner({
      hub, queryFn: idleSdk as any, newSessionId: () => SERVER_MINTED,
    });
    const app = Fastify();
    registerRoutes(app, {
      db,
      registry: { get: () => undefined, all: () => [] } as any,
      runner,
      projectsDir: '/nonexistent',
      hub,
      models: { list: async () => [], recordContextWindows: () => {} } as any,
      subagents: new SubagentStore(),
      backgroundTasks: new BackgroundTaskStore(),
      git: gitStore,
      ide: ideStore,
      branchStatus: branchStatusStore,
      subagentTranscripts: new SubagentTranscripts(),
      errors: new ErrorLog({ db, hub }),
      titler: stubTitler(),
      narrator: new Narrator({ db, queryFn: noNarrateQuery, model: () => '' }),
      images: { put: () => null, putBytes: () => null, read: () => null }, imagesDir: '/nonexistent',
      claudeDir: '/nonexistent',
      settings: { get: () => '', set: () => {} },
      mcp: noMcp,
      retention: retentionFor(db),
    });
    return { app, db, runner, hub, close: () => { runner.dispose(); db.$client.close(); } };
  }

  const launch = (app: FastifyInstance, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits', ...payload },
    });

  it('creates the session under exactly the id the browser sent', async () => {
    const { app, db, runner, close } = makeLaunchApp();
    const res = await launch(app, { sessionId: CLIENT_ID });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sessionId: CLIENT_ID });
    // The row, the runner and the topic the browser is already sitting on
    // all name the same session — which is the entire point.
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, CLIENT_ID)).get() as SessionRow;
    expect(row).toBeDefined();
    expect(row.source).toBe('web');
    expect(runner.status(CLIENT_ID)).toBeDefined();
    expect(runner.active()).toEqual([CLIENT_ID]);
    close();
  });

  // Not a UUID at all, a v1 UUID (the CLI takes no other shape than v4), and
  // an empty string — which is *present* and wrong, not absent.
  for (const [label, sessionId] of [
    ['not a UUID', 'my-favourite-session'],
    ['a v1 UUID', '2c1e4f7a-9c1b-11ee-b9d1-0242ac120002'],
    ['an empty string', ''],
  ] as const) {
    it(`400s on ${label} and starts nothing`, async () => {
      const { app, db, runner, close } = makeLaunchApp();
      const res = await launch(app, { sessionId });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'sessionId must be a v4 UUID' });
      // The worst outcome here would be a 400 that still spawned a CLI: a
      // running session nothing in the UI can ever name.
      expect(runner.active()).toEqual([]);
      expect(db.select(sessionColumns).from(sessions).all()).toEqual([]);
      close();
    });
  }

  it('409s when a row already holds that id', async () => {
    const { app, db, runner, close } = makeLaunchApp();
    db.insert(sessions)
      .values({ id: CLIENT_ID, projectDir: 'p', cwd: '/w/x', lastAt: 1, source: 'terminal' })
      .run();
    const res = await launch(app, { sessionId: CLIENT_ID });
    expect(res.statusCode).toBe(409);
    expect(runner.active()).toEqual([]);
    close();
  });

  it('409s when the runner is already running that id', async () => {
    const { app, runner, close } = makeLaunchApp();
    // Live in the runner but with no row of its own — the sessions table
    // alone would have said this id was free.
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'plan', sessionId: CLIENT_ID });
    const res = await launch(app, { sessionId: CLIENT_ID });
    expect(res.statusCode).toBe(409);
    expect(runner.active()).toEqual([CLIENT_ID]);
    close();
  });

  it('409s when the runner ran that id and has since stopped it', async () => {
    const { app, runner, close } = makeLaunchApp();
    // A stopped session no longer has a `status()` — the transcript under
    // its name is still on disk, though, and no row says so here.
    await runner.start({ cwd: '/p', prompt: 'go', permissionMode: 'plan', sessionId: CLIENT_ID });
    await runner.stop(CLIENT_ID);
    expect(runner.status(CLIENT_ID)).toBeUndefined();
    const res = await launch(app, { sessionId: CLIENT_ID });
    expect(res.statusCode).toBe(409);
    expect(runner.active()).toEqual([]);
    close();
  });

  it('mints server-side when the body carries no sessionId at all', async () => {
    const { app, db, runner, close } = makeLaunchApp();
    const res = await launch(app, {});
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sessionId: SERVER_MINTED });
    const row = db.select(sessionColumns).from(sessions).where(eq(sessions.id, SERVER_MINTED)).get() as SessionRow;
    expect(row).toBeDefined();
    expect(runner.active()).toEqual([SERVER_MINTED]);
    close();
  });

  describe('spawn_session', () => {
    const rowOf = (db: OrbitalDb, id: string) =>
      db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow | undefined;

    async function withParent(model?: string) {
      const launched = makeLaunchApp();
      const cwd = mkdtempSync(join(tmpdir(), 'orbital-spawn-'));
      await launch(launched.app, { sessionId: CLIENT_ID, cwd, ...(model ? { model } : {}) });
      return { ...launched, cwd };
    }

    it('starts a session in the parent\'s cwd, mode and model, marked with the parent', async () => {
      const { db, runner, cwd, close } = await withParent('opus');
      // The mode as it stands now, not as the parent was launched.
      await runner.setPermissionMode(CLIENT_ID, 'bypassPermissions');
      const result = await runner.spawner!(CLIENT_ID, { prompt: 'do the other thing' });
      expect(result).toEqual({ sessionId: SERVER_MINTED, cwd });
      expect(rowOf(db, SERVER_MINTED)).toMatchObject({
        cwd, source: 'web', permission_mode: 'bypassPermissions', model: 'opus', spawned_by: CLIENT_ID,
      });
      expect(rowOf(db, CLIENT_ID)?.spawned_by).toBeNull();
      close();
    });

    it('lets the tool pick another model', async () => {
      const { db, runner, close } = await withParent('opus');
      await runner.spawner!(CLIENT_ID, { prompt: 'go', model: 'haiku' });
      expect(rowOf(db, SERVER_MINTED)?.model).toBe('haiku');
      close();
    });

    it('refuses a cwd that is not a directory, and starts nothing', async () => {
      const { db, runner, cwd, close } = await withParent();
      await expect(runner.spawner!(CLIENT_ID, { prompt: 'go', cwd: join(cwd, 'missing') }))
        .rejects.toThrow(/no such directory/);
      await expect(runner.spawner!(CLIENT_ID, { prompt: 'go', cwd: 'relative/dir' }))
        .rejects.toThrow(/absolute/);
      expect(rowOf(db, SERVER_MINTED)).toBeUndefined();
      expect(runner.active()).toEqual([CLIENT_ID]);
      close();
    });

    it('refuses a parent that is not running', async () => {
      const { runner, close } = await withParent();
      await expect(runner.spawner!('not-running', { prompt: 'go' })).rejects.toThrow(/no longer running/);
      close();
    });
  });
});

// ---------------------------------------------------------------------------
// claude_code_version (task 3)
// ---------------------------------------------------------------------------

describe('claude_code_version', () => {
  it('resolves the bundled Claude Code CLI version, or nothing at all', () => {
    const version = resolveClaudeCodeVersion();
    // Never a placeholder: either a real dotted version or null.
    if (version !== null) expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('buildServer publishes it through GET /api/settings when resolvable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-ver-'));
    const app = await buildServer({
      dbPath: join(dir, 'index.db'),
      claudeDir: join(dir, 'claude'),
      queryFn: (() => {}) as any,
    });
    const body = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    const expected = resolveClaudeCodeVersion();
    if (expected === null) {
      // Unresolvable: the key stays absent so the UI row stays hidden.
      expect('claude_code_version' in body).toBe(false);
    } else {
      expect(body.claude_code_version).toBe(expected);
    }
    // The rest of the settings payload is untouched.
    expect(body.default_model).toBe('sonnet');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// The error log (docs/superpowers/specs/2026-09-17-error-surface-design.md)
// ---------------------------------------------------------------------------

describe('error log routes', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof makeApp>['db'];
  let hub: Hub;
  let errors: ErrorLog;
  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    db = result.db;
    hub = result.hub;
    errors = result.errors;
  });

  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/errors', payload: payload as any });

  it('GET /api/errors returns rows newest first with the whole-table unseen count', async () => {
    for (const message of ['one', 'two', 'three']) {
      errors.record({ source: 'server', kind: 'session_failed', message });
    }
    const body = (await app.inject({ method: 'GET', url: '/api/errors' })).json();
    expect(body.errors.map((e: any) => e.message)).toEqual(['three', 'two', 'one']);
    expect(body.unseen).toBe(3);
  });

  it('GET /api/errors pages with limit and before, and unseen stays the total', async () => {
    for (let i = 0; i < 5; i++) {
      errors.record({ source: 'server', kind: 'session_failed', message: `e${i}` });
    }
    const first = (await app.inject({ method: 'GET', url: '/api/errors?limit=2' })).json();
    expect(first.errors.map((e: any) => e.message)).toEqual(['e4', 'e3']);
    // Not 2: the count is of the table, not of the page.
    expect(first.unseen).toBe(5);
    const next = (
      await app.inject({ method: 'GET', url: `/api/errors?limit=2&before=${first.errors[1].id}` })
    ).json();
    expect(next.errors.map((e: any) => e.message)).toEqual(['e2', 'e1']);
  });

  it('POST /api/errors records the browser\'s own failure and publishes it', async () => {
    const received = subscribeFake(hub, 'errors');
    const res = await post({
      kind: 'api_request',
      message: 'rename failed',
      detail: 'HTTP 500\n{"error":"boom"}',
      context: { url: '/api/sessions/s1', status: 500 },
      sessionId: 's1',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toMatchObject({
      source: 'web',
      kind: 'api_request',
      message: 'rename failed',
      sessionId: 's1',
      context: { url: '/api/sessions/s1', status: 500 },
      seenAt: null,
    });
    expect(body.unseen).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ topic: 'errors', event: 'error', unseen: 1 });
    expect(received[0].error.message).toBe('rename failed');
  });

  it('POST /api/errors cannot be told it came from the server', async () => {
    const body = (await post({ source: 'server', kind: 'render_crash', message: 'boom' })).json();
    expect(body.error.source).toBe('web');
    const listed = (await app.inject({ method: 'GET', url: '/api/errors' })).json();
    expect(listed.errors[0].source).toBe('web');
  });

  it('POST /api/errors takes the transcript check\'s gap report', async () => {
    const res = await post({ kind: 'transcript_gap', message: 'reloaded', sessionId: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().error.kind).toBe('transcript_gap');
  });

  it('POST /api/errors rejects a missing message and an unknown kind', async () => {
    const noMessage = await post({ kind: 'api_request', message: '   ' });
    expect(noMessage.statusCode).toBe(400);
    expect(noMessage.json()).toEqual({ error: 'message is required' });

    const badKind = await post({ kind: 'session_exploded', message: 'boom' });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json()).toEqual({ error: 'kind is invalid' });

    // Nothing was written by either attempt.
    expect((await app.inject({ method: 'GET', url: '/api/errors' })).json().errors).toEqual([]);
  });

  it('POST /api/errors/seen stamps a list of ids, then all of them', async () => {
    const ids = ['a', 'b', 'c'].map(
      (m) => errors.record({ source: 'server', kind: 'session_failed', message: m }).id,
    );
    const some = await app.inject({
      method: 'POST', url: '/api/errors/seen', payload: { ids: [ids[0]] },
    });
    expect(some.json()).toEqual({ ok: true, unseen: 2 });

    const all = await app.inject({
      method: 'POST', url: '/api/errors/seen', payload: { all: true },
    });
    expect(all.json()).toEqual({ ok: true, unseen: 0 });
    // The list is an inbox — read rows leave it but stay in the table.
    const listed = (await app.inject({ method: 'GET', url: '/api/errors' })).json();
    expect(listed).toEqual({ errors: [], unseen: 0 });
    expect(db.$client.prepare('SELECT COUNT(*) AS n FROM errors').get()).toEqual({ n: 3 });
  });

  it('POST /api/errors/seen rejects a body that is neither ids nor all', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/errors/seen', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'ids must be an array of numbers' });
  });

  it('there is no delete route — the log is a history the API cannot empty', async () => {
    errors.record({ source: 'server', kind: 'session_failed', message: 'stays' });
    const res = await app.inject({ method: 'DELETE', url: '/api/errors' });
    expect(res.statusCode).toBe(404);
    expect(db.$client.prepare('SELECT COUNT(*) AS n FROM errors').get()).toEqual({ n: 1 });
  });
});

// The hole's index total. Spec: docs/superpowers/specs/2026-09-18-tag-clusters-design.md § 4.
describe('session count', () => {
  it('GET /api/sessions/count returns the whole index total, unpaged', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/count' });
    expect(res.json()).toEqual({ total: 2 });
  });
});

// A session ends only when the user ends it, and comes back when they write
// to it or take the End back.
// Spec: docs/superpowers/specs/2026-09-24-sessions-end-only-by-hand-design.md § 1.
describe('ending and reopening', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof makeApp>['db'];
  let hub: Hub;
  let runner: ReturnType<typeof makeApp>['runner'];

  beforeEach(() => {
    ({ app, db, hub, runner } = makeApp());
    db.insert(sessions)
      .values({ id: 'w1', projectDir: 'p', cwd: '/w/z', source: 'web', lastAt: 50, endedAt: 1234 })
      .run();
  });

  const rowOf = (id: string) =>
    db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;

  it('POST /api/sessions/:id/reopen clears ended_at and publishes the session as idle', async () => {
    const received = subscribeFake(hub, 'sessions');
    const res = await app.inject({ method: 'POST', url: '/api/sessions/w1/reopen' });
    expect(res.statusCode).toBe(200);
    expect(rowOf('w1').ended_at).toBeNull();
    expect(received).toContainEqual(
      expect.objectContaining({ event: 'upsert', session: expect.objectContaining({ id: 'w1', status: 'idle' }) }),
    );
  });

  it('POST /api/sessions/:id/reopen 404s an unknown session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sessions/nope/reopen' });
    expect(res.statusCode).toBe(404);
  });

  // A terminal session's end is its CLI exiting; no stamp can take that back.
  it('POST /api/sessions/:id/reopen refuses a terminal session with 409', async () => {
    db.update(sessions).set({ endedAt: 99 }).where(eq(sessions.id, 's2')).run();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s2/reopen' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'terminal_session' });
    expect(rowOf('s2').ended_at).toBe(99);
  });

  it('a delivered message reopens an ended session', async () => {
    // w1 is inactive in the runner, so this goes down the revive path.
    await app.inject({
      method: 'POST', url: '/api/sessions/w1/messages', payload: { text: 'continue' },
    });
    expect(rowOf('w1').ended_at).toBeNull();
  });

  it('a revive that fails leaves the session ended', async () => {
    runner.start = async () => { throw new Error('spawn failed'); };
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/w1/messages', payload: { text: 'continue' },
    });
    expect(res.statusCode).toBe(500);
    expect(rowOf('w1').ended_at).toBe(1234);
  });

  // The trash's drop of a pinned session: an end and an unpin sent apart
  // published a row ended-but-pinned in between, and the planet faded back in.
  it('POST /api/sessions/:id/end with unpin ends and unpins in one publish', async () => {
    db.update(sessions).set({ endedAt: null, pinnedAt: 77 }).where(eq(sessions.id, 'w1')).run();
    const received = subscribeFake(hub, 'sessions');
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/w1/end', payload: { unpin: true },
    });
    expect(res.statusCode).toBe(200);
    expect(rowOf('w1').ended_at).toEqual(expect.any(Number));
    expect(rowOf('w1').pinned_at).toBeNull();
    const upserts = received.filter((m) => m.event === 'upsert' && m.session.id === 'w1');
    expect(upserts.length).toBeGreaterThan(0);
    for (const m of upserts) expect(m.session).toMatchObject({ status: 'ended', pinnedAt: null });
  });

  it('POST /api/sessions/:id/end without unpin keeps the pin', async () => {
    db.update(sessions).set({ endedAt: null, pinnedAt: 77 }).where(eq(sessions.id, 'w1')).run();
    await app.inject({ method: 'POST', url: '/api/sessions/w1/end' });
    expect(rowOf('w1').pinned_at).toBe(77);
  });

  it('GET /api/sessions/:id returns the session alone, with no lineage', async () => {
    const body = res200(await app.inject({ method: 'GET', url: '/api/sessions/w1' }));
    expect(Object.keys(body)).toEqual(['session']);
    expect(body.session).toMatchObject({ id: 'w1', status: 'ended' });
    expect(body.session).not.toHaveProperty('parentId');
  });
});

// Pinned sessions: the manual exemption from the release timer.
// Spec: docs/superpowers/specs/2026-09-20-pinned-sessions-design.md § Server.
describe('pinned sessions', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof makeApp>['db'];
  let hub: Hub;

  beforeEach(() => {
    ({ app, db, hub } = makeApp());
  });

  const rowOf = (id: string) =>
    db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)).get() as SessionRow;

  it('PUT /api/sessions/:id/pinned stamps pinned_at and publishes the upsert', async () => {
    const received = subscribeFake(hub, 'sessions');
    const res = await app.inject({
      method: 'PUT', url: '/api/sessions/s2/pinned', payload: { pinned: true },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof rowOf('s2').pinned_at).toBe('number');
    expect(received[0]).toMatchObject({
      event: 'upsert',
      session: { id: 's2', pinnedAt: rowOf('s2').pinned_at },
    });
  });

  it('PUT /api/sessions/:id/pinned with pinned:false clears the stamp', async () => {
    await app.inject({ method: 'PUT', url: '/api/sessions/s2/pinned', payload: { pinned: true } });
    const res = await app.inject({
      method: 'PUT', url: '/api/sessions/s2/pinned', payload: { pinned: false },
    });
    expect(res.statusCode).toBe(200);
    expect(rowOf('s2').pinned_at).toBeNull();
  });

  it('PUT /api/sessions/:id/pinned 404s an unknown session and 400s a non-boolean body', async () => {
    const missing = await app.inject({
      method: 'PUT', url: '/api/sessions/nope/pinned', payload: { pinned: true },
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({
      method: 'PUT', url: '/api/sessions/s2/pinned', payload: { pinned: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'pinned must be a boolean' });
  });

  it('a delivered message reopens a pinned ended session and leaves the pin', async () => {
    await app.inject({ method: 'PUT', url: '/api/sessions/s2/pinned', payload: { pinned: true } });
    const pinnedAt = rowOf('s2').pinned_at;
    db.update(sessions).set({ endedAt: 123 }).where(eq(sessions.id, 's2')).run();
    // s2 is inactive in the runner, so this goes down the revive path.
    await app.inject({
      method: 'POST', url: '/api/sessions/s2/messages', payload: { text: 'continue' },
    });
    const row = rowOf('s2');
    expect(row.ended_at).toBeNull();
    expect(row.pinned_at).toBe(pinnedAt);
  });

  // Pinned rows have to arrive with the first page whatever their age — the
  // sidebar's `offset: visible.length` paging depends on client accumulation
  // matching server order, so the ordering belongs in the SQL, not a re-sort.
  it('GET /api/sessions puts pinned rows first, in pin order, ahead of newer rows', async () => {
    db.insert(sessions)
      .values({ id: 's3', projectDir: 'p', cwd: '/w/z', title: 'newest', lastAt: 300, source: 'terminal' })
      .run();
    // s2 (lastAt 100) pinned first, s1 (lastAt 200) second: pin order, not age.
    await app.inject({ method: 'PUT', url: '/api/sessions/s2/pinned', payload: { pinned: true } });
    db.update(sessions).set({ pinnedAt: 1 }).where(eq(sessions.id, 's2')).run();
    db.update(sessions).set({ pinnedAt: 2 }).where(eq(sessions.id, 's1')).run();
    const listed = res200(await app.inject({ method: 'GET', url: '/api/sessions' }));
    expect(listed.sessions.map((s: any) => s.id)).toEqual(['s2', 's1', 's3']);
  });

  it('GET /api/sessions/:id carries pinnedAt on the wire', async () => {
    await app.inject({ method: 'PUT', url: '/api/sessions/s2/pinned', payload: { pinned: true } });
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s2' });
    expect(typeof res.json().session.pinnedAt).toBe('number');
  });
});

// The file viewer's read (spec 2026-09-19-file-viewer-design § Server). The
// seeded sessions carry fake cwds like /w/x, so these tests add a session
// whose cwd is a real tmpdir and put the fixtures there.
describe('GET /api/files', () => {
  let app: FastifyInstance;
  let cwd: string;

  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    cwd = mkdtempSync(join(tmpdir(), 'orbital-files-'));
    result.db
      .insert(sessions)
      .values({
        id: 'sf', projectDir: 'p', cwd, title: 'file viewer', lastAt: 300,
        source: 'web', permissionMode: null,
      })
      .run();
  });

  const get = (session: string, path?: string) =>
    app.inject({
      method: 'GET',
      url: `/api/files?session=${encodeURIComponent(session)}${
        path !== undefined ? `&path=${encodeURIComponent(path)}` : ''
      }`,
    });

  it('400s when session or path is missing or empty', async () => {
    for (const url of ['/api/files', '/api/files?session=sf', '/api/files?path=a.txt', '/api/files?session=sf&path=']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'missing_params' });
    }
  });

  it('404s an unknown session', async () => {
    const res = await get('nope', 'a.txt');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('200s a readable file with content, size, mtimeMs and lines', async () => {
    writeFileSync(join(cwd, 'notes.md'), '# hi\nsecond line');
    const res = await get('sf', 'notes.md');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ content: '# hi\nsecond line', lines: 2 });
    expect(body.size).toBe(Buffer.byteLength('# hi\nsecond line'));
    expect(body.mtimeMs).toBeTypeOf('number');
  });

  it('403s a path outside the session cwd', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'orbital-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    const res = await get('sf', join(outside, 'secret.txt'));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'outside_cwd' });
  });

  it('403s a ../ traversal shape — it never reaches a file', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'orbital-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    // A sibling tmpdir reached by climbing out of cwd.
    const res = await get('sf', `../${basename(outside)}/secret.txt`);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'outside_cwd' });
  });

  it('404s a file that is not on disk', async () => {
    const res = await get('sf', 'ghost.txt');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('413s a file over FILE_PREVIEW_MAX_BYTES, size measured', async () => {
    const size = FILE_PREVIEW_MAX_BYTES + 1;
    writeFileSync(join(cwd, 'big.log'), Buffer.alloc(size));
    const res = await get('sf', 'big.log');
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'too_large', size });
  });

  it('415s a binary file with its media type', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    writeFileSync(join(cwd, 'pic.png'), bytes);
    const res = await get('sf', 'pic.png');
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'binary', size: bytes.length, mediaType: 'image/png' });
  });

  it('treats a :line suffix as part of the path — the client strips it, not us', async () => {
    writeFileSync(join(cwd, 'a.ts'), 'x');
    // `a.ts:12` names nothing on disk; the server never parses it apart.
    const res = await get('sf', 'a.ts:12');
    expect(res.statusCode).toBe(404);
  });
});

// Tag clusters: a clump's home moves where the user drops it, per tag,
// persisted (agreed in chat 2026-09-18, extends spec § 2).
describe('tag anchors', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    ({ app } = makeApp());
  });

  it('PATCH /api/tags/:id stores an anchor and GET /api/tags returns it', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/tags/10', payload: { anchor_x: 12.5, anchor_y: -3.25 },
    });
    expect(res.statusCode).toBe(200);
    const tags = (await app.inject({ method: 'GET', url: '/api/tags' })).json().tags;
    const work = tags.find((t: { id: number }) => t.id === 10);
    expect(work.anchor_x).toBe(12.5);
    expect(work.anchor_y).toBe(-3.25);
  });

  it('PATCH /api/tags/:id with null anchors clears them (back to the automatic layout)', async () => {
    await app.inject({
      method: 'PATCH', url: '/api/tags/10', payload: { anchor_x: 1, anchor_y: 2 },
    });
    await app.inject({
      method: 'PATCH', url: '/api/tags/10', payload: { anchor_x: null, anchor_y: null },
    });
    const tags = (await app.inject({ method: 'GET', url: '/api/tags' })).json().tags;
    const work = tags.find((t: { id: number }) => t.id === 10);
    expect(work.anchor_x).toBeNull();
    expect(work.anchor_y).toBeNull();
  });

  it('rejects a non-finite anchor', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/tags/10', payload: { anchor_x: 'far', anchor_y: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('an anchor patch leaves name and hue alone', async () => {
    await app.inject({
      method: 'PATCH', url: '/api/tags/10', payload: { anchor_x: 5, anchor_y: 5 },
    });
    const tags = (await app.inject({ method: 'GET', url: '/api/tags' })).json().tags;
    expect(tags.find((t: { id: number }) => t.id === 10)).toMatchObject({ name: 'work', hue: 210 });
  });
});

// ---------------------------------------------------------------------------
// The composer: command catalog, path completion, attachments
// (spec: 2026-09-20-composer-design § Server)
// ---------------------------------------------------------------------------

describe('GET /api/commands', () => {
  /** Orbital answers `/rewind` itself, so every session lists it (spec 2026-09-29-rewind-design). */
  const REWIND = { name: 'rewind', description: 'Take the conversation back to before one of your messages', source: 'built-in' };
  /** And `/mcp`, which opens the MCP dialog (spec 2026-10-01-mcp-servers-in-the-session-design). */
  const MCP = { name: 'mcp', description: 'Servers for this session', source: 'built-in' };

  /** A command on disk, the flat `~/.claude/commands/<name>.md` shape. */
  function writeCommand(claudeDir: string, name: string, description: string) {
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(claudeDir, 'commands', `${name}.md`), `---\ndescription: ${description}\n---\nbody\n`);
  }

  it('400s when neither session nor cwd is given', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/commands' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'missing_params' });
  });

  it('a session with no live query gets the filesystem catalog alone — no built-ins', async () => {
    const { app, db, claudeDir } = makeApp();
    const cwd = mkdtempSync(join(tmpdir(), 'orbital-cmd-cwd-'));
    db.insert(sessions).values({ id: 'sc', projectDir: 'p', cwd, lastAt: 1, source: 'web' }).run();
    writeCommand(claudeDir, 'ship', 'ship it');
    mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'commands', 'deploy.md'), '---\ndescription: deploy\n---\n');

    const res = await app.inject({ method: 'GET', url: '/api/commands?session=sc' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      commands: [
        { name: 'deploy', description: 'deploy', source: 'project' },
        MCP, REWIND,
        { name: 'ship', description: 'ship it', source: 'user' },
      ],
    });
  });

  it('with a live query the SDK list is the truth; the scan only attributes source', async () => {
    const { app, db, runner, claudeDir } = makeApp();
    const cwd = mkdtempSync(join(tmpdir(), 'orbital-cmd-cwd-'));
    db.insert(sessions).values({ id: 'sc', projectDir: 'p', cwd, lastAt: 1, source: 'web' }).run();
    writeCommand(claudeDir, 'ship', 'ship it');
    // On disk but NOT in the SDK list: the CLI would not honour it, so it is
    // not offered.
    writeCommand(claudeDir, 'stale', 'left over');
    runner.commands = async () => [
      { name: 'ship', description: 'ship it' },
      { name: 'clear', description: 'Clear conversation history' },
      { name: 'usage', description: 'Show plan usage', aliases: ['cost'] },
    ];

    const res = await app.inject({ method: 'GET', url: '/api/commands?session=sc' });
    expect(res.json()).toEqual({
      commands: [
        { name: 'clear', description: 'Clear conversation history', source: 'built-in' },
        MCP, REWIND,
        { name: 'ship', description: 'ship it', source: 'user' },
        { name: 'usage', description: 'Show plan usage', source: 'built-in', aliases: ['cost'] },
      ],
    });
  });

  it('a description the CLI leaves empty falls back to the scanned one', async () => {
    const { app, db, runner, claudeDir } = makeApp();
    const cwd = mkdtempSync(join(tmpdir(), 'orbital-cmd-cwd-'));
    db.insert(sessions).values({ id: 'sc', projectDir: 'p', cwd, lastAt: 1, source: 'web' }).run();
    writeCommand(claudeDir, 'ship', 'ship it');
    runner.commands = async () => [{ name: 'ship', description: '' }];

    expect(res200(await app.inject({ method: 'GET', url: '/api/commands?session=sc' })).commands)
      .toEqual([MCP, REWIND, { name: 'ship', description: 'ship it', source: 'user' }]);
  });

  it('carries an argument hint through when the CLI gives one', async () => {
    const { app, db, runner } = makeApp();
    db.insert(sessions).values({ id: 'sc', projectDir: 'p', cwd: '/w', lastAt: 1, source: 'web' }).run();
    runner.commands = async () => [
      { name: 'add-dir', description: 'Add a directory', argumentHint: '<path>' },
    ];

    expect(res200(await app.inject({ method: 'GET', url: '/api/commands?session=sc' })).commands)
      .toEqual([
        { name: 'add-dir', description: 'Add a directory', source: 'built-in', argumentHint: '<path>' },
        MCP, REWIND,
      ]);
  });

  it('?cwd= answers for the dialog, which has no session yet, and expands ~', async () => {
    const { app, claudeDir } = makeApp();
    const cwd = mkdtempSync(join(homedir(), '.orbital-cmd-test-'));
    writeCommand(claudeDir, 'ship', 'ship it');
    mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'commands', 'deploy.md'), '');

    const res = await app.inject({
      method: 'GET', url: `/api/commands?cwd=${encodeURIComponent(`~/${basename(cwd)}`)}`,
    });
    expect(res.json().commands.map((c: any) => `${c.source}/${c.name}`)).toEqual([
      'project/deploy', 'user/ship',
    ]);
  });

  it('404s an unknown session', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/commands?session=nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});

describe('GET /api/commands/content', () => {
  function writeSkill(root: string, name: string, text: string) {
    mkdirSync(join(root, 'skills', name), { recursive: true });
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), text);
  }

  it("serves a session's project skill: header fields plus the body without frontmatter", async () => {
    const { app, db } = makeApp();
    const cwd = mkdtempSync(join(tmpdir(), 'orbital-cmd-cwd-'));
    db.insert(sessions).values({ id: 'sc', projectDir: 'p', cwd, lastAt: 1, source: 'web' }).run();
    writeSkill(join(cwd, '.claude'), 'deploy', '---\ndescription: ship to prod\n---\n\n# Deploy\nsteps\n');

    const res = await app.inject({ method: 'GET', url: '/api/commands/content?session=sc&name=deploy' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'deploy',
      source: 'project',
      path: join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'),
      description: 'ship to prod',
      body: '# Deploy\nsteps\n',
    });
  });

  it('resolves a user skill from a bare cwd, and accepts the name with its slash', async () => {
    const { app, claudeDir } = makeApp();
    writeSkill(claudeDir, 'ask', '---\ndescription: answer only\n---\nbody\n');

    const res = await app.inject({ method: 'GET', url: '/api/commands/content?cwd=/tmp&name=%2Fask' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'ask', source: 'user', body: 'body\n' });
  });

  it('404s a name the catalog does not list — a built-in, or a path', async () => {
    const { app, claudeDir } = makeApp();
    writeFileSync(join(claudeDir, 'settings.json'), '{}');
    for (const name of ['compact', '../settings.json', encodeURIComponent(join(claudeDir, 'settings.json'))]) {
      const res = await app.inject({ method: 'GET', url: `/api/commands/content?cwd=/tmp&name=${name}` });
      expect(res.statusCode).toBe(404);
    }
  });

  it('400s without a name', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/commands/content?cwd=/tmp' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/files/complete', () => {
  let app: FastifyInstance;
  let cwd: string;

  beforeEach(() => {
    const result = makeApp();
    app = result.app;
    cwd = mkdtempSync(join(tmpdir(), 'orbital-complete-'));
    result.db
      .insert(sessions)
      .values({ id: 'sf', projectDir: 'p', cwd, title: 'completion', lastAt: 1, source: 'web' })
      .run();
  });

  const complete = (query: string) =>
    app.inject({ method: 'GET', url: `/api/files/complete?${query}` });

  const names = async (query: string) => (await complete(query)).json().entries.map((e: any) => e.name);

  it('400s when neither session nor cwd is given', async () => {
    const res = await complete('prefix=s');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'missing_params' });
  });

  it('lists the project root for an empty prefix, directories first then files', async () => {
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'assets'));
    writeFileSync(join(cwd, 'README.md'), 'hi');
    writeFileSync(join(cwd, 'app.ts'), 'x');

    const res = await complete('session=sf&prefix=');
    expect(res.statusCode).toBe(200);
    // Alphabetical is locale-alphabetical, so `app.ts` sorts before
    // `README.md` rather than after every capital letter.
    expect(res.json().entries).toEqual([
      { name: 'assets', dir: true },
      { name: 'src', dir: true },
      { name: 'app.ts', dir: false, size: 1 },
      { name: 'README.md', dir: false, size: 2 },
    ]);
  });

  it('splits the prefix into directory and base, matching on the base', async () => {
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'composer.tsx'), 'x');
    writeFileSync(join(cwd, 'src', 'compare.ts'), 'x');
    writeFileSync(join(cwd, 'src', 'other.ts'), 'x');

    expect(await names('session=sf&prefix=src/comp')).toEqual(['compare.ts', 'composer.tsx']);
    // A trailing slash is "everything in here".
    expect(await names('session=sf&prefix=src/')).toEqual(['compare.ts', 'composer.tsx', 'other.ts']);
  });

  it('hides dotfiles unless the base starts with a dot', async () => {
    writeFileSync(join(cwd, '.env'), 'x');
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, 'visible.txt'), 'x');

    expect(await names('session=sf&prefix=')).toEqual(['visible.txt']);
    expect(await names('session=sf&prefix=.')).toEqual(['.claude', '.env']);
    expect(await names('session=sf&prefix=.e')).toEqual(['.env']);
  });

  it('caps the list at FILE_COMPLETE_MAX', async () => {
    for (let i = 0; i < FILE_COMPLETE_MAX + 10; i++) {
      writeFileSync(join(cwd, `f${String(i).padStart(3, '0')}.txt`), 'x');
    }
    const entries = (await complete('session=sf&prefix=f')).json().entries;
    expect(entries).toHaveLength(FILE_COMPLETE_MAX);
    // The cap takes the first of the sorted list, not an arbitrary slice.
    expect(entries[0].name).toBe('f000.txt');
  });

  it('a directory outside the sandbox is empty, never an error', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'orbital-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    for (const prefix of [join(outside, 'sec'), `../${basename(outside)}/sec`]) {
      const res = await complete(`session=sf&prefix=${encodeURIComponent(prefix)}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ entries: [] });
    }
  });

  it('a missing directory is empty, never an error', async () => {
    const res = await complete('session=sf&prefix=ghost/a');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [] });
  });

  it('a symlink out of the sandbox is empty — realpath decides', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'orbital-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(cwd, 'innocent'));
    expect((await complete('session=sf&prefix=innocent/')).json()).toEqual({ entries: [] });
  });

  it('404s an unknown session', async () => {
    const res = await complete('session=nope&prefix=a');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('?cwd= answers for the dialog', async () => {
    mkdirSync(join(cwd, 'src'));
    const res = await complete(`cwd=${encodeURIComponent(cwd)}&prefix=s`);
    expect(res.json().entries).toEqual([{ name: 'src', dir: true }]);
  });
});

describe('POST /api/sessions/:id/attachments', () => {
  /** A real PNG header, so what comes back is what the store would serve. */
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    (() => {
      const ihdr = Buffer.alloc(25);
      ihdr.writeUInt32BE(13, 0);
      ihdr.write('IHDR', 4);
      ihdr.writeUInt32BE(320, 8);
      ihdr.writeUInt32BE(200, 12);
      return ihdr;
    })(),
  ]);

  /** One multipart body with one file part, built by hand — this is the wire
   * shape the browser's FormData produces. */
  function multipartBody(
    filename: string,
    contentType: string,
    bytes: Buffer,
  ): { payload: Buffer; headers: Record<string, string> } {
    const boundary = '----orbitaltestboundary';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return {
      payload: Buffer.concat([head, bytes, tail]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  const upload = (app: FastifyInstance, id: string, filename: string, type: string, bytes: Buffer) => {
    const { payload, headers } = multipartBody(filename, type, bytes);
    return app.inject({ method: 'POST', url: `/api/sessions/${id}/attachments`, payload, headers });
  };

  it('201s with the ImageRefEntry, and the bytes are readable back out of the store', async () => {
    const { app, imageStore } = makeApp();
    const res = await upload(app, 's1', 'capture.png', 'image/png', png);
    expect(res.statusCode).toBe(201);
    const entry = res.json();
    expect(entry).toMatchObject({ w: 320, h: 200, bytes: png.length });
    expect(entry.ref).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(imageStore.read(entry.ref)).toEqual({
      mediaType: 'image/png', base64: png.toString('base64'),
    });
  });

  it('415s a file that is not an image the store will take, naming the type', async () => {
    const { app } = makeApp();
    const res = await upload(app, 's1', 'notes.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'not_image', mediaType: 'application/pdf' });
  });

  it('413s over ATTACHMENT_MAX_BYTES, with the measured size', async () => {
    const { app } = makeApp();
    const big = Buffer.concat([png, Buffer.alloc(ATTACHMENT_MAX_BYTES)]);
    const res = await upload(app, 's1', 'huge.png', 'image/png', big);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'too_large', size: big.length });
  });

  it('still 413s past the read wall, saying the size is not the whole file', async () => {
    // Far over the ceiling: the route stops reading rather than buffering
    // whatever was sent, so the size it reports is what it read, flagged.
    const { app } = makeApp();
    const res = await upload(
      app, 's1', 'enormous.png', 'image/png',
      Buffer.concat([png, Buffer.alloc(ATTACHMENT_MAX_BYTES * 3)]),
    );
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'too_large', truncated: true });
    expect(res.json().size).toBeLessThanOrEqual(ATTACHMENT_MAX_BYTES * 2);
  });

  it('404s an unknown session', async () => {
    const { app } = makeApp();
    const res = await upload(app, 'does-not-exist', 'capture.png', 'image/png', png);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('400s a request with no file part at all', async () => {
    const { app } = makeApp();
    const boundary = '----orbitaltestboundary';
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s1/attachments',
      payload: Buffer.from(`--${boundary}--\r\n`),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'missing_file' });
  });

  /**
   * The sessionless door the New Session dialog uploads through: the same
   * handler one route up, minus a lookup that never guarded anything (the store
   * is content-addressed and global — see the route's own comment).
   */
  describe('POST /api/attachments — before a session exists', () => {
    const uploadSessionless = (
      app: FastifyInstance,
      filename: string,
      type: string,
      bytes: Buffer,
    ) => {
      const { payload, headers } = multipartBody(filename, type, bytes);
      return app.inject({ method: 'POST', url: '/api/attachments', payload, headers });
    };

    it('201s with the same ImageRefEntry, with no session in sight', async () => {
      const { app, imageStore } = makeApp();
      const res = await uploadSessionless(app, 'flamegraph.png', 'image/png', png);
      expect(res.statusCode).toBe(201);
      const entry = res.json();
      expect(entry).toMatchObject({ w: 320, h: 200, bytes: png.length });
      expect(entry.ref).toMatch(/^[a-f0-9]{64}\.png$/);
      expect(imageStore.read(entry.ref)).toEqual({
        mediaType: 'image/png', base64: png.toString('base64'),
      });
    });

    it('refuses a non-image exactly as the scoped route does', async () => {
      const { app } = makeApp();
      const res = await uploadSessionless(app, 'notes.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
      expect(res.statusCode).toBe(415);
      expect(res.json()).toEqual({ error: 'not_image', mediaType: 'application/pdf' });
    });
  });
});

describe('attachments on the send paths', () => {
  const REF = `${'a'.repeat(64)}.png`;

  it('POST /api/sessions/:id/messages hands the refs to the runner', async () => {
    const { app, db, runner, sendCalls } = makeApp();
    db.insert(sessions).values({ id: 'sa', projectDir: 'p', cwd: '/w', lastAt: 1, source: 'web' }).run();
    runner.send = (id: string, text: string, attachments?: string[]) => {
      sendCalls.push({ id, text, attachments });
    };

    const res = await app.inject({
      method: 'POST', url: '/api/sessions/sa/messages',
      payload: { text: 'look', attachments: [REF] },
    });
    expect(res.statusCode).toBe(200);
    expect(sendCalls.at(-1)).toEqual({ id: 'sa', text: 'look', attachments: [REF] });
  });

  it('a revive carries them into start()', async () => {
    const { app, startCalls } = makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/s2/messages',
      payload: { text: 'wake up', attachments: [REF] },
    });
    expect(res.json()).toMatchObject({ revived: true });
    expect(startCalls.at(-1)).toMatchObject({ resume: 's2', prompt: 'wake up', attachments: [REF] });
  });

  it('POST /api/sessions carries them into the first turn', async () => {
    const { app, startCalls } = makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits', attachments: [REF] },
    });
    expect(res.statusCode).toBe(201);
    expect(startCalls.at(-1)).toMatchObject({ attachments: [REF] });
  });

  it('400s a ref that is not one the image store could have written', async () => {
    const { app, db } = makeApp();
    db.insert(sessions).values({ id: 'sa', projectDir: 'p', cwd: '/w', lastAt: 1, source: 'web' }).run();
    const bad = [
      '../../etc/passwd',
      `${'a'.repeat(64)}.svg`,
      'deadbeef.png',
      `${'A'.repeat(64)}.png`,
    ];
    for (const ref of bad) {
      const messages = await app.inject({
        method: 'POST', url: '/api/sessions/sa/messages', payload: { text: 'x', attachments: [ref] },
      });
      expect(messages.statusCode).toBe(400);
      expect(messages.json()).toEqual({ error: 'invalid_attachment' });

      const launch = await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: { cwd: '/p', prompt: 'go', permissionMode: 'plan', attachments: [ref] },
      });
      expect(launch.statusCode).toBe(400);
    }
  });

  it('400s attachments that are not an array of strings', async () => {
    const { app, db } = makeApp();
    db.insert(sessions).values({ id: 'sa', projectDir: 'p', cwd: '/w', lastAt: 1, source: 'web' }).run();
    for (const attachments of ['nope', [1], {}]) {
      const res = await app.inject({
        method: 'POST', url: '/api/sessions/sa/messages', payload: { text: 'x', attachments },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/decision/:decisionId
// (spec: 2026-09-20-interactive-decisions-design)
// ---------------------------------------------------------------------------

describe('the decision endpoint', () => {
  const QUESTION = {
    questions: [
      {
        question: 'Which library should we use?',
        header: 'Library',
        options: [
          { label: 'date-fns', description: 'small' },
          { label: 'luxon', description: 'complete' },
        ],
        multiSelect: false,
      },
      {
        question: 'Ship it behind a flag?',
        header: 'Rollout',
        options: [
          { label: 'Yes', description: 'safer' },
          { label: 'No', description: 'simpler' },
        ],
        multiSelect: false,
      },
    ],
  };
  const ANSWERS = {
    'Which library should we use?': 'luxon',
    'Ship it behind a flag?': 'Yes',
  };

  /** An app whose runner is parked on `QUESTION` for session s1. */
  function makeParkedApp() {
    const made = makeApp();
    const answered: any[] = [];
    made.runner.pendingDecision = (id: string) =>
      id === 's1' ? { id: 'tu-1', kind: 'question', input: QUESTION, createdAt: 1 } : null;
    made.runner.answerDecision = (id: string, decisionId: string, answers: Record<string, string>) => {
      answered.push({ id, decisionId, answers });
      return decisionId === 'tu-1';
    };
    return { ...made, answered };
  }

  const answer = (app: FastifyInstance, url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, payload: payload as any });

  it('answers the parked decision and hands the runner the whole set', async () => {
    const { app, answered } = makeParkedApp();
    const res = await answer(app, '/api/sessions/s1/decision/tu-1', { answers: ANSWERS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(answered).toEqual([{ id: 's1', decisionId: 'tu-1', answers: ANSWERS }]);
  });

  it('404s a session with nothing parked, known or not', async () => {
    const { app, answered } = makeParkedApp();
    for (const id of ['s2', 'never-heard-of-it']) {
      const res = await answer(app, `/api/sessions/${id}/decision/tu-1`, { answers: ANSWERS });
      expect(res.statusCode).toBe(404);
    }
    expect(answered).toEqual([]);
  });

  it('404s an id that is not the parked one — the loser of two open windows', async () => {
    const { app, answered } = makeParkedApp();
    const res = await answer(app, '/api/sessions/s1/decision/tu-0', { answers: ANSWERS });
    expect(res.statusCode).toBe(404);
    expect(answered).toEqual([]);
  });

  it('400s a body that is not a map of answer strings', async () => {
    const { app, answered } = makeParkedApp();
    for (const payload of [{}, { answers: 'luxon' }, { answers: ['luxon'] }, { answers: { a: 1 } }]) {
      const res = await answer(app, '/api/sessions/s1/decision/tu-1', payload);
      expect(res.statusCode).toBe(400);
    }
    expect(answered).toEqual([]);
  });

  it('400s an answer set that misses a question', async () => {
    const { app, answered } = makeParkedApp();
    const res = await answer(app, '/api/sessions/s1/decision/tu-1', {
      answers: { 'Which library should we use?': 'luxon' },
    });
    expect(res.statusCode).toBe(400);
    // Nothing half-answered reaches the model.
    expect(answered).toEqual([]);
  });

  it('400s a verdict posted at a parked question', async () => {
    // A client one version ahead (or confused) must not be able to approve a
    // question, which would reach the model as an empty answers map.
    const { app, answered } = makeParkedApp();
    const res = await answer(app, '/api/sessions/s1/decision/tu-1', { approved: true });
    expect(res.statusCode).toBe(400);
    expect(answered).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The other two kinds (spec: 2026-09-23-permission-and-plan-decisions-design)
  // -------------------------------------------------------------------------

  /** An app whose runner is parked on a verdict-shaped decision for s1. */
  function makeVerdictApp(kind: 'permission' | 'plan') {
    const made = makeApp();
    const answered: any[] = [];
    made.runner.pendingDecision = (id: string) =>
      id === 's1'
        ? { id: 'tu-1', kind, toolName: 'Bash', input: { command: 'ls' }, createdAt: 1 }
        : null;
    made.runner.answerDecision = (id: string, decisionId: string, a: unknown) => {
      answered.push({ id, decisionId, answer: a });
      return decisionId === 'tu-1';
    };
    return { ...made, answered };
  }

  for (const kind of ['permission', 'plan'] as const) {
    it(`approves a parked ${kind} decision`, async () => {
      const { app, answered } = makeVerdictApp(kind);
      const res = await answer(app, '/api/sessions/s1/decision/tu-1', { approved: true });
      expect(res.statusCode).toBe(200);
      expect(answered).toEqual([
        { id: 's1', decisionId: 'tu-1', answer: { approved: true } },
      ]);
    });

    it(`declines a parked ${kind} decision with a reason`, async () => {
      const { app, answered } = makeVerdictApp(kind);
      const res = await answer(app, '/api/sessions/s1/decision/tu-1', {
        approved: false,
        message: 'do it the other way',
      });
      expect(res.statusCode).toBe(200);
      expect(answered).toEqual([
        {
          id: 's1',
          decisionId: 'tu-1',
          answer: { approved: false, message: 'do it the other way' },
        },
      ]);
    });

    it(`400s a body that is not a verdict on a ${kind} decision`, async () => {
      const { app, answered } = makeVerdictApp(kind);
      for (const payload of [
        {},
        { answers: { a: 'b' } },
        { approved: 'yes' },
        { approved: true, message: 7 },
      ]) {
        const res = await answer(app, '/api/sessions/s1/decision/tu-1', payload);
        expect(res.statusCode).toBe(400);
      }
      expect(answered).toEqual([]);
    });

    it(`404s a ${kind} verdict for an id that is not the parked one`, async () => {
      const { app, answered } = makeVerdictApp(kind);
      const res = await answer(app, '/api/sessions/s1/decision/tu-0', { approved: true });
      expect(res.statusCode).toBe(404);
      expect(answered).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Retention (spec 2026-09-21-settings-sections-design § 4)
// ---------------------------------------------------------------------------

describe('retention', () => {
  const DAY = 86_400_000;

  function seedAges(db: OrbitalDb) {
    db.delete(sessions).run();
    db.insert(sessions)
      .values([
        { id: 'ancient', projectDir: 'p', lastAt: Date.now() - 400 * DAY },
        { id: 'old', projectDir: 'p', lastAt: Date.now() - 100 * DAY },
        { id: 'fresh', projectDir: 'p', lastAt: Date.now() - DAY },
        { id: 'kept', projectDir: 'p', lastAt: Date.now() - 100 * DAY, pinnedAt: Date.now() },
      ])
      .run();
  }

  it('previews a policy without applying it', async () => {
    const { app, db } = makeApp();
    seedAges(db);

    const res = await app.inject({ url: '/api/sessions/retention-preview?days=30' });
    expect(res.json()).toEqual({ count: 2 }); // ancient + old; `kept` is pinned
    // A preview must not be a delete.
    expect(db.select().from(sessions).all()).toHaveLength(4);

    expect((await app.inject({ url: '/api/sessions/retention-preview?days=365' })).json())
      .toEqual({ count: 1 });
    // The off switch previews as nothing, which is what the dialog needs to
    // know not to ask for confirmation.
    expect((await app.inject({ url: '/api/sessions/retention-preview?days=never' })).json())
      .toEqual({ count: 0 });
    expect((await app.inject({ url: '/api/sessions/retention-preview' })).json())
      .toEqual({ count: 0 });
  });

  /**
   * The dialog confirms "this will drop N sessions" and then saves, so the
   * save has to be when it happens. Deferring to the next boot would turn
   * that confirmation into a promise about some later restart.
   */
  it('sweeps on the PATCH that sets it', async () => {
    const { app, db } = makeApp();
    seedAges(db);

    await app.inject({
      method: 'PATCH', url: '/api/settings', payload: { delete_sessions_older_than_days: '30' },
    });

    const left = db.select({ id: sessions.id }).from(sessions).all().map((r) => r.id).sort();
    expect(left).toEqual(['fresh', 'kept']);
    // The value is persisted too, so the boot sweep honours it next time.
    expect(
      db.select({ value: settingsTable.value }).from(settingsTable)
        .where(eq(settingsTable.key, 'delete_sessions_older_than_days')).get()?.value,
    ).toBe('30');
  });

  it('deletes nothing when the setting is turned off again', async () => {
    const { app, db } = makeApp();
    seedAges(db);
    await app.inject({
      method: 'PATCH', url: '/api/settings', payload: { delete_sessions_older_than_days: 'never' },
    });
    expect(db.select().from(sessions).all()).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Stats API: GET /api/stats/overview and GET /api/stats/sessions/:id
// Spec: docs/superpowers/specs/2026-09-20-session-stats-design.md § API
// ---------------------------------------------------------------------------

function insertStatsSession(db: any, row: { id: string } & Partial<Record<string, unknown>>) {
  db.insert(sessions)
    .values({
      projectDir: 'p', cwd: '/w', title: row.id, source: 'terminal', lastAt: Date.now(),
      ...row,
    })
    .run();
}

/** A `session_stats` row with every column zeroed except what the test overrides. */
function insertRollup(db: any, sessionId: string, overrides: Partial<Record<string, unknown>> = {}) {
  db.insert(sessionStats)
    .values({
      sessionId,
      apiMs: 0, localToolMs: 0, mcpMs: 0, subagentMs: 0, turns: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, thinkingTokens: 0, subagentTokens: 0,
      subagentUsage: {}, toolCalls: 0, toolErrors: 0, toolBreakdown: {}, findings: [],
      statsVersion: 1,
      ...overrides,
    })
    .run();
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('GET /api/stats/overview', () => {
  it('defaults to the 7d window and echoes the applied filters', async () => {
    const { app, db } = makeApp();
    insertStatsSession(db, {
      id: 'a', projectDir: 'proj', resolvedModel: 'claude-sonnet-5', lastAt: Date.now() - 1000,
    });
    insertRollup(db, 'a');
    const res = await app.inject({ method: 'GET', url: '/api/stats/overview' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.filters).toEqual({ window: '7d', project: null, model: null });
    expect(body.sessionCount).toBe(1);
    expect(body.totals.sessionCount).toBe(1);
    // A same-length previous window exists for every window but 'all'.
    expect(body.previousTotals).not.toBeNull();
    expect(typeof body.costDeltaPct).toBe('number');
  });

  it('400s an invalid window value rather than silently defaulting', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/stats/overview?window=9d' });
    expect(res.statusCode).toBe(400);
  });

  it('filters by window, project and model — each excludes non-matching rows from every panel', async () => {
    const { app, db } = makeApp();
    const now = Date.now();
    insertStatsSession(db, { id: 'in', projectDir: 'proj-a', resolvedModel: 'claude-sonnet-5', lastAt: now - 1000 });
    insertRollup(db, 'in');
    // Outside the 7d window.
    insertStatsSession(db, { id: 'old', projectDir: 'proj-a', resolvedModel: 'claude-sonnet-5', lastAt: now - 8 * DAY_MS });
    insertRollup(db, 'old');
    insertStatsSession(db, { id: 'otherProject', projectDir: 'proj-b', resolvedModel: 'claude-sonnet-5', lastAt: now - 1000 });
    insertRollup(db, 'otherProject');
    insertStatsSession(db, { id: 'otherModel', projectDir: 'proj-a', resolvedModel: 'claude-haiku-4-5', lastAt: now - 1000 });
    insertRollup(db, 'otherModel');

    const all = await app.inject({ method: 'GET', url: '/api/stats/overview?window=7d' });
    expect(all.json().sessionCount).toBe(3); // every session but 'old'

    const byProject = await app.inject({ method: 'GET', url: '/api/stats/overview?window=7d&project=proj-a' });
    expect(byProject.json().sessionCount).toBe(2); // 'in' and 'otherModel'

    const byModel = await app.inject({ method: 'GET', url: '/api/stats/overview?window=7d&model=claude-sonnet-5' });
    expect(byModel.json().sessionCount).toBe(2); // 'in' and 'otherProject'

    const byBoth = await app.inject({
      method: 'GET', url: '/api/stats/overview?window=7d&project=proj-a&model=claude-sonnet-5',
    });
    expect(byBoth.json().sessionCount).toBe(1); // 'in' only
  });

  it('derives cost from the shipped pricing table and computes the prev-window delta; "all" has none', async () => {
    const { app, db } = makeApp();
    const now = Date.now();
    // Current 7d window: two Sonnet sessions, 1,000,000 uncached input tokens
    // each — SONNET_CURRENT.input is $2/million, so $2.00 apiece.
    insertStatsSession(db, { id: 'cur1', resolvedModel: 'claude-sonnet-5', lastAt: now - DAY_MS });
    insertRollup(db, 'cur1', { inputTokens: 1_000_000 });
    insertStatsSession(db, { id: 'cur2', resolvedModel: 'claude-sonnet-5', lastAt: now - 2 * DAY_MS });
    insertRollup(db, 'cur2', { inputTokens: 1_000_000 });
    // Previous 7d window (7-14 days back): one session, 500,000 tokens -> $1.00.
    insertStatsSession(db, { id: 'prev1', resolvedModel: 'claude-sonnet-5', lastAt: now - 10 * DAY_MS });
    insertRollup(db, 'prev1', { inputTokens: 500_000 });

    const res = await app.inject({ method: 'GET', url: '/api/stats/overview?window=7d' });
    const body = res.json();
    expect(body.totals.costTotal).toBeCloseTo(4.0, 6);
    expect(body.previousTotals.costTotal).toBeCloseTo(1.0, 6);
    expect(body.costDeltaPct).toBeCloseTo(300, 6); // (4 - 1) / 1 * 100

    const allRes = await app.inject({ method: 'GET', url: '/api/stats/overview?window=all' });
    const allBody = allRes.json();
    expect(allBody.previousTotals).toBeNull();
    expect(allBody.costDeltaPct).toBeNull();
    expect(allBody.sessionCount).toBe(3); // every session, regardless of window
  });

  it('merges per-session findings with derived slow-mcp and RESOLVED entries, newest first', async () => {
    const { app, db } = makeApp();
    const now = Date.now();

    // A stored per-session finding: cache-burn, tiny uncached spend -> WARNING.
    const cacheBurnFinding: Finding = {
      rule: 'cache-burn',
      evidence: { hitRatio: 0.1, uncachedInputTokens: 1000, turnsAffected: 3, totalTurns: 10, firstTurnUuid: 'u1' },
    };
    insertStatsSession(db, { id: 'burn', title: 'burny', resolvedModel: 'claude-sonnet-5', lastAt: now - 1 * DAY_MS });
    insertRollup(db, 'burn', { findings: [cacheBurnFinding] });

    // A window-wide slow-mcp finding: one MCP tool, 10 calls (SLOW_MCP_MIN_CALLS),
    // every call landing in the [16s, 32s) bucket so p50 clears SLOW_MCP_P50_MS.
    const buckets = new Array(10).fill(0);
    buckets[7] = 10;
    insertStatsSession(db, { id: 'slow', resolvedModel: 'claude-sonnet-5', lastAt: now - 2 * DAY_MS });
    insertRollup(db, 'slow', {
      mcpMs: 200_000,
      toolBreakdown: { 'mcp__docs__search': { calls: 10, errors: 0, ms: 200_000, resultChars: 10, buckets } },
    });

    // A RESOLVED error-loop: fired 6 days ago, then 5 clean sessions after it,
    // all still inside the 7d window — RESOLVED_CLEAN_SESSIONS is 5.
    const errorLoopFinding: Finding = {
      rule: 'error-loop',
      evidence: { tool: 'Bash', count: 6, firstTurnUuid: 'u2', lastTurnUuid: 'u3' },
    };
    insertStatsSession(db, {
      id: 'fired', title: 'fired-session', resolvedModel: 'claude-sonnet-5', lastAt: now - 6 * DAY_MS,
    });
    insertRollup(db, 'fired', { findings: [errorLoopFinding] });
    for (let i = 0; i < 5; i++) {
      insertStatsSession(db, {
        id: `clean-${i}`, resolvedModel: 'claude-sonnet-5', lastAt: now - (5 - i) * DAY_MS,
      });
      insertRollup(db, `clean-${i}`);
    }

    const res = await app.inject({ method: 'GET', url: '/api/stats/overview?window=7d' });
    const findings = res.json().findings;

    const burn = findings.find((f: any) => f.rule === 'cache-burn');
    expect(burn).toMatchObject({ severity: 'warning', sessionId: 'burn', title: 'burny' });

    const slow = findings.find((f: any) => f.rule === 'slow-mcp');
    expect(slow).toMatchObject({ severity: 'info', sessionId: null, title: null });
    expect(slow.evidence.tool).toBe('mcp__docs__search');

    // Exactly one card for the resolved rule — RESOLVED is a state the
    // original firing moves into, not a second card next to it.
    const errorLoopEntries = findings.filter((f: any) => f.rule === 'error-loop');
    expect(errorLoopEntries).toHaveLength(1);
    expect(errorLoopEntries[0]).toMatchObject({ severity: 'resolved', sessionId: 'fired', title: 'fired-session' });

    const whens = findings.map((f: any) => f.when);
    expect(whens).toEqual([...whens].sort((a: number, b: number) => b - a));
  });

  // Regression: resolvedRules reports only the LAST firing of a rule in the
  // window. Suppressing every stored finding for that rule (keyed on rule
  // alone) would silently delete an EARLIER session's real CRITICAL card
  // along with it. The suppression must be keyed on rule + the resolving
  // session's own id, so an earlier firing survives as its own card and only
  // the resolving session's firing is replaced by RESOLVED.
  it('RESOLVED replaces only the resolving session\'s card — an earlier firing of the same rule survives', async () => {
    const { app, db } = makeApp();
    const now = Date.now();
    const earlyFiring: Finding = {
      rule: 'error-loop',
      evidence: { tool: 'Bash', count: 6, firstTurnUuid: 'e1', lastTurnUuid: 'e2' },
    };
    const lateFiring: Finding = {
      rule: 'error-loop',
      evidence: { tool: 'Write', count: 7, firstTurnUuid: 'l1', lastTurnUuid: 'l2' },
    };
    // The rule fires twice: an earlier session, then a later one. Only the
    // later one has a clean tail long enough (5) to resolve within the 7d
    // window.
    insertStatsSession(db, {
      id: 'fired-early', title: 'early firing', resolvedModel: 'claude-sonnet-5', lastAt: now - 6.5 * DAY_MS,
    });
    insertRollup(db, 'fired-early', { findings: [earlyFiring] });
    insertStatsSession(db, {
      id: 'fired-late', title: 'late firing', resolvedModel: 'claude-sonnet-5', lastAt: now - 6 * DAY_MS,
    });
    insertRollup(db, 'fired-late', { findings: [lateFiring] });
    for (let i = 0; i < 5; i++) {
      insertStatsSession(db, {
        id: `clean2-${i}`, resolvedModel: 'claude-sonnet-5', lastAt: now - (5 - i) * DAY_MS,
      });
      insertRollup(db, `clean2-${i}`);
    }

    const res = await app.inject({ method: 'GET', url: '/api/stats/overview?window=7d' });
    const findings = res.json().findings;
    const errorLoopEntries = findings.filter((f: any) => f.rule === 'error-loop');

    // Two cards: the earlier firing stays a live CRITICAL card, the later
    // (resolving) one becomes the single RESOLVED card.
    expect(errorLoopEntries).toHaveLength(2);
    const earlyCard = errorLoopEntries.find((f: any) => f.sessionId === 'fired-early');
    expect(earlyCard).toMatchObject({ severity: 'critical', sessionId: 'fired-early', title: 'early firing' });
    const lateCard = errorLoopEntries.find((f: any) => f.sessionId === 'fired-late');
    expect(lateCard).toMatchObject({ severity: 'resolved', sessionId: 'fired-late', title: 'late firing' });
  });
});

describe('GET /api/stats/sessions/:id', () => {
  it('404s for an unknown session', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/stats/sessions/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('returns the stored rollup, a costOf breakdown, severity-resolved findings and session meta', async () => {
    const { app, db } = makeApp();
    const finding: Finding = {
      rule: 'obese-tool-result',
      evidence: { tool: 'Read', chars: 200_000, estimatedTokens: 50_000, toolUseId: 't1', turnUuid: 'u1' },
    };
    insertStatsSession(db, {
      id: 'sX', title: 'session x', projectDir: 'proj', cwd: '/w/x',
      model: 'sonnet', resolvedModel: 'claude-sonnet-5', firstAt: 1000, lastAt: 5000,
    });
    insertRollup(db, 'sX', {
      inputTokens: 1_000_000, turns: 4,
      subagentUsage: {
        'claude-haiku-4-5': {
          input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0,
        },
      },
      findings: [finding],
    });

    const res = await app.inject({ method: 'GET', url: '/api/stats/sessions/sX' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.session).toMatchObject({
      id: 'sX', title: 'session x', projectDir: 'proj', model: 'sonnet',
      resolvedModel: 'claude-sonnet-5', firstAt: 1000, lastAt: 5000, turns: 4,
    });
    // Sonnet input is $2/million, 1,000,000 uncached input tokens.
    expect(body.cost.uncachedInput).toBeCloseTo(2.0, 6);
    expect(body.cost.mainTotal).toBeCloseTo(2.0, 6);
    // Subagent priced at Haiku's own rate ($1/million), not Sonnet's (Ruling 11).
    expect(body.cost.subagentTotal).toBeCloseTo(1.0, 6);
    expect(body.cost.total).toBeCloseTo(3.0, 6);

    expect(body.findings).toEqual([{ rule: 'obese-tool-result', severity: 'warning', evidence: finding.evidence }]);
    expect(body.rollup.inputTokens).toBe(1_000_000);
  });

  it('a session with no session_stats row yet answers with an empty rollup, not a 404', async () => {
    const { app, db } = makeApp();
    insertStatsSession(db, { id: 'fresh', title: '', projectDir: '', lastAt: Date.now() });
    const res = await app.inject({ method: 'GET', url: '/api/stats/sessions/fresh' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rollup.turns).toBe(0);
    expect(body.findings).toEqual([]);
    expect(body.cost.total).toBe(0);
    expect(body.turns).toEqual([]);
  });

  /** A one-turn transcript on disk for `sY`, so a `?timeline=1` read has something to recompute. */
  function makeTranscriptApp() {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-stats-projects-'));
    const pdir = join(dir, 'proj');
    mkdirSync(pdir, { recursive: true });
    const sessionId = 'sY';
    const T0 = Date.parse('2026-09-20T10:00:00.000Z');
    const lines = [
      { type: 'user', uuid: 'h1', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'go' } },
      {
        type: 'assistant', uuid: 'a1', timestamp: new Date(T0 + 500).toISOString(), requestId: 'req-1',
        message: {
          role: 'assistant', model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ];
    writeFileSync(join(pdir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));

    const { app, db } = makeApp({ projectsDir: dir });
    insertStatsSession(db, { id: sessionId, projectDir: 'proj', lastAt: T0 + 500 });
    insertRollup(db, sessionId, { turns: 1 });
    return { app, sessionId };
  }

  it('reads the transcript on demand for the turn waterfall when ?timeline=1 (Ruling 7: main file + subagents)', async () => {
    const { app, sessionId } = makeTranscriptApp();

    const res = await app.inject({ method: 'GET', url: `/api/stats/sessions/${sessionId}?timeline=1` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.turns).toHaveLength(1);
    // The uuid is what a finding names its turn by, so it has to survive the
    // wire, not only the compute (ADR `a-rule-names-its-turn-by-uuid`).
    expect(body.turns[0]).toMatchObject({ requestId: 'req-1', uuid: 'a1' });
  });

  it('omits the timeline without the flag, so the readout row never pays for the reparse', async () => {
    const { app, sessionId } = makeTranscriptApp();

    // The transcript is on disk and would parse to one turn — but the row that
    // reads on every `stats` event never draws the waterfall, so the default
    // read must not recompute it (ADR
    // `the-stats-row-reads-when-the-stats-are-written`, "What remains").
    const res = await app.inject({ method: 'GET', url: `/api/stats/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().turns).toEqual([]);
  });

  it('a session that never got a transcript file answers with an empty timeline, not a 500', async () => {
    const { app, db } = makeApp();
    insertStatsSession(db, { id: 'noFile', projectDir: 'proj', lastAt: Date.now() });
    insertRollup(db, 'noFile');
    // With the flag on, so the missing file exercises the graceful catch, not
    // the "row did not ask for a timeline" path.
    const res = await app.inject({ method: 'GET', url: '/api/stats/sessions/noFile?timeline=1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().turns).toEqual([]);
  });
});

describe('stats API — human wait', () => {
  const buckets = () => new Array(HIST_BUCKET_COUNT).fill(0);
  const stat = (calls: number, ms: number) => ({ calls, errors: 0, ms, resultChars: 0, buckets: buckets() });

  it("reads permissionTimed off the session's source, and counts permissions in timed sessions only", async () => {
    const { app, db } = makeApp();
    const lastAt = Date.now() - 1000;
    insertStatsSession(db, { id: 'orb', source: 'web', lastAt });
    insertRollup(db, 'orb', { humanWaitMs: 700, permissionBreakdown: { Bash: stat(2, 700) } });
    insertStatsSession(db, { id: 'term', source: 'terminal', lastAt });
    insertRollup(db, 'term', { humanWaitMs: 50, humanBreakdown: { AskUserQuestion: stat(1, 50) } });

    const overview = (await app.inject({ method: 'GET', url: '/api/stats/overview' })).json();
    expect(overview.totals).toMatchObject({
      humanWaitMs: 750, questionCount: 1, permissionCount: 2, timedSessionCount: 1,
    });
    expect(overview.toolLeaderboard.human.map((r: { tool: string }) => r.tool)).toEqual(['AskUserQuestion', 'permission']);

    const orb = (await app.inject({ method: 'GET', url: '/api/stats/sessions/orb' })).json();
    const term = (await app.inject({ method: 'GET', url: '/api/stats/sessions/term' })).json();
    expect(orb.rollup).toMatchObject({ permissionTimed: true, humanWaitMs: 700 });
    expect(term.rollup.permissionTimed).toBe(false);
  });

  it("cuts a recorded wait out of the drilldown's timeline", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-stats-wait-'));
    mkdirSync(join(dir, 'proj'), { recursive: true });
    const T0 = Date.parse('2026-09-20T10:00:00.000Z');
    const lines = [
      {
        type: 'assistant', uuid: 'a1', timestamp: new Date(T0).toISOString(), requestId: 'req-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: {} }] },
      },
      {
        type: 'user', uuid: 'r1', parentUuid: 'a1', timestamp: new Date(T0 + 10_000).toISOString(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-bash', content: 'ok' }] },
      },
    ];
    writeFileSync(join(dir, 'proj', 'sW.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
    const { app, db } = makeApp({ projectsDir: dir });
    insertStatsSession(db, { id: 'sW', projectDir: 'proj', source: 'web', lastAt: T0 + 10_000 });
    recordPermissionWait(db, 'sW', {
      toolUseId: 'tu-bash', agentToolUseId: null, toolName: 'Bash',
      shownAt: T0 + 1_000, answeredAt: T0 + 7_000, outcome: 'allowed',
    });

    const body = (await app.inject({ method: 'GET', url: '/api/stats/sessions/sW?timeline=1' })).json();
    expect(body.turns[0].tools[0]).toMatchObject({ name: 'Bash', ms: 4_000, waitMs: 6_000 });
  });
});

describe('GET /api/sessions/:id/ide/open-files', () => {
  /**
   * An editor open on one directory. The socket is the one part of the bridge
   * a test cannot own, so it is injected; `ideStore.test.ts` covers the store
   * itself, and these tests cover what the route does with its answers.
   */
  function ideOn(workspace: string, answer: string | null) {
    const claudeDir = mkdtempSync(join(tmpdir(), 'orbital-ide-route-'));
    mkdirSync(join(claudeDir, 'ide'), { recursive: true });
    writeFileSync(
      join(claudeDir, 'ide', '60108.lock'),
      JSON.stringify({ workspaceFolders: [workspace], ideName: 'WebStorm', authToken: 't' }),
    );
    const connection = Object.assign(new EventEmitter(), {
      hasTool: () => answer !== null,
      callTool: async () => answer,
      callToolContent: async () => (answer === null ? null : [{ type: 'text', text: answer }]),
      close: () => {},
    });
    const ide = new IdeStore({ claudeDir, watch: false, connect: () => connection });
    ide.start();
    connection.emit('ready', []);
    return ide;
  }

  it('lists the editor tabs that lie inside the session cwd', async () => {
    const { app } = makeApp({ ide: ideOn('/w/x', '/w/x/src/a.ts\n/w/y/b.ts\n') });
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/ide/open-files' });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toEqual(['/w/x/src/a.ts']);
  });

  it('404s for a session the editor does not have open, and for an unknown id', async () => {
    const { app } = makeApp({ ide: ideOn('/w/x', '/w/x/src/a.ts') });
    // s2 sits in /w/y, which this editor does not have open.
    const other = await app.inject({ method: 'GET', url: '/api/sessions/s2/ide/open-files' });
    expect(other.statusCode).toBe(404);
    const unknown = await app.inject({ method: 'GET', url: '/api/sessions/nope/ide/open-files' });
    expect(unknown.statusCode).toBe(404);
  });

  it('404s when the editor has no such tool, and when there is no editor at all', async () => {
    const { app: noTool } = makeApp({ ide: ideOn('/w/x', null) });
    expect(
      (await noTool.inject({ method: 'GET', url: '/api/sessions/s1/ide/open-files' })).statusCode,
    ).toBe(404);
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/ide/open-files' });
    expect(res.statusCode).toBe(404);
  });

  // The two routes that talk back (spec § Talking back to the editor). Both
  // answer 404 for every kind of "no editor", which is the one thing the
  // caller has to handle.

  it('opens a path in the editor, and 204s because nothing came back', async () => {
    const { app } = makeApp({ ide: ideOn('/w/x', 'ok') });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/ide/open-file',
      payload: { path: '/w/x/src/a.ts', line: 88 },
    });
    expect(res.statusCode).toBe(204);
  });

  it('refuses to open a path outside the session cwd', async () => {
    const { app } = makeApp({ ide: ideOn('/w/x', 'ok') });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/ide/open-file',
      payload: { path: '/w/y/secret.ts' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s a request with no path, and 404s one with no editor', async () => {
    const { app } = makeApp({ ide: ideOn('/w/x', 'ok') });
    const noPath = await app.inject({
      method: 'POST', url: '/api/sessions/s1/ide/open-file', payload: {},
    });
    expect(noPath.statusCode).toBe(400);
    const { app: bare } = makeApp();
    const noEditor = await bare.inject({
      method: 'POST',
      url: '/api/sessions/s1/ide/open-file',
      payload: { path: '/w/x/src/a.ts' },
    });
    expect(noEditor.statusCode).toBe(404);
  });

  it('answers the editor’s findings, filtered to the session cwd', async () => {
    const answer = JSON.stringify([
      { uri: 'file:///w/x/src/a.ts', diagnostics: [{ message: 'boom', severity: 'Error' }] },
      { uri: 'file:///w/y/b.ts', diagnostics: [{ message: 'not ours', severity: 'Error' }] },
    ]);
    const { app } = makeApp({ ide: ideOn('/w/x', answer) });
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/ide/diagnostics' });
    expect(res.statusCode).toBe(200);
    expect(res.json().diagnostics).toEqual([
      { filePath: '/w/x/src/a.ts', line: 1, severity: 'error', message: 'boom', source: null },
    ]);
  });

  it('404s diagnostics with no editor, and for an unknown session', async () => {
    const { app } = makeApp();
    expect(
      (await app.inject({ method: 'GET', url: '/api/sessions/s1/ide/diagnostics' })).statusCode,
    ).toBe(404);
    const { app: withIde } = makeApp({ ide: ideOn('/w/x', '[]') });
    expect(
      (await withIde.inject({ method: 'GET', url: '/api/sessions/nope/ide/diagnostics' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('walkthrough routes', () => {
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  const transcript =
    line({ type: 'user', uuid: 'u1', timestamp: '2026-09-09T14:00:00.000Z', message: { role: 'user', content: 'add margin' } }) +
    line({ type: 'assistant', uuid: 'a1', timestamp: '2026-09-09T14:00:05.000Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Adding a margin.' }, { type: 'tool_use', id: 'toolu_E1', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' } }] } }) +
    line({ type: 'user', uuid: 'u2', timestamp: '2026-09-09T14:00:06.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_E1', content: 'ok' }] } });

  function appWithTranscript(source: 'web' | 'terminal' = 'web', narrateQueryFn?: NarrateQueryFn) {
    const projectsDir = mkdtempSync(join(tmpdir(), 'orbital-wt-routes-'));
    mkdirSync(join(projectsDir, 'p'), { recursive: true });
    writeFileSync(join(projectsDir, 'p', 'w1.jsonl'), transcript);
    const made = makeApp({ projectsDir, narrateQueryFn });
    made.db.insert(sessions).values({ id: 'w1', projectDir: 'p', cwd: '/w/z', title: 'wt', lastAt: 300, source, permissionMode: 'acceptEdits' }).run();
    return made;
  }

  it('GET /walkthrough returns the spine with the session', async () => {
    const { app } = appWithTranscript();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/w1/walkthrough' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session.id).toBe('w1');
    expect(body.walkthrough.steps).toHaveLength(1);
    expect(body.walkthrough.steps[0]).toMatchObject({ id: 'toolu_E1', narration: 'Adding a margin.' });
  });

  it('GET /walkthrough 404s an unknown session and is empty for a row without a file', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nope/walkthrough' })).statusCode).toBe(404);
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/walkthrough' });
    expect(res.statusCode).toBe(200);
    expect(res.json().walkthrough.steps).toEqual([]);
  });

  it('GET /walkthrough/summary counts', async () => {
    const { app } = appWithTranscript();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/w1/walkthrough/summary' });
    expect(res.json()).toEqual({ steps: 1, files: 1, blindAlleys: 0, subagents: 0 });
  });

  /** A narrate query that yields `frames` — or throws, when handed an Error. */
  const scripted = (frames: unknown[] | Error): NarrateQueryFn => () => (async function* () {
    if (frames instanceof Error) throw frames;
    yield* frames;
  })();
  const answered = (text: string) => [
    { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: text },
  ];
  const NARRATION = '```json\n{"intents":[{"title":"Margin","summary":"Adds a margin.","steps":["toolu_E1"]}]}\n```';

  async function narrated(app: FastifyInstance) {
    const res = await app.inject({ method: 'POST', url: '/api/sessions/w1/walkthrough/narrate' });
    expect(res.statusCode).toBe(202);
    let w: any;
    await vi.waitFor(async () => {
      w = (await app.inject({ method: 'GET', url: '/api/sessions/w1/walkthrough' })).json().walkthrough;
      expect(w.narrationPending).toBe(false);
    });
    return w;
  }

  it('POST narrate answers 202 at once, goes pending, sends nothing into the session, and lands the narration', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const prompts: string[] = [];
    const { app, sendCalls, startCalls, hub } = appWithTranscript('web', ({ prompt }) => (async function* () {
      prompts.push(prompt);
      await held;
      yield* answered(NARRATION);
    })());
    const events = subscribeFake(hub, 'session:w1');
    const res = await app.inject({ method: 'POST', url: '/api/sessions/w1/walkthrough/narrate' });
    expect(res.statusCode).toBe(202);
    const pending = (await app.inject({ method: 'GET', url: '/api/sessions/w1/walkthrough' })).json().walkthrough;
    expect(pending).toMatchObject({ narration: null, narrationPending: true, narrationFailed: false });
    expect(sendCalls).toEqual([]);
    expect(startCalls).toEqual([]);
    expect(prompts[0]).toContain('STEP 1 · id toolu_E1 · src/a.ts');

    release();
    await vi.waitFor(async () => {
      const w = (await app.inject({ method: 'GET', url: '/api/sessions/w1/walkthrough' })).json().walkthrough;
      expect(w.narrationPending).toBe(false);
      expect(w.narration).toEqual({
        intents: [{ title: 'Margin', summary: 'Adds a margin.', steps: ['toolu_E1'], considered: [], abandoned: false }],
        staleSteps: 0,
      });
    });
    // Once as it went pending, once as it landed.
    expect(events.filter((e) => e.event === 'walkthrough_narration')).toHaveLength(2);
  });

  it('POST narrate refuses a second run while one is in flight, and a walkthrough with no steps', async () => {
    const { app } = appWithTranscript('web', () => (async function* () { await new Promise(() => {}); })());
    expect((await app.inject({ method: 'POST', url: '/api/sessions/w1/walkthrough/narrate' })).statusCode).toBe(202);
    const again = await app.inject({ method: 'POST', url: '/api/sessions/w1/walkthrough/narrate' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'narrate_running' });

    const { app: bare, db } = makeApp();
    db.insert(sessions).values({ id: 'w2', projectDir: 'p', cwd: '/w/z', title: 'empty', lastAt: 1, source: 'web', permissionMode: 'acceptEdits' }).run();
    const none = await bare.inject({ method: 'POST', url: '/api/sessions/w2/walkthrough/narrate' });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toEqual({ error: 'no_steps' });
    expect((await bare.inject({ method: 'POST', url: '/api/sessions/nope/walkthrough/narrate' })).statusCode).toBe(404);
  });

  it('POST narrate accepts a terminal session, a running one and one with a pending rewind', async () => {
    const terminal = appWithTranscript('terminal', scripted(answered(NARRATION)));
    expect((await narrated(terminal.app)).narration.intents[0].title).toBe('Margin');

    const running = appWithTranscript('web', scripted(answered(NARRATION)));
    running.runner.status = () => 'working';
    running.registry.get = (id: string) => (id === 'w1' ? { sessionId: 'w1', status: 'working' } : undefined);
    expect((await narrated(running.app)).narration.intents[0].title).toBe('Margin');

    const rewinding = appWithTranscript('web', scripted(answered(NARRATION)));
    rewinding.db.insert(pendingRewinds).values({
      sessionId: 'w1', targetUuid: 'u1', forkUuid: 'u0', dropsTurn: null, hiddenCount: 3, text: 'add margin', priorDraft: '', createdAt: 1,
    }).run();
    expect((await narrated(rewinding.app)).narration.intents[0].title).toBe('Margin');
  });

  it('a refusal, a garbage answer and a thrown query each land as their own failure', async () => {
    const refusedByStop = appWithTranscript('web', scripted([
      { type: 'assistant', message: { content: [], stop_reason: 'refusal' } },
      { type: 'result', subtype: 'success', is_error: true, stop_reason: 'refusal', result: '' },
    ]));
    expect(await narrated(refusedByStop.app)).toMatchObject({ narration: null, narrationFailed: true, narrationFailure: 'refused' });

    // How the refusal of 2026-09-29 arrived: an API error whose text says so.
    const refusedByError = appWithTranscript('web', scripted([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy. Details: [reasoning_extraction]' }] } },
      { type: 'result', subtype: 'success', is_error: true, stop_reason: null, result: 'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy.' },
    ]));
    expect((await narrated(refusedByError.app)).narrationFailure).toBe('refused');

    const garbage = appWithTranscript('web', scripted(answered('Sure! Here is what happened: a margin.')));
    expect(await narrated(garbage.app)).toMatchObject({ narrationFailed: true, narrationFailure: 'unparsable' });

    const thrown = appWithTranscript('web', scripted(new Error('spawn claude ENOENT')));
    expect(await narrated(thrown.app)).toMatchObject({ narrationFailed: true, narrationFailure: 'error' });

    const overloaded = appWithTranscript('web', scripted([
      { type: 'result', subtype: 'success', is_error: true, stop_reason: null, result: 'API Error: 529 Overloaded' },
    ]));
    expect((await narrated(overloaded.app)).narrationFailure).toBe('error');
  });

  it('a new run after a failure clears it; the previous intents stay while it is pending', async () => {
    let answer: unknown[] | Error = new Error('boom');
    let gate: Promise<void> = Promise.resolve();
    const { app } = appWithTranscript('web', () => (async function* () {
      await gate;
      if (answer instanceof Error) throw answer;
      yield* answer;
    })());
    expect((await narrated(app)).narrationFailure).toBe('error');
    answer = answered(NARRATION);
    expect((await narrated(app)).narration.intents[0].title).toBe('Margin');

    let open!: () => void;
    gate = new Promise((r) => { open = r; });
    await app.inject({ method: 'POST', url: '/api/sessions/w1/walkthrough/narrate' });
    const pending = (await app.inject({ method: 'GET', url: '/api/sessions/w1/walkthrough' })).json().walkthrough;
    expect(pending).toMatchObject({ narrationPending: true, narrationFailed: false, narrationFailure: null });
    expect(pending.narration.intents[0].title).toBe('Margin');
    open();
  });
});

describe('background task routes', () => {
  const started = (over: Record<string, unknown>) =>
    ({ type: 'system', subtype: 'task_started', session_id: 's1', description: 'dev server', ...over }) as any;
  const notified = (task_id: string) =>
    ({ type: 'system', subtype: 'task_notification', session_id: 's1', task_id, status: 'completed', summary: '' }) as any;

  /** `s1` with a running shell `sh1` whose output goes to a real file, and a Runner that can stop it. */
  function withShell(opts: { output?: string | null } = {}) {
    const made = makeApp();
    const dir = mkdtempSync(join(tmpdir(), 'orbital-task-out-'));
    const path = join(dir, 'sh1.output');
    if (opts.output !== null) writeFileSync(path, opts.output ?? 'ready on :5173\n');
    made.backgroundTasks.feedTask(
      's1',
      started({ task_id: 'sh1', task_type: 'local_bash', tool_use_id: 'tu1', is_backgrounded: true }),
      () => ({ name: 'Bash', input: { command: 'npm run dev' }, outputPath: path }),
    );
    const stopTask = vi.fn(async (_id: string, _taskId: string) => true);
    (made.runner as any).stopTask = stopTask;
    return { ...made, path, dir, stopTask };
  }

  it('POST .../stop sends the stop for a running task and answers 204, leaving the task running', async () => {
    const { app, stopTask, backgroundTasks } = withShell();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s1/tasks/sh1/stop' });
    expect(res.statusCode).toBe(204);
    expect(stopTask).toHaveBeenCalledWith('s1', 'sh1');
    // Its notification ends it, not the route.
    expect(backgroundTasks.get('s1', 'sh1')?.state).toBe('running');
  });

  it('POST .../stop takes a running subagent by its task id', async () => {
    const { app, stopTask, subagents } = withShell();
    subagents.feedTask('s1', started({ task_id: 'ag1', task_type: 'local_agent', tool_use_id: 'tuA' }));
    const res = await app.inject({ method: 'POST', url: '/api/sessions/s1/tasks/ag1/stop' });
    expect(res.statusCode).toBe(204);
    expect(stopTask).toHaveBeenCalledWith('s1', 'ag1');
  });

  it('POST .../stop 404s a task the session never had, and a session with no live query', async () => {
    const { app, stopTask, runner } = withShell();
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/tasks/nope/stop' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s2/tasks/sh1/stop' })).statusCode).toBe(404);
    expect(stopTask).not.toHaveBeenCalled();
    (runner as any).stopTask = vi.fn(async () => false);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/tasks/sh1/stop' })).statusCode).toBe(404);
  });

  it('POST .../stop 409s a task or subagent that has already ended', async () => {
    const { app, stopTask, backgroundTasks, subagents } = withShell();
    backgroundTasks.feedTask('s1', notified('sh1'));
    subagents.feedTask('s1', started({ task_id: 'ag1', task_type: 'local_agent' }));
    subagents.feedTask('s1', notified('ag1'));
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/tasks/sh1/stop' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/tasks/ag1/stop' })).statusCode).toBe(409);
    expect(stopTask).not.toHaveBeenCalled();
  });

  it('GET .../output returns the tail with its byte offsets', async () => {
    const { app } = withShell({ output: 'héllo\nready\n' });
    const res = await app.inject({ url: '/api/sessions/s1/tasks/sh1/output' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'héllo\nready\n', start: 0, end: Buffer.byteLength('héllo\nready\n') });
  });

  it('GET .../output 410s once the file is gone, and 404s a task without an output path', async () => {
    const { app, backgroundTasks } = withShell({ output: null });
    expect((await app.inject({ url: '/api/sessions/s1/tasks/sh1/output' })).statusCode).toBe(410);
    backgroundTasks.feedTask('s1', started({ task_id: 'wf', task_type: 'local_workflow' }));
    expect((await app.inject({ url: '/api/sessions/s1/tasks/wf/output' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/sessions/s1/tasks/unknown/output' })).statusCode).toBe(404);
  });

  it('GET .../output reads only the path recorded for that task', async () => {
    const { app, dir } = withShell();
    // A file beside it, reachable only by a path this route would have to build.
    writeFileSync(join(dir, 'other.output'), 'secret\n');
    for (const url of [
      '/api/sessions/s1/tasks/other/output',
      '/api/sessions/s1/tasks/..%2Fother/output',
      `/api/sessions/s1/tasks/${encodeURIComponent(join(dir, 'other.output'))}/output`,
    ]) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('secret');
    }
  });
});

describe('branch status routes', () => {
  /** A repository on a feature branch, so a PR is looked up for it. */
  function featureRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-branch-routes-'));
    mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature\n');
    writeFileSync(join(dir, '.git', 'refs/heads/main'), `${'a'.repeat(40)}\n`);
    return dir;
  }

  function storeWith(settingValues: Record<string, string>, gh: 'ready' | 'missing' | 'logged_out' = 'ready') {
    const lookupPr = vi.fn(async () => ({ kind: 'none' as const }));
    const readLines = vi.fn(async () => null);
    const store = new BranchStatusStore({
      git: gitStore,
      settings: { get: (k) => settingValues[k] ?? '' },
      lookupPr, readLines,
      ghAvailability: async () => gh,
    });
    return { store, lookupPr, readLines };
  }

  it('GET /api/gh-status reports why gh cannot serve the PR switch', async () => {
    const { store } = storeWith({}, 'logged_out');
    const { app } = makeApp({ branchStatus: store });
    expect(res200(await app.inject({ method: 'GET', url: '/api/gh-status' }))).toEqual({ status: 'logged_out' });
    store.close();
  });

  it('POST /api/branch-status/refresh looks up the PR of every watched working tree', async () => {
    const dir = featureRepo();
    const { store, lookupPr } = storeWith({ header_pull_request: 'true' });
    store.watchSession('s1', dir);
    await vi.waitFor(() => expect(lookupPr).toHaveBeenCalledTimes(1));
    const { app } = makeApp({ branchStatus: store });
    expect(res200(await app.inject({ method: 'POST', url: '/api/branch-status/refresh' }))).toEqual({ ok: true });
    await vi.waitFor(() => expect(lookupPr).toHaveBeenCalledTimes(2));
    expect(lookupPr).toHaveBeenLastCalledWith(dir, 'feature');
    store.close();
  });

  it('PATCH /api/settings applies a branch status key at once, and leaves the store alone for others', async () => {
    const { store } = storeWith({});
    const settingsChanged = vi.spyOn(store, 'settingsChanged');
    const { app } = makeApp({ branchStatus: store });
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { confirm_before_clear: 'false' } });
    expect(settingsChanged).not.toHaveBeenCalled();
    await app.inject({
      method: 'PATCH', url: '/api/settings',
      payload: { header_line_changes: 'split', header_pull_request: 'true' },
    });
    expect(settingsChanged).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('POST /api/sessions starts the watch for a browser that subscribed before the row existed', async () => {
    const dir = featureRepo();
    const { store } = storeWith({});
    const watchSession = vi.spyOn(store, 'watchSession');
    const { app, hub } = makeApp({ branchStatus: store });
    subscribeFake(hub, 'session:web-9');
    const res = await app.inject({
      method: 'POST', url: '/api/sessions', payload: { cwd: dir, prompt: 'go', permissionMode: 'default' },
    });
    expect(res.statusCode).toBe(201);
    expect(watchSession).toHaveBeenCalledWith('web-9', dir);
    store.close();
  });
});
