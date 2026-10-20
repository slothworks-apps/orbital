import { execRunner, ghEnv, LOGGED_OUT, resolveGh, type GhOpts } from '../git/branchStatus.js';

/**
 * Files an issue on Orbital's own repository with the user's `gh` login
 * (spec 2026-10-20-report-to-github-design). The web shows the title and body
 * first; what reaches here is what the user saw and sent.
 */

/** The one repository an issue can go to; a request cannot name another. */
export const ISSUE_REPO = 'slothworks-apps/orbital';

/** GitHub refuses a longer title. */
export const MAX_TITLE_CHARS = 256;

/** GitHub refuses a longer body. */
export const MAX_BODY_CHARS = 65_536;

/** `gh api user` goes to the network. */
const GH_LOGIN_TIMEOUT_MS = 10_000;

/** `gh issue create` goes to the network. */
const GH_ISSUE_TIMEOUT_MS = 30_000;

export type IssueResult =
  | { kind: 'created'; url: string }
  | { kind: 'unavailable'; reason: 'missing' | 'logged_out' }
  | { kind: 'failed'; message: string };

/** The issue URL `gh issue create` prints on its last line. */
export function parseIssueUrl(stdout: string): string | null {
  const line = stdout.trim().split('\n').pop()?.trim() ?? '';
  const prefix = `https://github.com/${ISSUE_REPO}/issues/`;
  return line.startsWith(prefix) && /^\d+$/.test(line.slice(prefix.length)) ? line : null;
}

/**
 * No `--label`: labels need triage rights on the repository, which someone
 * reporting from Orbital does not have, and `gh` refuses the whole issue then.
 */
export async function createIssue(
  issue: { title: string; body: string },
  opts: GhOpts = {},
): Promise<IssueResult> {
  const gh = (opts.resolve ?? resolveGh)();
  if (!gh) return { kind: 'unavailable', reason: 'missing' };
  const run = opts.run ?? execRunner;
  const res = await run(
    gh,
    ['issue', 'create', '--repo', ISSUE_REPO, '--title', issue.title, '--body', issue.body],
    { env: ghEnv(), timeout: opts.timeoutMs ?? GH_ISSUE_TIMEOUT_MS },
  );
  if (res.timedOut) return { kind: 'failed', message: 'gh did not answer in time' };
  if (res.code === 0) {
    const url = parseIssueUrl(res.stdout);
    return url ? { kind: 'created', url } : { kind: 'failed', message: 'gh did not return the issue address' };
  }
  if (LOGGED_OUT.test(res.stderr)) return { kind: 'unavailable', reason: 'logged_out' };
  return { kind: 'failed', message: res.stderr.trim() || `gh exited with ${res.code ?? 'no code'}` };
}

/** The account `gh` is logged in as, for "as @login · gh"; null without gh or a login. */
export async function ghLogin(opts: GhOpts = {}): Promise<string | null> {
  const gh = (opts.resolve ?? resolveGh)();
  if (!gh) return null;
  const res = await (opts.run ?? execRunner)(gh, ['api', 'user', '--jq', '.login'], {
    env: ghEnv(),
    timeout: opts.timeoutMs ?? GH_LOGIN_TIMEOUT_MS,
  });
  const login = res.code === 0 ? res.stdout.trim() : '';
  // GitHub logins are letters, digits and single hyphens.
  return /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : null;
}
