import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLastCwd, WorkingTrees, type TreeRow } from '../src/git/workingTrees.js';
import { enclosingRoot, fileSandboxes, readFilePreview, readInSandboxes } from '../src/files/preview.js';
import type { GitLocation } from '../src/git/gitState.js';
import type { SubagentInfo } from '../src/transcript/subagents.js';
import { subagentDirOf } from '../src/walkthrough/subagents.js';
import { makeTmpDir } from './tmp.js';

const line = (entry: Record<string, unknown>) => JSON.stringify(entry) + '\n';
const entry = (cwd: string, text = 'x') =>
  line({ type: 'assistant', uuid: text, message: { role: 'assistant', content: [{ type: 'text', text }] }, cwd });

/** A git that knows a fixed set of working-tree roots, and names each by its root. */
function fakeGit(roots: string[]) {
  const rootOf = (cwd: string): string | null =>
    roots
      .filter((r) => cwd === r || cwd.startsWith(r + '/'))
      .sort((a, b) => b.length - a.length)[0] ?? null;
  return {
    rootOf,
    locate: (cwd: string) => {
      const root = rootOf(cwd);
      return root === null ? null : ({ ref: root } as unknown as GitLocation);
    },
  };
}

const REPO = '/w/repo';
const TREE_A = '/w/repo/.claude/worktrees/a';
const TREE_B = '/w/repo/.claude/worktrees/b';

function setup(roots = [REPO, TREE_A, TREE_B]) {
  const projectsDir = makeTmpDir('trees');
  mkdirSync(join(projectsDir, 'proj'));
  const row: TreeRow = { id: 's1', cwd: REPO, project_dir: 'proj', claude_dir_id: 1 };
  const trees = new WorkingTrees({ transcriptPath: (id, projectDir) => join(projectsDir, projectDir, `${id}.jsonl`), git: fakeGit(roots) });
  const transcript = trees.transcriptOf(row);
  const agentsDir = subagentDirOf(transcript);
  mkdirSync(agentsDir, { recursive: true });
  /** A subagent with its own transcript, found by the CLI's agent id. */
  const agent = (id: string, cwd: string | null, startedAt: number, state: SubagentInfo['state'] = 'working'): SubagentInfo => {
    writeFileSync(join(agentsDir, `agent-${id}.jsonl`), cwd ? entry(cwd) : line({ type: 'queue-operation' }));
    return { id, name: `task ${id}`, state, startedAt };
  };
  return { trees, row, transcript, agentsDir, agent };
}

describe('readLastCwd', () => {
  it('follows the transcript into a worktree, and into a subdirectory of it', () => {
    const path = join(makeTmpDir('lastcwd'), 't.jsonl');
    writeFileSync(path, entry(REPO) + entry(REPO));
    expect(readLastCwd(path)).toBe(REPO);
    appendFileSync(path, entry(TREE_A));
    expect(readLastCwd(path)).toBe(TREE_A);
    appendFileSync(path, entry(`${TREE_A}/web`));
    expect(readLastCwd(path)).toBe(`${TREE_A}/web`);
  });

  it('is null for a transcript that recorded no cwd, and for a missing one', () => {
    const path = join(makeTmpDir('lastcwd'), 't.jsonl');
    writeFileSync(path, line({ type: 'queue-operation' }) + line({ type: 'summary' }));
    expect(readLastCwd(path)).toBeNull();
    expect(readLastCwd(path + '.missing')).toBeNull();
  });

  it('reads back past a long tail of lines without one', () => {
    const path = join(makeTmpDir('lastcwd'), 't.jsonl');
    const filler = line({ type: 'progress', data: 'y'.repeat(1000) }).repeat(500);
    writeFileSync(path, entry(TREE_A) + filler);
    expect(readLastCwd(path)).toBe(TREE_A);
  });

  it('takes the entry\'s own cwd, not one a tool input carries, and skips a line still being written', () => {
    const path = join(makeTmpDir('lastcwd'), 't.jsonl');
    const tool = line({
      type: 'assistant', cwd: TREE_A,
      message: { role: 'assistant', content: [{ type: 'tool_use', input: { cwd: '/' } }] },
    });
    writeFileSync(path, tool + '{"type":"assistant","cwd":"/elsewhere","mess');
    expect(readLastCwd(path)).toBe(TREE_A);
  });
});

describe('WorkingTrees.places', () => {
  it('is the home until the transcript leaves the home\'s tree, then the new tree\'s root', () => {
    const { trees, row, transcript } = setup();
    expect(trees.places(row, [], false).workingDir).toBe(REPO);
    writeFileSync(transcript, entry(REPO) + entry(`${REPO}/web`));
    expect(trees.places(row, [], false).workingDir).toBe(REPO);
    appendFileSync(transcript, entry(`${TREE_A}/web`));
    expect(trees.places(row, [], false).workingDir).toBe(TREE_A);
  });

  it('counts no subagent working in the session\'s own tree', () => {
    const { trees, row, transcript, agent } = setup();
    writeFileSync(transcript, entry(TREE_A));
    const agents = [agent('a1', `${TREE_A}/server`, 1), agent('a2', TREE_A, 2)];
    expect(trees.places(row, agents, false).otherTrees).toEqual([]);
  });

  it('groups running subagents by tree, the tree with the newest agent first', () => {
    const { trees, row, transcript, agent } = setup();
    writeFileSync(transcript, entry(REPO));
    const agents = [
      agent('a1', TREE_A, 1),
      agent('b1', TREE_B, 2),
      agent('a2', `${TREE_A}/web`, 3),
      agent('home', REPO, 4),
    ];
    expect(trees.places(row, agents, false).otherTrees).toEqual([
      { root: TREE_A, git: { ref: TREE_A }, agents: ['task a2', 'task a1'] },
      { root: TREE_B, git: { ref: TREE_B }, agents: ['task b1'] },
    ]);
  });

  it('leaves out an ended subagent, one with no cwd yet, and everything of an ended session', () => {
    const { trees, row, transcript, agent } = setup();
    writeFileSync(transcript, entry(REPO));
    const agents = [agent('a1', TREE_A, 1, 'ended'), agent('b1', TREE_B, 2), agent('c1', null, 3)];
    expect(trees.places(row, agents, false).otherTrees.map((t) => t.root)).toEqual([TREE_B]);
    expect(trees.places(row, agents, true).otherTrees).toEqual([]);
  });

  it('groups a subagent outside any repository by its cwd, with no git location', () => {
    const { trees, row, transcript, agent } = setup();
    writeFileSync(transcript, entry(REPO));
    expect(trees.places(row, [agent('t1', '/tmp/scratch', 1)], false).otherTrees).toEqual([
      { root: '/tmp/scratch', git: null, agents: ['task t1'] },
    ]);
  });

  it('finds an agent known by its Agent call through the meta file', () => {
    const { trees, row, transcript, agentsDir } = setup();
    writeFileSync(transcript, entry(REPO));
    writeFileSync(join(agentsDir, 'agent-a9f.jsonl'), entry(TREE_B));
    writeFileSync(join(agentsDir, 'agent-a9f.meta.json'), JSON.stringify({ toolUseId: 'toolu_1' }));
    const agent: SubagentInfo = { id: 'task-7', toolUseId: 'toolu_1', name: 'review', state: 'working', startedAt: 1 };
    expect(trees.places(row, [agent], false).otherTrees.map((t) => t.root)).toEqual([TREE_B]);
  });
});

describe('WorkingTrees.moved', () => {
  it('reports a new tree once, and nothing for a line in the same tree', () => {
    const { trees, row, transcript } = setup();
    writeFileSync(transcript, entry(REPO));
    trees.places(row, [], false);
    appendFileSync(transcript, entry(`${REPO}/web`));
    expect(trees.moved(row, [], false)).toBe(false);
    appendFileSync(transcript, entry(TREE_A));
    expect(trees.moved(row, [], false)).toBe(true);
    appendFileSync(transcript, entry(`${TREE_A}/web`));
    expect(trees.moved(row, [], false)).toBe(false);
    expect(trees.sessionsAt([TREE_A])).toEqual(['s1']);
  });
});

describe('file sandboxes', () => {
  /** A home with a worktree in it, both holding `notes.md`, and the session's transcript. */
  function twoTrees() {
    const base = makeTmpDir('sandbox');
    const home = join(base, 'repo');
    const tree = join(home, '.claude', 'worktrees', 'a');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(home, 'notes.md'), 'home');
    writeFileSync(join(tree, 'notes.md'), 'tree');
    writeFileSync(join(home, 'only-home.md'), 'home only');
    const projectsDir = join(base, 'projects');
    mkdirSync(join(projectsDir, 'proj'), { recursive: true });
    const row: TreeRow = { id: 's1', cwd: home, project_dir: 'proj', claude_dir_id: 1 };
    const trees = new WorkingTrees({ transcriptPath: (id, projectDir) => join(projectsDir, projectDir, `${id}.jsonl`), git: fakeGit([home, tree]) });
    const read = (cwd: string | undefined, path: string) =>
      readInSandboxes(trees.sandboxes(row, cwd), (dir) => readFilePreview(dir, path));
    return { home, tree, row, trees, read, transcript: trees.transcriptOf(row) };
  }

  it('reads from a cwd the transcripts recorded, a subagent\'s included', () => {
    const { home, tree, read, transcript } = twoTrees();
    writeFileSync(transcript, entry(home));
    expect(read(home, 'notes.md')).toMatchObject({ kind: 'ok', content: 'home' });
    const agents = subagentDirOf(transcript);
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'agent-x.jsonl'), entry(tree));
    expect(read(tree, 'notes.md')).toMatchObject({ kind: 'ok', content: 'tree' });
  });

  it('confines to the recorded cwd alone: a file only in the home is outside it', () => {
    const { home, tree, read, transcript } = twoTrees();
    writeFileSync(transcript, entry(home) + entry(tree));
    expect(read(tree, 'only-home.md').kind).toBe('not_found');
    expect(read(tree, '../../../only-home.md').kind).toBe('outside');
  });

  it('ignores a cwd the transcripts never recorded', () => {
    const { home, read, transcript } = twoTrees();
    writeFileSync(transcript, entry(home));
    expect(read('/', 'etc/hosts').kind).toBe('not_found');
    expect(read('/', 'notes.md')).toMatchObject({ kind: 'ok', content: 'home' });
  });

  it('without a cwd, tries the working tree first, then the home', () => {
    const { home, tree, read, transcript } = twoTrees();
    writeFileSync(transcript, entry(home) + entry(tree));
    expect(read(undefined, 'notes.md')).toMatchObject({ kind: 'ok', content: 'tree' });
    expect(read(undefined, 'only-home.md')).toMatchObject({ kind: 'ok', content: 'home only' });
    expect(read(undefined, 'missing.md').kind).toBe('not_found');
  });

  it('answers with the home\'s refusal when no sandbox has the file', () => {
    expect(fileSandboxes('/h', '/t', undefined, () => new Set())).toEqual(['/t', '/h']);
    expect(fileSandboxes('/h', '/h', undefined, () => new Set())).toEqual(['/h']);
    const answers: Record<string, { kind: string }> = { '/t': { kind: 'not_found' }, '/h': { kind: 'outside' } };
    expect(readInSandboxes(['/t', '/h'], (dir) => answers[dir])).toEqual({ kind: 'outside' });
  });
});

describe('enclosingRoot', () => {
  // `/repo` is a checkout; `/repo/.claude/worktrees/w` a worktree nested in it.
  const treeRoot = (dir: string) =>
    dir.startsWith('/repo/.claude/worktrees/w') ? '/repo/.claude/worktrees/w' : dir.startsWith('/repo') ? '/repo' : null;

  it('falls back from a subdirectory the agent cd-ed into to the session tree around it', () => {
    expect(enclosingRoot('/repo/e2e', ['/repo', '/home'], treeRoot)).toBe('/repo');
    expect(fileSandboxes('/repo', '/repo', '/repo/e2e', () => new Set(['/repo/e2e']), treeRoot)).toEqual([
      '/repo/e2e',
      '/repo',
    ]);
  });

  it('never climbs out of a nested worktree into the checkout that holds it', () => {
    expect(enclosingRoot('/repo/.claude/worktrees/w/web', ['/repo'], treeRoot)).toBeNull();
    expect(enclosingRoot('/repo/.claude/worktrees/w/web', ['/repo', '/repo/.claude/worktrees/w'], treeRoot)).toBe(
      '/repo/.claude/worktrees/w'
    );
  });

  it('takes the deepest directory of the session that holds it, and nothing outside a git tree', () => {
    expect(enclosingRoot('/repo/a/b/c', ['/repo', '/repo/a'], treeRoot)).toBe('/repo/a');
    expect(enclosingRoot('/repo', ['/repo'], treeRoot)).toBeNull();
    expect(enclosingRoot('/tmp/x', ['/tmp'], treeRoot)).toBeNull();
  });
});
