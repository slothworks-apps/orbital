import { execRunner, ghEnv, resolveGh, type GhOpts } from '../git/branchStatus.js';
import { ISSUE_REPO } from './github.js';

/**
 * Issues already filed on Orbital's repository that look like the one about
 * to be sent (spec 2026-10-20-report-to-github-design → Before sending). With
 * `gh` the search runs on the user's login; without it, on GitHub's public
 * search API, which needs no login and allows a few searches a minute.
 */

export interface SimilarIssue {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
}

/** How many matches the review step shows. */
export const SIMILAR_LIMIT = 5;

/** Words the query keeps; GitHub's search ranks worse, not better, on a long one. */
const QUERY_WORDS = 8;

const SEARCH_TIMEOUT_MS = 10_000;

const PUBLIC_SEARCH_URL = 'https://api.github.com/search/issues';

/**
 * The words of a title worth searching on. Paths, URLs, hex and numbers name
 * this machine or this run, never the bug, so they go; so do GitHub's own
 * search qualifiers, which a title could otherwise smuggle in (`repo:`).
 */
export function searchWords(title: string): string[] {
  return title
    .split(/\s+/)
    .filter((token) => !/[/\\:@=]/.test(token))
    .map((token) => token.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((word) => word.length >= 3 && !/^[\d_-]+$/.test(word) && !/^(0x)?[0-9a-f]{8,}$/i.test(word))
    .slice(0, QUERY_WORDS);
}

export function toIssue(item: unknown, urlKey: 'url' | 'html_url'): SimilarIssue | null {
  if (!item || typeof item !== 'object') return null;
  const i = item as Record<string, unknown>;
  const state = typeof i.state === 'string' ? i.state.toLowerCase() : '';
  const url = i[urlKey];
  if (!Number.isInteger(i.number) || typeof i.title !== 'string' || typeof url !== 'string') return null;
  if (state !== 'open' && state !== 'closed') return null;
  // Only links into the one repository; a crafted answer cannot send the review step elsewhere.
  if (!url.startsWith(`https://github.com/${ISSUE_REPO}/issues/`)) return null;
  return { number: i.number as number, title: i.title, url, state };
}

/** Parses `gh search issues --json number,title,url,state`. */
export function parseGhSearch(stdout: string): SimilarIssue[] | null {
  try {
    const json = JSON.parse(stdout) as unknown;
    if (!Array.isArray(json)) return null;
    return json.map((item) => toIssue(item, 'url')).filter((i): i is SimilarIssue => i !== null);
  } catch {
    return null;
  }
}

/** Parses the public search API's answer. */
export function parsePublicSearch(json: unknown): SimilarIssue[] | null {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  return items.map((item) => toIssue(item, 'html_url')).filter((i): i is SimilarIssue => i !== null);
}

export interface SearchOpts extends GhOpts {
  fetch?: typeof fetch;
}

/**
 * Up to `SIMILAR_LIMIT` issues, open or closed, matching the title's words.
 * Null when neither way could search — the review step then just says
 * nothing about duplicates rather than claiming there are none.
 */
export async function findSimilarIssues(title: string, opts: SearchOpts = {}): Promise<SimilarIssue[] | null> {
  const words = searchWords(title);
  if (words.length === 0) return [];

  const gh = (opts.resolve ?? resolveGh)();
  if (gh) {
    const res = await (opts.run ?? execRunner)(
      gh,
      ['search', 'issues', '--repo', ISSUE_REPO, '--json', 'number,title,url,state',
        '--limit', String(SIMILAR_LIMIT), '--', ...words],
      { env: ghEnv(), timeout: opts.timeoutMs ?? SEARCH_TIMEOUT_MS },
    );
    const found = res.code === 0 ? parseGhSearch(res.stdout) : null;
    if (found) return found;
    // A logged-out gh still leaves the public search.
  }

  const q = `${words.join(' ')} repo:${ISSUE_REPO} is:issue`;
  const url = `${PUBLIC_SEARCH_URL}?${new URLSearchParams({ q, per_page: String(SIMILAR_LIMIT) })}`;
  try {
    const res = await (opts.fetch ?? fetch)(url, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? SEARCH_TIMEOUT_MS),
    });
    return res.ok ? parsePublicSearch(await res.json()) : null;
  } catch {
    return null;
  }
}
