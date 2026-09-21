import { homedir } from 'node:os';

/**
 * Turns a path the user typed into one the operating system can use.
 *
 * Paths reach Orbital through text inputs — the New Session dialog's project
 * directory, the `default_project_dir` setting — and a
 * person typing a path writes `~/Projects/x`. Nothing between that input and
 * `child_process.spawn` is a shell, so the tilde survives as a literal
 * directory name, the spawn fails with ENOENT deep inside the SDK, and the
 * session row is written for a session that never runs.  Expanding here, at
 * the point the string stops being text and becomes a path, is what keeps
 * that from happening.
 *
 * Only `~` alone and a leading `~/` expand. `~alice` names another user's
 * home, which the password database answers and we do not consult, and a
 * tilde anywhere else is an ordinary character in a directory name; rewriting
 * either would invent a path the user never asked for.
 */
export function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return homedir() + trimmed.slice(1);
  return trimmed;
}
