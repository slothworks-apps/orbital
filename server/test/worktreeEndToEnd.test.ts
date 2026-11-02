import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** The session's own fake SDK: records each start's options, answers each prompt. */
function fakeSessionQueryFn(starts: any[]) {
  return ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
    starts.push(options);
    const sid = options?.sessionId ?? options?.resume;
    async function* gen() {
      let announced = false;
      for await (const userMsg of prompt) {
        if (!announced) {
          announced = true;
          yield { type: 'system', subtype: 'init', session_id: sid };
        }
        yield { type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'result', subtype: 'success', session_id: sid, usage: {} };
        void userMsg;
      }
    }
    return gen() as any;
  };
}

/** The one-shot calls: the naming call answers `naming`, anything else (the titler) a fixed name. */
function fakeOneShot(naming: string | Error) {
  return vi.fn(({ options }: { prompt: string; options: Record<string, unknown> }) => {
    const isNaming = String(options.systemPrompt).includes('git branch');
    if (isNaming && naming instanceof Error) throw naming;
    async function* gen() {
      const text = isNaming ? (naming as string) : 'Titler name';
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
      yield { type: 'result', subtype: 'success' };
    }
    return gen();
  });
}

async function serverWith(naming: string | Error) {
  const claudeDir = makeTmpDir('wt-claude');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  const starts: any[] = [];
  const oneShot = fakeOneShot(naming);
  const app = await buildServer({
    claudeDir, dbPath: join(claudeDir, 'index.db'),
    queryFn: fakeSessionQueryFn(starts) as any,
    titleQueryFn: oneShot as any,
  });
  return { app, starts, oneShot };
}

const launch = (app: any, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/sessions', payload: { prompt: 'fix the tray flicker', permissionMode: 'acceptEdits', ...payload } });

const sessionOf = async (app: any, id: string) => (await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json().session;

const countSessions = async (app: any) => (await app.inject({ method: 'GET', url: '/api/sessions/count' })).json();

describe('launching into a worktree', () => {
  it('makes the worktree from the base on a named branch, and tells the session where it is', async () => {
    const repo = makeRepo();
    const { app, starts } = await serverWith('feat/tray-flicker\nTray flicker');
    try {
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { worktree_copy_patterns: '.env*\n' } });
      const res = await launch(app, { cwd: join(repo, 'server'), worktree: { base: 'origin/main' } });
      expect(res.statusCode).toBe(201);
      const { sessionId } = res.json();
      const path = join(repo, '.claude/worktrees/tray-flicker');

      expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/tray-flicker');
      expect(git(path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'origin/main'));
      // The default branch as base sets no PR target, and the branch tracks nothing yet.
      expect(() => git(repo, 'config', '--get', 'branch.feat/tray-flicker.gh-merge-base')).toThrow();
      expect(() => git(path, 'rev-parse', '@{u}')).toThrow();
      // The session starts in the same subdirectory, with the local files beside it.
      const session = await sessionOf(app, sessionId);
      expect(session.cwd).toBe(join(path, 'server'));
      expect(session.title).toBe('Tray flicker');
      expect(readFileSync(join(path, 'CLAUDE.local.md'), 'utf8')).toBe('local\n');
      expect(readFileSync(join(path, '.env'), 'utf8')).toBe('SECRET=1\n');
      // The main checkout does not see the worktree.
      expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toContain('/.claude/worktrees/');
      expect(git(repo, 'status', '--porcelain')).toBe('');
      const append = starts.at(-1).systemPrompt.append as string;
      expect(append).toContain(`You run in the worktree \`${path}\` on branch \`feat/tray-flicker\`. Open the PR against \`main\`.`);
      expect(append).not.toContain('temporary name');
    } finally {
      await app.close();
    }
  });

  it('records the PR target when the base is not the default branch, and suffixes a taken name', async () => {
    const repo = makeRepo();
    const { app, starts } = await serverWith('feat/old\nOld again');
    try {
      const res = await launch(app, { cwd: repo, worktree: { base: 'origin/fix/stack' } });
      expect(res.statusCode).toBe(201);
      const path = join(repo, '.claude/worktrees/old-2');
      expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/old-2');
      expect(git(repo, 'config', '--get', 'branch.feat/old-2.gh-merge-base')).toBe('fix/stack');
      expect(starts.at(-1).systemPrompt.append).toContain('Open the PR against `fix/stack`.');
    } finally {
      await app.close();
    }
  });

  it('falls back to the temporary name when the naming call fails, and says so', async () => {
    const repo = makeRepo();
    const { app, starts } = await serverWith(new Error('spawn ENOENT'));
    try {
      const sessionId = '0123abcd-1111-4222-8333-444455556666';
      const res = await launch(app, { cwd: repo, sessionId, worktree: { base: 'main' } });
      expect(res.statusCode).toBe(201);
      expect(git(join(repo, '.claude/worktrees/0123abcd'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('claude/0123abcd');
      expect(starts.at(-1).systemPrompt.append).toContain('This is a temporary name');
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
      expect(await countSessions(app)).toEqual(before);
      expect(existsSync(join(repo, '.claude/worktrees'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('takes the worktree and its branch away again when a later step fails', async () => {
    const repo = makeRepo();
    const { app } = await serverWith('feat/x');
    try {
      // `.git/info` as a file: the exclude cannot be written, after the worktree exists.
      rmSync(join(repo, '.git/info'), { recursive: true, force: true });
      writeFileSync(join(repo, '.git/info'), '');
      const before = await countSessions(app);
      const res = await launch(app, { cwd: repo, worktree: { base: 'origin/main', branch: 'fix/doomed' } });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('worktree_failed');
      expect(existsSync(join(repo, '.claude/worktrees/doomed'))).toBe(false);
      expect(git(repo, 'branch', '--list', 'fix/doomed')).toBe('');
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('doomed');
      expect(await countSessions(app)).toEqual(before);
    } finally {
      await app.close();
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
    const { sessionId } = (await launch(server.app, { cwd: repo, worktree: { base: 'origin/main' } })).json();
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
      const refused = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/worktree/remove`, payload: {} });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe('worktree_dirty');
      expect(existsSync(path)).toBe(true);
      expect((await sessionOf(app, sessionId)).status).not.toBe('ended');

      const removed = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/worktree/remove`, payload: { force: true } });
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

  it('removes on End when asked, and remembers Keep when not', async () => {
    const first = await launched('feat/ended');
    try {
      const res = await first.app.inject({ method: 'POST', url: `/api/sessions/${first.sessionId}/end`, payload: { removeWorktree: 'clean' } });
      expect(res.statusCode).toBe(200);
      expect(existsSync(first.path)).toBe(false);
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
