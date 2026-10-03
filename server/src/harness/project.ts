/**
 * The project a session belongs to, for template scopes (spec
 * 2026-10-02-harness-redesign-design § Agreed before the design): the git
 * repository's root, so every worktree of one repository is one project;
 * outside git, the directory itself.
 */

import { basename, dirname, join, resolve, sep } from 'node:path';
import { resolveGitDirs } from '../git/gitState.js';
import type { HarnessProject } from './types.js';

/**
 * The project root of a directory. A linked worktree maps to its main
 * working tree — the directory holding the shared `.git` — not to its own
 * toplevel. A submodule (its `.git` file points into the parent's
 * `.git/modules`) is its own project. Reads the filesystem only; spawns nothing.
 */
export function projectRootOf(cwd: string): string {
  const dirs = resolveGitDirs(cwd);
  if (!dirs) return resolve(cwd);
  if (!dirs.worktree) return dirs.root;
  // A linked worktree's git dir lives under `<common>/worktrees/<name>`.
  const linked = dirs.gitDir.startsWith(join(dirs.commonDir, 'worktrees') + sep);
  if (!linked) return dirs.root;
  // `<repo>/.git` → `<repo>`; a bare repository has no working tree, so its git dir names it.
  return basename(dirs.commonDir) === '.git' ? dirname(dirs.commonDir) : dirs.commonDir;
}

/** The name a project is shown under: its directory's basename. */
export function projectName(root: string): string {
  return basename(root) || root;
}

export function projectOf(cwd: string): HarnessProject {
  const root = projectRootOf(cwd);
  return { root, name: projectName(root) };
}
