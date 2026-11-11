import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { buildServer } from '../src/index.js';
import { makeTmpDir } from './tmp.js';

/**
 * Work in a worktree end to end (spec 2026-11-02-work-in-a-worktree-design
 * § Tests): a real server against a temporary repository with an `origin`,
 * a fake model behind the session and behind the naming call.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** A repository on `main` pushed to a bare `origin`, plus `feat/old` and `fix/stack` on origin. */
function makeRepo(): string {
  const origin = realpathSync(makeTmpDir('wt-origin'));
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const repo = realpathSync(makeTmpDir('wt-repo'));
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'server'));
  writeFileSync(join(repo, 'server', 'a.ts'), 'a\n');
  writeFileSync(join(repo, '.gitignore'), 'CLAUDE.local.md\n.env\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  for (const branch of ['feat/old', 'fix/stack']) {
    git(repo, 'branch', branch);
    git(repo, 'push', '-q', 'origin', branch);
  }
  writeFileSync(join(repo, 'CLAUDE.local.md'), 'local\n');
  writeFileSync(join(repo, '.env'), 'SECRET=1\n');
  return repo;
}

/** The text of a user message the SDK was handed, whatever shape its content takes. */
function textOf(userMsg: any): string {
  const content = userMsg?.message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((b: any) => (b?.type === 'text' ? b.text : '')).join('') : '';
}

/**
 * The session's own fake SDK: records each start's options and every prompt
 * it is handed, answers each. `firstReply`, when given, holds the answer to
 * the first prompt until it settles.
 */
function fakeSessionQueryFn(starts: any[], prompts: string[], firstReply?: Promise<void>) {
  return ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    starts.push(options);
    const sid = options?.sessionId ?? options?.resume;
    async function* gen() {
      let announced = false;
      for await (const userMsg of prompt) {
        prompts.push(textOf(userMsg));
        if (!announced) {
          announced = true;
          yield { type: 'system', subtype: 'init', session_id: sid };
        }
        if (prompts.length === 1 && firstReply) await firstReply;
        yield { type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
      }
    }
    return gen() as any;
  };
}

/** What the naming call answers: a name, a failure, or a name once something else lets it. */
type Naming = string | Error | (() => Promise<string>);

/** The one-shot calls: the naming call answers `naming`, anything else (the titler) a fixed name. */
function fakeOneShot(naming: Naming) {
  return vi.fn(({ options }: { prompt: string; options: Record<string, unknown> }) => {
    const isNaming = String(options.systemPrompt).includes('git branch');
    if (isNaming && naming instanceof Error) throw naming;
    async function* gen() {
      const text = !isNaming ? 'Titler name' : typeof naming === 'function' ? await naming() : (naming as string);
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
      yield { type: 'result', subtype: 'success' };
    }
    return gen();
  });
}

/** A naming call held until `release`. */
function heldNaming(name: string) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  return { naming: async () => { await held; return name; }, release };
}

async function serverWith(naming: Naming, dirs?: { claudeDir: string; dbPath: string }, firstReply?: Promise<void>) {
  const claudeDir = dirs?.claudeDir ?? makeTmpDir('wt-claude');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  const dbPath = dirs?.dbPath ?? join(claudeDir, 'index.db');
  const starts: any[] = [];
  const prompts: string[] = [];
  const oneShot = fakeOneShot(naming);
  const app = await buildServer({
    claudeDir, dbPath,
    queryFn: fakeSessionQueryFn(starts, prompts, firstReply) as any,
    titleQueryFn: oneShot as any,
  });
  return { app, starts, prompts, oneShot, dirs: { claudeDir, dbPath } };
}

const launch = (app: any, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/sessions', payload: { prompt: 'fix the tray flicker', permissionMode: 'acceptEdits', ...payload } });

const sessionOf = async (app: any, id: string) => (await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json().session;

const countSessions = async (app: any) => (await app.inject({ method: 'GET', url: '/api/sessions/count' })).json();

const send = (app: any, id: string, text: string) =>
  app.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, payload: { text } });

const post = (app: any, url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, payload });

/** Waits for the session's setup to reach `phase`, and answers the session then. */
async function settledAt(app: any, id: string, phase: 'ready' | 'failed') {
  await vi.waitFor(async () => expect((await sessionOf(app, id))?.setup?.phase).toBe(phase), { timeout: 10_000, interval: 25 });
  return sessionOf(app, id);
}

/** Launches into a worktree and waits for the session to have started there. */
async function launchedReady(app: any, payload: Record<string, unknown>) {
  const res = await launch(app, payload);
  expect(res.statusCode).toBe(201);
  const { sessionId } = res.json();
  return { sessionId, session: await settledAt(app, sessionId, 'ready') };
}

describe('launching into a worktree', () => {
  it('makes the worktree from the base on a named branch, and tells the session where it is', async () => {
    const repo = makeRepo();
    const { app, starts } = await serverWith('feat/tray-flicker\nTray flicker');
    try {
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { worktree_copy_patterns: '.env*\n' } });
      const { session } = await launchedReady(app, { cwd: join(repo, 'server'), worktree: { base: 'origin/main' } });
      const path = join(repo, '.claude/worktrees/tray-flicker');

      expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/tray-flicker');
      expect(git(path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'origin/main'));
      // The default branch as base sets no PR target, and the branch tracks nothing yet.
      expect(() => git(repo, 'config', '--get', 'branch.feat/tray-flicker.gh-merge-base')).toThrow();
      expect(() => git(path, 'rev-parse', '@{u}')).toThrow();
      // The session starts in the same subdirectory, with the local files beside it.
      expect(session.cwd).toBe(join(path, 'server'));
      expect(session.title).toBe('Tray flicker');
      expect(session.setup).toMatchObject({ phase: 'ready', branch: 'feat/tray-flicker', path, prompt: '', queued: [] });
      expect(session.setup.readyInMs).toEqual(expect.any(Number));
      expect(readFileSync(join(path, 'CLAUDE.local.md'), 'utf8')).toBe('local\n');
      expect(readFileSync(join(path, '.env'), 'utf8')).toBe('SECRET=1\n');
      // The main checkout does not see the worktree.
      expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toContain('/.claude/worktrees/');
      expect(git(repo, 'status', '--porcelain')).toBe('');
      const append = starts.at(-1).systemPrompt.append as string;
      expect(append).toContain(`You run in the worktree \`${path}\` on branch \`feat/tray-flicker\`.`);
      // No PR target is set, so none is named; nor is the session told to open one.
      expect(append).not.toContain('pull request');
      expect(append).not.toContain('temporary name');
    } finally {
      await app.close();
    }
  });

  it('answers before the worktree exists, queues what is written meanwhile, and starts once it is ready', async () => {
    const repo = makeRepo();
    const held = heldNaming('feat/later\nLater');
    let reply!: () => void;
    const firstReply = new Promise<void>((r) => { reply = r; });
    const { app, starts, prompts } = await serverWith(held.naming, undefined, firstReply);
    try {
      const res = await launch(app, { cwd: repo, worktree: { base: 'origin/main' } });
      expect(res.statusCode).toBe(201);
      const { sessionId } = res.json();
      const waiting = await sessionOf(app, sessionId);
      expect(waiting).toMatchObject({ status: 'idle', cwd: repo });
      expect(waiting.setup).toMatchObject({ phase: 'naming', step: 1, branch: null, prompt: 'fix the tray flicker', queued: [] });
      expect(waiting.setup.launch).toMatchObject({ cwd: repo, base: 'origin/main', permissionMode: 'acceptEdits' });
      expect(existsSync(join(repo, '.claude/worktrees'))).toBe(false);
      expect(starts).toHaveLength(0);

      expect((await send(app, sessionId, 'and the dock too')).json()).toEqual({ ok: true, queued: true });
      expect((await send(app, sessionId, 'then open a PR')).json()).toEqual({ ok: true, queued: true });
      expect((await sessionOf(app, sessionId)).setup.queued.map((m: any) => m.text)).toEqual(['and the dock too', 'then open a PR']);

      // A session in setup works nowhere yet: it neither occupies the checkout nor turns the switch on.
      const options = (await app.inject({ method: 'GET', url: `/api/worktree/options?cwd=${encodeURIComponent(repo)}` })).json();
      expect(options).toMatchObject({ occupants: [], autoOn: false });
      // Nor does it have a worktree of its own, whatever its directory is.
      expect((await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/worktree` })).json()).toBeNull();

      held.release();
      const ready = await settledAt(app, sessionId, 'ready');
      expect(ready.cwd).toBe(join(repo, '.claude/worktrees/later'));
      expect(starts).toHaveLength(1);
      // Ready while the first turn runs: the queue waits for its reply, as if typed after it.
      await vi.waitFor(() => expect(prompts).toEqual(['fix the tray flicker']));
      expect(ready.setup).toMatchObject({ prompt: '', attachments: [] });
      expect(ready.setup.queued.map((m: any) => m.text)).toEqual(['and the dock too', 'then open a PR']);
      // What is written meanwhile joins the end, not ahead of what waits.
      expect((await send(app, sessionId, 'and the menu')).json()).toEqual({ ok: true, queued: true });
      await new Promise((r) => setTimeout(r, 300));
      expect(prompts).toEqual(['fix the tray flicker']);

      reply();
      await vi.waitFor(() => expect(prompts).toEqual(['fix the tray flicker', 'and the dock too', 'then open a PR', 'and the menu']), { timeout: 5_000 });
      await vi.waitFor(async () => expect((await sessionOf(app, sessionId)).setup.queued).toEqual([]));
      // Started and handed over: a message goes in as to any session.
      expect((await send(app, sessionId, 'thanks')).json()).not.toHaveProperty('queued');
    } finally {
      await app.close();
    }
  });

  it('records the PR target when the base is not the default branch, and suffixes a taken name', async () => {
    const repo = makeRepo();
    const { app, starts } = await serverWith('feat/old\nOld again');
    try {
      await launchedReady(app, { cwd: repo, worktree: { base: 'origin/fix/stack' } });
      const path = join(repo, '.claude/worktrees/old-2');
      expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/old-2');
      expect(git(repo, 'config', '--get', 'branch.feat/old-2.gh-merge-base')).toBe('fix/stack');
      expect(starts.at(-1).systemPrompt.append).toContain('on branch `feat/old-2`. Its pull request targets `fix/stack`.');
    } finally {
      await app.close();
    }
  });

  it('falls back to the temporary name when the naming call fails, and says so', async () => {
    const repo = makeRepo();
    const { app, starts } = await serverWith(new Error('spawn ENOENT'));
    try {
      const sessionId = '0123abcd-1111-4222-8333-444455556666';
      await launchedReady(app, { cwd: repo, sessionId, worktree: { base: 'main' } });
      expect(git(join(repo, '.claude/worktrees/0123abcd'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('claude/0123abcd');
      expect(starts.at(-1).systemPrompt.append).toContain('This is a temporary name');
      // Recorded, not announced: the user saw only the temporary name.
      const logged = (await app.inject({ method: 'GET', url: '/api/errors' })).json().errors;
      expect(logged).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'branch_naming_failed', sessionId, context: { reason: 'error' } }),
      ]));
    } finally {
      await app.close();
    }
  });

  it('refuses a typed branch that exists or is invalid, leaving nothing behind', async () => {
    const repo = makeRepo();
    const { app } = await serverWith('feat/x');
    try {
      const before = await countSessions(app);
      const exists = await launch(app, { cwd: repo, worktree: { base: 'origin/main', branch: 'fix/stack' } });
      expect(exists.statusCode).toBe(409);
      expect(exists.json().error).toBe('worktree_branch_exists');
      const invalid = await launch(app, { cwd: repo, worktree: { base: 'origin/main', branch: 'fix/tray flicker' } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toBe('worktree_invalid_branch');
      const badBase = await launch(app, { cwd: repo, worktree: { base: 'origin/nope', branch: 'fix/y' } });
      expect(badBase.statusCode).toBe(500);
      expect(badBase.json().error).toBe('worktree_failed');
      const notGit = await launch(app, { cwd: makeTmpDir('wt-plain'), worktree: { base: 'main' } });
      expect(notGit.statusCode).toBe(500);
      expect(notGit.json().error).toBe('worktree_failed');
      expect(await countSessions(app)).toEqual(before);
      expect(existsSync(join(repo, '.claude/worktrees'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('takes away what a failed setup made, keeps the session not started with its prompt and queue, and tries again', async () => {
    const repo = makeRepo();
    const { app, prompts } = await serverWith('feat/x');
    try {
      // Another launch's directory, already there under the name this one wants.
      mkdirSync(join(repo, '.claude/worktrees/doomed'), { recursive: true });
      writeFileSync(join(repo, '.claude/worktrees/doomed/theirs.txt'), 'x\n');
      // `.git/info` as a file: the exclude cannot be written, after the worktree exists.
      rmSync(join(repo, '.git/info'), { recursive: true, force: true });
      writeFileSync(join(repo, '.git/info'), '');
      const before = await countSessions(app);
      const res = await launch(app, { cwd: repo, worktree: { base: 'origin/main', branch: 'fix/doomed' } });
      expect(res.statusCode).toBe(201);
      const { sessionId } = res.json();
      expect((await send(app, sessionId, 'meanwhile')).json()).toEqual({ ok: true, queued: true });
      const failed = await settledAt(app, sessionId, 'failed');
      expect(failed.status).toBe('idle');
      expect(failed.setup).toMatchObject({ step: 3, prompt: 'fix the tray flicker', message: expect.any(String) });
      expect(failed.setup.queued.map((m: any) => m.text)).toEqual(['meanwhile']);
      expect(existsSync(join(repo, '.claude/worktrees/doomed-2'))).toBe(false);
      expect(readFileSync(join(repo, '.claude/worktrees/doomed/theirs.txt'), 'utf8')).toBe('x\n');
      expect(git(repo, 'branch', '--list', 'fix/doomed')).toBe('');
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('doomed');
      const logged = (await app.inject({ method: 'GET', url: '/api/errors' })).json().errors;
      expect(logged).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: failed.setup.errorId, kind: 'worktree_failed', sessionId }),
      ]));
      expect((await countSessions(app)).total).toBe(before.total + 1);
      // Written to while not started: kept, not sent.
      expect((await send(app, sessionId, 'still there?')).json()).toEqual({ ok: true, queued: true });
      expect(prompts).toEqual([]);

      // Try again, once what failed is put right: the same settings, the queue sent after the prompt.
      rmSync(join(repo, '.git/info'));
      mkdirSync(join(repo, '.git/info'));
      expect((await post(app, `/api/sessions/${sessionId}/setup/retry`)).json()).toEqual({ ok: true });
      const ready = await settledAt(app, sessionId, 'ready');
      expect(ready.cwd).toBe(join(repo, '.claude/worktrees/doomed-2'));
      expect(git(ready.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix/doomed');
      await vi.waitFor(() => expect(prompts).toEqual(['fix the tray flicker', 'meanwhile', 'still there?']));

      const again = await post(app, `/api/sessions/${sessionId}/setup/retry`);
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe('not_failed');
      const unknown = await post(app, '/api/sessions/nope/setup/retry');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error).toBe('not_found');
    } finally {
      await app.close();
    }
  });

  it('fails plainly when git refuses a branch that appeared after the launch was checked', async () => {
    const repo = makeRepo();
    const held = heldNaming('feat/appeared');
    const { app, oneShot } = await serverWith(held.naming);
    try {
      const { sessionId } = (await launch(app, { cwd: repo, worktree: { base: 'origin/main' } })).json();
      // The naming call has the branch list already; the branch is made while it runs.
      await vi.waitFor(() => expect(oneShot).toHaveBeenCalled());
      git(repo, 'branch', 'feat/appeared');
      held.release();
      const failed = await settledAt(app, sessionId, 'failed');
      expect(failed.setup).toMatchObject({ step: 2, branch: 'feat/appeared', message: expect.stringContaining('feat/appeared') });
      expect(existsSync(join(repo, '.claude/worktrees/appeared'))).toBe(false);
      // Not the launch's to delete: it was there before git ran.
      expect(git(repo, 'branch', '--list', 'feat/appeared')).toContain('feat/appeared');
    } finally {
      await app.close();
    }
  });

  it('never writes the local files through a symlink the base branch commits', async () => {
    const repo = makeRepo();
    const outside = realpathSync(makeTmpDir('wt-outside'));
    // The local settings the launch copies, in the main checkout's own `.claude`.
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude/settings.local.json'), '{"local":true}\n');
    // A branch whose `.claude` is a symlink out of the tree.
    const scratch = join(realpathSync(makeTmpDir('wt-scratch')), 'evil');
    git(repo, 'worktree', 'add', '-q', '-b', 'evil', scratch, 'main');
    symlinkSync(outside, join(scratch, '.claude'));
    git(scratch, 'add', '.claude');
    git(scratch, 'commit', '-q', '-m', 'symlinked .claude');
    git(repo, 'worktree', 'remove', '--force', scratch);
    const { app } = await serverWith('feat/x');
    try {
      await launchedReady(app, { cwd: repo, worktree: { base: 'evil', branch: 'fix/through-link' } });
      expect(readdirSync(outside)).toEqual([]);
      // The file beside it, outside `.claude`, still came.
      expect(readFileSync(join(repo, '.claude/worktrees/through-link/CLAUDE.local.md'), 'utf8')).toBe('local\n');
    } finally {
      await app.close();
    }
  });

  it('answers a repeated launch of the same session id with the first answer, making one worktree', async () => {
    const repo = makeRepo();
    const { app } = await serverWith('feat/once\nOnce');
    try {
      const sessionId = '0123abcd-1111-4222-8333-444455556666';
      const body = { cwd: repo, sessionId, worktree: { base: 'origin/main' } };
      const [first, second] = await Promise.all([launch(app, body), launch(app, body)]);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json()).toEqual(first.json());
      await settledAt(app, sessionId, 'ready');
      const third = await launch(app, body);
      expect(third.statusCode).toBe(201);
      expect(third.json()).toEqual({ sessionId });
      expect(readdirSync(join(repo, '.claude/worktrees'))).toEqual(['once']);
      // The same id with another request is not a repeat.
      const other = await launch(app, { ...body, prompt: 'something else' });
      expect(other.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});

describe('discarding a session that never started', () => {
  it('discards while setting up: the session is gone at once, and the setup makes nothing after', async () => {
    const repo = makeRepo();
    const held = heldNaming('feat/gone');
    const { app, starts, oneShot } = await serverWith(held.naming);
    try {
      const before = await countSessions(app);
      const { sessionId } = (await launch(app, { cwd: repo, worktree: { base: 'origin/main' } })).json();
      expect((await post(app, `/api/sessions/${sessionId}/discard`)).json()).toEqual({ ok: true });
      expect(await sessionOf(app, sessionId)).toBeUndefined();
      expect(await countSessions(app)).toEqual(before);
      held.release();
      // The naming call's answer comes, and is not acted on.
      await vi.waitFor(() => expect(oneShot.mock.results.length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(join(repo, '.claude/worktrees/gone'))).toBe(false);
      expect(git(repo, 'branch', '--list', 'feat/gone')).toBe('');
      expect(starts).toHaveLength(0);
      const again = await post(app, `/api/sessions/${sessionId}/discard`);
      expect(again.statusCode).toBe(404);
      expect(again.json().error).toBe('not_found');
    } finally {
      await app.close();
    }
  });

  it('discards a session that could not start, and refuses one that runs', async () => {
    const repo = makeRepo();
    const { app } = await serverWith('feat/x');
    try {
      const before = await countSessions(app);
      rmSync(join(repo, '.git/info'), { recursive: true, force: true });
      writeFileSync(join(repo, '.git/info'), '');
      const { sessionId } = (await launch(app, { cwd: repo, worktree: { base: 'origin/main', branch: 'fix/never' } })).json();
      await settledAt(app, sessionId, 'failed');
      expect((await post(app, `/api/sessions/${sessionId}/discard`)).json()).toEqual({ ok: true });
      expect(await countSessions(app)).toEqual(before);
      expect(existsSync(join(repo, '.claude/worktrees/never'))).toBe(false);
      expect(git(repo, 'branch', '--list', 'fix/never')).toBe('');

      const { sessionId: plain } = (await launch(app, { cwd: repo })).json();
      const refused = await post(app, `/api/sessions/${plain}/discard`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe('not_in_setup');
    } finally {
      await app.close();
    }
  });

  it('refuses Clear on a session in setup, and keeps it', async () => {
    const repo = makeRepo();
    const held = heldNaming('feat/cleared');
    const { app, starts } = await serverWith(held.naming);
    try {
      const { sessionId } = (await launch(app, { cwd: repo, worktree: { base: 'origin/main' } })).json();
      const res = await post(app, `/api/sessions/${sessionId}/clear`, { startNew: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('in_setup');
      expect((await sessionOf(app, sessionId)).setup.phase).toBe('naming');
      expect(starts).toHaveLength(0);
      held.release();
      await settledAt(app, sessionId, 'ready');
    } finally {
      await app.close();
    }
  });

  it('starts nothing in the main checkout for a harness attached during setup', async () => {
    const repo = makeRepo();
    const held = heldNaming('feat/harnessed');
    const { app, starts } = await serverWith(held.naming);
    try {
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { harness_enabled: 'true' } });
      const steps = [{ id: 'one', title: 'One', instructions: 'Do it.', mode: 'auto', doneWhen: 'done' }];
      const template = (await post(app, '/api/harness/templates', { name: 't', tags: [], inputs: [], steps })).json();
      const { sessionId } = (await launch(app, { cwd: repo, worktree: { base: 'origin/main' } })).json();
      const res = await post(app, `/api/sessions/${sessionId}/harness`, { templateId: template.template?.id ?? template.id });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('in_setup');
      expect(starts).toHaveLength(0);
      held.release();
      const ready = await settledAt(app, sessionId, 'ready');
      expect(ready.cwd).toBe(join(repo, '.claude/worktrees/harnessed'));
      expect(starts).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('treats End on a session in setup as Discard', async () => {
    const repo = makeRepo();
    const held = heldNaming('feat/ended-early');
    const { app } = await serverWith(held.naming);
    try {
      const before = await countSessions(app);
      const { sessionId } = (await launch(app, { cwd: repo, worktree: { base: 'origin/main' } })).json();
      const res = await post(app, `/api/sessions/${sessionId}/end`, { removeWorktree: 'clean' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(await sessionOf(app, sessionId)).toBeUndefined();
      expect(await countSessions(app)).toEqual(before);
      held.release();
    } finally {
      await app.close();
    }
  });
});

describe('a server that stops during setup', () => {
  it('keeps the queue a started session had left at a restart, and sends it ahead of the next message', async () => {
    const repo = makeRepo();
    const first = await serverWith('feat/restarted');
    const { sessionId } = await launchedReady(first.app, { cwd: repo, worktree: { base: 'origin/main' } });
    await vi.waitFor(() => expect(first.prompts).toEqual(['fix the tray flicker']));
    await first.app.close();

    // What a stop before the first turn ended leaves: ready, with the queue not yet sent.
    const raw = new BetterSqlite3(first.dirs.dbPath);
    raw.prepare('UPDATE session_setups SET queued = ? WHERE session_id = ?').run(JSON.stringify([{ text: 'left over' }]), sessionId);
    raw.close();

    const second = await serverWith('feat/x', first.dirs);
    try {
      // Nothing is resumed at boot: the queue waits for the user.
      await new Promise((r) => setTimeout(r, 300));
      expect(second.starts).toHaveLength(0);
      expect((await sessionOf(second.app, sessionId)).setup.queued.map((m: any) => m.text)).toEqual(['left over']);

      expect((await send(second.app, sessionId, 'next')).json()).toEqual({ ok: true, queued: true });
      await vi.waitFor(() => expect(second.prompts).toEqual(['left over', 'next']), { timeout: 5_000 });
      await vi.waitFor(async () => expect((await sessionOf(second.app, sessionId)).setup).toMatchObject({ phase: 'ready', queued: [] }));
      expect(second.starts[0].resume).toBe(sessionId);
    } finally {
      await second.app.close();
    }
  });

  it('finishes the rollback of a setup discarded just before the stop', async () => {
    const repo = makeRepo();
    const held = heldNaming('feat/tomb');
    const first = await serverWith(held.naming);
    const { sessionId } = (await launch(first.app, { cwd: repo, worktree: { base: 'origin/main' } })).json();
    await first.app.close();
    held.release();

    // What a discard leaves when the server stops before its rollback: no session, the setup's tombstone.
    const path = join(repo, '.claude/worktrees/tomb');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/tomb', path, 'main');
    const raw = new BetterSqlite3(first.dirs.dbPath);
    raw.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    raw.prepare("UPDATE session_setups SET phase = 'discarded', branch = 'feat/tomb', path = ?, made = 'worktree' WHERE session_id = ?")
      .run(path, sessionId);
    raw.close();

    const second = await serverWith('feat/x', first.dirs);
    try {
      await vi.waitFor(() => expect(existsSync(path)).toBe(false), { timeout: 10_000 });
      await vi.waitFor(() => expect(git(repo, 'branch', '--list', 'feat/tomb')).toBe(''));
      expect(await sessionOf(second.app, sessionId)).toBeUndefined();
    } finally {
      await second.app.close();
    }
    const after = new BetterSqlite3(first.dirs.dbPath);
    expect(after.prepare('SELECT * FROM session_setups WHERE session_id = ?').get(sessionId)).toBeUndefined();
    after.close();
  });

  it('finds the setup not started at boot, rolled back from its record, with its prompt and queue', async () => {
    const repo = makeRepo();
    const held = heldNaming('feat/never-named');
    const first = await serverWith(held.naming);
    const { sessionId } = (await launch(first.app, { cwd: repo, worktree: { base: 'origin/main' } })).json();
    await send(first.app, sessionId, 'queued before the stop');
    await first.app.close();

    // What a stop in the middle of `git worktree add` leaves: the tree, and a record that says it may be there.
    const path = join(repo, '.claude/worktrees/half');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/half', path, 'main');
    const raw = new BetterSqlite3(first.dirs.dbPath);
    raw.prepare("UPDATE session_setups SET phase = 'checkout', step = 2, branch = 'feat/half', path = ?, made = 'worktree' WHERE session_id = ?")
      .run(path, sessionId);
    raw.close();

    const second = await serverWith('feat/x', first.dirs);
    try {
      const session = await sessionOf(second.app, sessionId);
      expect(session.status).toBe('idle');
      expect(session.setup).toMatchObject({
        phase: 'failed', message: 'Orbital stopped while the worktree was being set up.', prompt: 'fix the tray flicker',
      });
      expect(session.setup.queued.map((m: any) => m.text)).toEqual(['queued before the stop']);
      await vi.waitFor(() => expect(existsSync(path)).toBe(false), { timeout: 10_000 });
      await vi.waitFor(() => expect(git(repo, 'branch', '--list', 'feat/half')).toBe(''));
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('half');
    } finally {
      await second.app.close();
    }
  });
});

describe('the dialog', () => {
  it('reads the repository, and who already works in the checkout', async () => {
    const repo = makeRepo();
    const { app } = await serverWith('feat/x');
    try {
      const quiet = (await app.inject({ method: 'GET', url: `/api/worktree/options?cwd=${encodeURIComponent(join(repo, 'server'))}` })).json();
      expect(quiet).toMatchObject({
        git: true, repoRoot: repo, treeRoot: repo, defaultBranch: 'main', currentBranch: 'main',
        occupants: [], fetchedAt: null, autoOn: false,
      });
      expect(quiet.branches.local).toEqual(expect.arrayContaining(['main', 'feat/old', 'fix/stack']));
      expect(quiet.branches.remote).toEqual(expect.arrayContaining(['origin/main', 'origin/feat/old']));
      expect(['feat/', 'fix/']).toContain(quiet.branchForm);

      const { sessionId } = (await launch(app, { cwd: join(repo, 'server') })).json();
      const occupied = (await app.inject({ method: 'GET', url: `/api/worktree/options?cwd=${encodeURIComponent(repo)}` })).json();
      expect(occupied.occupants.map((o: any) => o.sessionId)).toEqual([sessionId]);
      expect(occupied.occupants[0].branch).toBe('main');
      expect(occupied.autoOn).toBe(true);

      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { worktree_auto_on_when_occupied: 'false' } });
      expect((await app.inject({ method: 'GET', url: `/api/worktree/options?cwd=${encodeURIComponent(repo)}` })).json().autoOn).toBe(false);

      const fetched = (await app.inject({ method: 'POST', url: '/api/worktree/fetch', payload: { cwd: repo } })).json();
      expect(fetched.ok).toBe(true);
      expect((await app.inject({ method: 'GET', url: `/api/worktree/options?cwd=${encodeURIComponent(repo)}` })).json().fetchedAt).toBe(fetched.fetchedAt);

      const outside = makeTmpDir('wt-plain');
      expect((await app.inject({ method: 'GET', url: `/api/worktree/options?cwd=${encodeURIComponent(outside)}` })).json()).toEqual({ git: false });
    } finally {
      await app.close();
    }
  });
});

describe('removing the worktree', () => {
  async function launched(naming: string) {
    const repo = makeRepo();
    const server = await serverWith(naming);
    const { sessionId } = await launchedReady(server.app, { cwd: repo, worktree: { base: 'origin/main' } });
    const path = join(repo, '.claude/worktrees', naming.split('\n')[0].split('/').pop()!);
    const state = async () => (await server.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/worktree` })).json();
    return { ...server, repo, sessionId, path, state };
  }

  it('reports uncommitted and unpushed work', async () => {
    const { app, path, state } = await launched('feat/counts');
    try {
      expect(await state()).toMatchObject({
        path, leaf: 'counts', branch: 'feat/counts', pushed: false, uncommittedFiles: 0, unpushedCommits: 0,
        sharedWith: [], variant: 'c1', removable: true, endsSession: true, dismissed: false,
      });
      writeFileSync(join(path, 'b.ts'), 'b\n');
      git(path, 'add', 'b.ts');
      git(path, 'commit', '-q', '-m', 'b');
      expect(await state()).toMatchObject({ uncommittedFiles: 0, unpushedCommits: 1, variant: 'c2b' });
      git(path, 'push', '-q', '-u', 'origin', 'feat/counts');
      expect(await state()).toMatchObject({ pushed: true, unpushedCommits: 0, variant: 'c1' });
      writeFileSync(join(path, 'c.ts'), 'c\n');
      writeFileSync(join(path, 'server', 'a.ts'), 'changed\n');
      expect(await state()).toMatchObject({ uncommittedFiles: 2, variant: 'c2a' });
    } finally {
      await app.close();
    }
  });

  it('answers null for a session in the main checkout', async () => {
    const repo = makeRepo();
    const { app } = await serverWith('feat/x');
    try {
      const { sessionId } = (await launch(app, { cwd: repo })).json();
      const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/worktree` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('refuses a dirty tree without force, then ends the session and removes it, keeping the branch', async () => {
    const { app, repo, sessionId, path } = await launched('feat/dirty');
    try {
      writeFileSync(join(path, 'scratch.ts'), 'x\n');
      const refused = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/worktree/remove`, payload: { endSession: true, path } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe('worktree_dirty');
      expect(existsSync(path)).toBe(true);
      expect((await sessionOf(app, sessionId)).status).not.toBe('ended');

      const removed = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/worktree/remove`, payload: { force: true, endSession: true, path } });
      expect(removed.statusCode).toBe(200);
      expect(existsSync(path)).toBe(false);
      expect(git(repo, 'branch', '--list', 'feat/dirty')).toContain('feat/dirty');
      expect((await sessionOf(app, sessionId)).status).toBe('ended');
      expect((await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/worktree` })).json()).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('refuses a tree another live session works in', async () => {
    const { app, sessionId, path } = await launched('feat/shared');
    try {
      const other = (await launch(app, { cwd: join(path, 'server') })).json().sessionId;
      expect((await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/worktree` })).json())
        .toMatchObject({ sharedWith: [other], variant: 'c3', removable: false });
      const res = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/worktree/remove`, payload: { force: true } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('worktree_shared');
      expect(existsSync(path)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('ends nothing the user did not confirm ending, nor a worktree they did not see', async () => {
    const { app, sessionId, path } = await launched('feat/confirm');
    try {
      const remove = (payload: Record<string, unknown>) =>
        app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/worktree/remove`, payload });
      // Shown plain *Remove*, but the session is live: removing would end it.
      const unconfirmed = await remove({ path });
      expect(unconfirmed.statusCode).toBe(409);
      expect(unconfirmed.json().error).toBe('worktree_state_changed');
      const elsewhere = await remove({ endSession: true, path: `${path}-other` });
      expect(elsewhere.statusCode).toBe(409);
      expect(elsewhere.json().error).toBe('worktree_state_changed');
      const endElsewhere = await app.inject({
        method: 'POST', url: `/api/sessions/${sessionId}/end`, payload: { removeWorktree: 'clean', worktreePath: `${path}-other` },
      });
      expect(endElsewhere.statusCode).toBe(409);
      expect(endElsewhere.json().error).toBe('worktree_state_changed');
      expect((await sessionOf(app, sessionId)).status).not.toBe('ended');
      expect(existsSync(path)).toBe(true);

      // Ended since: *End and remove* no longer matches either.
      await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/end`, payload: {} });
      const stale = await remove({ endSession: true, path });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe('worktree_state_changed');
      expect((await remove({ endSession: false, path })).statusCode).toBe(200);
      expect(existsSync(path)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('answers End as done when the session ended but its worktree could not be removed, and records why', async () => {
    const { app, repo, sessionId, path } = await launched('feat/locked');
    try {
      git(repo, 'worktree', 'lock', path);
      const res = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/end`, payload: { removeWorktree: 'clean', worktreePath: path } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect((await sessionOf(app, sessionId)).status).toBe('ended');
      await vi.waitFor(async () => {
        const logged = (await app.inject({ method: 'GET', url: '/api/errors' })).json().errors;
        expect(logged).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'worktree_failed', sessionId, detail: expect.stringMatching(/locked/) })]));
      });
      expect(existsSync(path)).toBe(true);
      // Out of the way again once git gave up: offered as before.
      expect((await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/worktree` })).json()).toMatchObject({ path });
    } finally {
      await app.close();
    }
  });

  it('removes once when two Ends arrive together', async () => {
    const { app, sessionId, path } = await launched('feat/twice');
    try {
      const end = () => app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/end`, payload: { removeWorktree: 'clean', worktreePath: path } });
      const answers = (await Promise.all([end(), end()])).map((r) => r.json());
      // The first removes; the second finds it already on its way out.
      expect(answers).toEqual(expect.arrayContaining([{ ok: true }, expect.objectContaining({ ok: true, error: 'not_worktree' })]));
      await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    } finally {
      await app.close();
    }
  });

  it('says so when End was asked to remove a worktree the session does not work in', async () => {
    const repo = makeRepo();
    const { app } = await serverWith('feat/x');
    try {
      const { sessionId } = (await launch(app, { cwd: repo })).json();
      const res = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/end`, payload: { removeWorktree: 'clean' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, worktreeRemoved: false, error: 'not_worktree' });
      expect((await sessionOf(app, sessionId)).status).toBe('ended');
    } finally {
      await app.close();
    }
  });

  it('removes on End when asked, and remembers Keep when not', async () => {
    const first = await launched('feat/ended');
    try {
      const res = await first.app.inject({ method: 'POST', url: `/api/sessions/${first.sessionId}/end`, payload: { removeWorktree: 'clean', worktreePath: first.path } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      // Removed after the answer; meanwhile it is not offered again.
      expect((await first.app.inject({ method: 'GET', url: `/api/sessions/${first.sessionId}/worktree` })).json()).toBeNull();
      await vi.waitFor(() => expect(existsSync(first.path)).toBe(false));
      expect(git(first.repo, 'branch', '--list', 'feat/ended')).toContain('feat/ended');
    } finally {
      await first.app.close();
    }

    const second = await launched('feat/kept');
    try {
      await second.app.inject({ method: 'POST', url: `/api/sessions/${second.sessionId}/end`, payload: {} });
      expect(existsSync(second.path)).toBe(true);
      expect(await second.state()).toMatchObject({ dismissed: true, endsSession: false, removable: true });
    } finally {
      await second.app.close();
    }
  });

  it('records Keep for the worktree', async () => {
    const { app, sessionId, state } = await launched('feat/keep');
    try {
      expect((await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/worktree/keep` })).statusCode).toBe(200);
      expect((await state()).dismissed).toBe(true);
    } finally {
      await app.close();
    }
  });
});
