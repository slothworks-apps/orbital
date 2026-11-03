import { describe, expect, it } from 'vitest';
import { REQUEST_TIMEOUT_MS } from '../src/remote/channel.js';
import {
  WORKTREE_FETCH_REQUEST_TIMEOUT_MS, WORKTREE_LAUNCH_REQUEST_TIMEOUT_MS, leafOf, repoOfWorktreeDir,
  slowRequestTimeoutMs, stripOrigin, worktreeChoice,
} from '../src/worktree.js';

describe('the slow worktree routes', () => {
  it('are a fetch and a launch that asks for a worktree, nothing else', () => {
    expect(slowRequestTimeoutMs('POST', '/api/worktree/fetch', { cwd: '/r' })).toBe(WORKTREE_FETCH_REQUEST_TIMEOUT_MS);
    expect(slowRequestTimeoutMs('POST', '/api/worktree/fetch?machine=m', { cwd: '/r' })).toBe(WORKTREE_FETCH_REQUEST_TIMEOUT_MS);
    expect(slowRequestTimeoutMs('POST', '/api/sessions', { worktree: { base: 'main' } })).toBe(WORKTREE_LAUNCH_REQUEST_TIMEOUT_MS);
    expect(slowRequestTimeoutMs('POST', '/api/sessions', { worktree: null })).toBeNull();
    expect(slowRequestTimeoutMs('POST', '/api/sessions', { cwd: '/r' })).toBeNull();
    expect(slowRequestTimeoutMs('POST', '/api/sessions')).toBeNull();
    expect(slowRequestTimeoutMs('GET', '/api/worktree/fetch')).toBeNull();
    expect(slowRequestTimeoutMs('POST', '/api/sessions/x/end', { worktree: {} })).toBeNull();
    expect(WORKTREE_FETCH_REQUEST_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
  });
});

describe('worktree names and paths', () => {
  it('name the directory after the branch’s last segment', () => {
    expect(leafOf('feat/tray-flicker')).toBe('tray-flicker');
    expect(leafOf('a/b/c')).toBe('c');
    expect(leafOf('main')).toBe('main');
    expect(leafOf('fix/')).toBe('fix');
  });

  it('strip only a leading origin/', () => {
    expect(stripOrigin('origin/fix/stack')).toBe('fix/stack');
    expect(stripOrigin('fix/origin/x')).toBe('fix/origin/x');
    expect(stripOrigin('main')).toBe('main');
  });

  it('stand a worktree in for its repository', () => {
    expect(repoOfWorktreeDir('/w/orbital/.claude/worktrees/tray')).toBe('/w/orbital');
    expect(repoOfWorktreeDir('/w/orbital/.claude/worktrees/tray/server')).toBe('/w/orbital');
    expect(repoOfWorktreeDir('/w/orbital')).toBe('/w/orbital');
    expect(repoOfWorktreeDir('/w/orbital/.claude')).toBe('/w/orbital/.claude');
    expect(repoOfWorktreeDir('/w/orbital/.claude/worktrees/')).toBe('/w/orbital/.claude/worktrees/');
  });
});

describe('the removal variant', () => {
  const base = { uncommittedFiles: 0, unpushedCommits: 0, sharedWith: [], ended: true, orbital: true };

  it('picks c3 over c2a over c2b over c1', () => {
    expect(worktreeChoice(base).variant).toBe('c1');
    expect(worktreeChoice({ ...base, unpushedCommits: 2 }).variant).toBe('c2b');
    expect(worktreeChoice({ ...base, unpushedCommits: 2, uncommittedFiles: 3 }).variant).toBe('c2a');
    expect(worktreeChoice({ ...base, uncommittedFiles: 3, sharedWith: ['s2'] }).variant).toBe('c3');
  });

  it('never offers a shared tree or a live terminal session, and ends a live Orbital one first', () => {
    expect(worktreeChoice({ ...base, sharedWith: ['s2'] })).toMatchObject({ removable: false, endsSession: false });
    expect(worktreeChoice({ ...base, ended: false, orbital: false })).toMatchObject({ removable: false, endsSession: false });
    expect(worktreeChoice({ ...base, ended: true, orbital: false })).toMatchObject({ removable: true, endsSession: false });
    expect(worktreeChoice({ ...base, ended: false, orbital: true })).toMatchObject({ removable: true, endsSession: true });
  });
});
