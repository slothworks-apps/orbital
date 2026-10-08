import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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
export function expandHome(path: string, home: string = homedir()): string {
  const trimmed = path.trim();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/')) return home + trimmed.slice(1);
  return trimmed;
}

/**
 * The path of the first Claude directory, `claude_dirs` row 1 (spec
 * 2026-10-04-multiple-claude-directories-design § 1).
 *
 * Four sources, most specific first:
 *
 * 1. `override` — `buildServer({ claudeDir })`, which only tests pass.
 * 2. `ORBITAL_CLAUDE_DIR` — an operator who exported a variable meant it, and
 *    should not have it quietly overruled by a row someone clicked into the
 *    settings table months ago.
 * 3. `stored` — what the row holds, or, when the row is first seeded, the
 *    retired `claude_directory` setting.
 * 4. `~/.claude`.
 *
 * Empty and whitespace-only count as unset at every level, because that is
 * what an emptied text field stores and it has to mean "go back to the
 * default" rather than "watch the current working directory". A typed `~`
 * expands here for the same reason it expands for a project directory
 * ([[tilde-expands-at-the-api-boundary]]): nothing downstream is a shell.
 * An absolute answer is `path.resolve`d, which drops a trailing slash the
 * way a shell's `CLAUDE_CONFIG_DIR=~/.claude-work/` would not — the CLI keys
 * its login on the exact string, so one spelling is kept.
 */
export function resolveClaudeDir(input: {
  override?: string;
  env?: string;
  stored?: string;
  home?: string;
}): string {
  const home = input.home ?? homedir();
  for (const candidate of [input.override, input.env, input.stored]) {
    if (typeof candidate !== 'string') continue;
    const expanded = expandHome(candidate, home);
    if (expanded !== '') return isAbsolute(expanded) ? resolve(expanded) : expanded;
  }
  return join(home, '.claude');
}
