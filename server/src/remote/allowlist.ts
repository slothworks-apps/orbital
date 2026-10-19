import { RESERVED_SEGMENTS } from '@orbital/shared/remote/segments';
import type { GrantGroup } from './grants.js';

/**
 * What another member of the group — a phone, a desktop, a headless server —
 * may call on this device through its channel. One literal list for every
 * member, not a pattern: every route is named, and a new route on the server
 * is NOT reachable from any member until someone adds it here (ADR
 * every-member-reaches-one-literal-allowlist, spec
 * 2026-10-16-device-group-design § 6). What is missing is as deliberate as
 * what is present.
 *
 * Every route belongs to exactly one grant group (sessions | spawn | settings |
 * manage | ide), which determines whether a member may call it based on the
 * grants this device gave them (spec 2026-10-19-member-grants-design § 1).
 *
 * IDE routes are now on the list behind the `ide` grant (off by default).
 * Routes for this device's upkeep (Claude directories, errors, branch status,
 * model validation, retention preview, session tips) are on the list behind
 * the `manage` grant (off by default).
 *
 * Never on the list, on purpose:
 * - the dev tools (`/api/dev/…`), `/api/auth` and `/api/remote…` — the group
 *   itself changes through roster messages in the channel, never a route;
 * - `PUT /api/presence`: whether the user is at this machine is this
 *   machine's to say;
 * - the terminals (`/api/sessions/:id/terminals`, `/api/terminals/…`);
 * - the binary reads `GET /api/images/:ref` and `GET /api/files/image`, which
 *   travel as `blob_get`/`file_get` asks, and the multipart uploads
 *   (`/api/attachments`, `/api/sessions/:id/attachments`), whose bytes travel
 *   as `blob_put`.
 *
 * `allowedPath` below checks two independent things, and both are required.
 * First, the raw request string must already equal the canonical form the
 * WHATWG URL parser would produce for it — the same normalization Node's
 * HTTP stack (and therefore Fastify's router) applies before routing, which
 * turns `\` into `/`, resolves `..`, drops anything after `#`, and so on.
 * Second, once canonical, every path segment must be restricted to a safe
 * alphabet. Canonical-but-unrestricted lets a segment like `%2e%2e` or an
 * encoded slash through structurally even though it never changes under
 * normalization; restricted-but-uncanonical lets a non-canonical string
 * (one the real router would rewrite before matching it) pass a check that
 * only looked at its segments. Either half alone is bypassable; together
 * they guarantee the string we approve is the exact string Fastify will
 * route, and that string only has characters we've reasoned about.
 */
export const ALLOWED_ROUTES: readonly (readonly [method: string, template: string, group: GrantGroup])[] = [
  // sessions group: read and drive sessions
  ['GET', '/api/health', 'sessions'],
  ['GET', '/api/sessions', 'sessions'],
  ['GET', '/api/sessions/count', 'sessions'],
  ['GET', '/api/sessions/defaults', 'sessions'],
  ['GET', '/api/sessions/:id', 'sessions'],
  ['PATCH', '/api/sessions/:id', 'sessions'],
  ['GET', '/api/sessions/:id/messages', 'sessions'],
  ['GET', '/api/sessions/:id/media', 'sessions'],
  ['POST', '/api/sessions/:id/messages', 'sessions'],
  ['GET', '/api/sessions/:id/subagents/:toolUseId/messages', 'sessions'],
  ['POST', '/api/sessions/:id/tasks/:taskId/stop', 'sessions'],
  ['GET', '/api/sessions/:id/tasks/:taskId/output', 'sessions'],
  ['PUT', '/api/sessions/:id/pinned', 'sessions'],
  ['PUT', '/api/sessions/:id/docked', 'sessions'],
  ['PUT', '/api/sessions/:id/tags', 'sessions'],
  ['POST', '/api/sessions/:id/decision/:decisionId', 'sessions'],
  ['POST', '/api/sessions/:id/interrupt', 'sessions'],
  ['POST', '/api/sessions/:id/model', 'sessions'],
  ['POST', '/api/sessions/:id/permission-mode', 'sessions'],
  ['POST', '/api/sessions/:id/end', 'sessions'],
  ['POST', '/api/sessions/:id/reopen', 'sessions'],
  ['POST', '/api/sessions/:id/clear', 'sessions'],
  ['POST', '/api/sessions/:id/retitle', 'sessions'],
  // A session's harness, the whole set the detail panel uses.
  ['GET', '/api/sessions/:id/harness', 'sessions'],
  ['POST', '/api/sessions/:id/harness', 'sessions'],
  ['PATCH', '/api/sessions/:id/harness', 'sessions'],
  ['DELETE', '/api/sessions/:id/harness', 'sessions'],
  ['POST', '/api/sessions/:id/harness/carry', 'sessions'],
  ['GET', '/api/sessions/:id/harness/steps/:index/diff', 'sessions'],
  ['POST', '/api/sessions/:id/harness/steps/:index/approve', 'sessions'],
  ['POST', '/api/sessions/:id/harness/steps/:index/reopen', 'sessions'],
  ['POST', '/api/sessions/:id/harness/steps/:index/go-back', 'sessions'],
  ['POST', '/api/sessions/:id/harness/steps/:index/decide-myself', 'sessions'],
  ['POST', '/api/sessions/:id/rewind', 'sessions'],
  ['DELETE', '/api/sessions/:id/rewind', 'sessions'],
  ['POST', '/api/sessions/:id/limit-wait/cancel', 'sessions'],
  ['POST', '/api/sessions/:id/limit-wait/undo', 'sessions'],
  ['GET', '/api/sessions/:id/walkthrough', 'sessions'],
  ['GET', '/api/sessions/:id/walkthrough/summary', 'sessions'],
  ['POST', '/api/sessions/:id/walkthrough/narrate', 'sessions'],
  // A session's MCP servers. A server whose name has a character outside
  // `SAFE_SEGMENT` cannot be reached by name.
  ['GET', '/api/sessions/:id/mcp', 'sessions'],
  ['POST', '/api/sessions/:id/mcp', 'sessions'],
  ['POST', '/api/sessions/:id/mcp/restart', 'sessions'],
  ['PUT', '/api/sessions/:id/mcp/:name', 'sessions'],
  ['DELETE', '/api/sessions/:id/mcp/:name', 'sessions'],
  ['GET', '/api/sessions/:id/mcp/:name/config', 'sessions'],
  ['POST', '/api/sessions/:id/mcp/:name/enabled', 'sessions'],
  ['POST', '/api/sessions/:id/mcp/:name/login', 'sessions'],
  ['POST', '/api/sessions/:id/mcp/:name/reconnect', 'sessions'],
  ['GET', '/api/stats/sessions/:id', 'sessions'],
  // The detail panel's file preview and the composer's `@` and `/` completion.
  ['GET', '/api/files', 'sessions'],
  ['GET', '/api/files/complete', 'sessions'],
  ['GET', '/api/commands/content', 'sessions'],
  ['GET', '/api/tags', 'sessions'],
  ['POST', '/api/tags', 'sessions'],
  ['PATCH', '/api/tags/:id', 'sessions'],
  ['DELETE', '/api/tags/:id', 'sessions'],
  ['GET', '/api/projects', 'sessions'],

  // spawn group: start sessions
  ['POST', '/api/sessions', 'spawn'],
  // New Session's missing-directory line and its *Create and start* (spec
  // 2026-10-12-new-session-missing-directory-design § Phone), and the
  // folder chooser that browses another device one level at a time.
  ['GET', '/api/directory', 'spawn'],
  ['POST', '/api/directory', 'spawn'],
  ['GET', '/api/dirs', 'spawn'],
  ['GET', '/api/models', 'spawn'],
  ['GET', '/api/commands', 'spawn'],
  // The New Session question about a project's `.mcp.json` servers; its
  // answers ride `POST /api/sessions` (spec 2026-10-08-mcpjson-approval-design).
  ['GET', '/api/mcpjson', 'spawn'],
  // The question's *View file*: the one project file `.mcp.json` names, read
  // on the device the session would run on.
  ['GET', '/api/mcpjson/file', 'spawn'],

  // settings group: settings, tags, tag rules, harness templates
  // A federated Settings (spec 2026-10-16-device-group-design § 6). The
  // `remote_` keys stay this device's own: `PATCH /api/settings` refuses
  // them from a member.
  ['GET', '/api/settings', 'settings'],
  ['PATCH', '/api/settings', 'settings'],
  ['GET', '/api/tag-rules', 'settings'],
  ['POST', '/api/tag-rules', 'settings'],
  ['POST', '/api/tag-rules/preview', 'settings'],
  ['PATCH', '/api/tag-rules/:id', 'settings'],
  ['DELETE', '/api/tag-rules/:id', 'settings'],
  ['GET', '/api/harness/templates', 'settings'],
  ['POST', '/api/harness/templates', 'settings'],
  ['POST', '/api/harness/templates/draft', 'settings'],
  ['PUT', '/api/harness/templates/:id', 'settings'],
  ['DELETE', '/api/harness/templates/:id', 'settings'],
  ['POST', '/api/harness/templates/:id/duplicate', 'settings'],
  ['GET', '/api/harness/projects', 'settings'],
  ['GET', '/api/harness/interview', 'settings'],
  ['POST', '/api/harness/interview', 'settings'],
  ['GET', '/api/limits', 'settings'],
  ['POST', '/api/limits/refresh', 'settings'],
  ['GET', '/api/stats/overview', 'settings'],
  ['GET', '/api/claude-dirs', 'settings'],

  // manage group: this device's upkeep (off by default)
  ['POST', '/api/claude-dirs', 'manage'],
  ['PATCH', '/api/claude-dirs/:id', 'manage'],
  ['DELETE', '/api/claude-dirs/:id', 'manage'],
  ['GET', '/api/errors', 'manage'],
  ['POST', '/api/errors/seen', 'manage'],
  ['GET', '/api/gh-status', 'manage'],
  ['POST', '/api/branch-status/refresh', 'manage'],
  ['POST', '/api/models/validate', 'manage'],
  ['GET', '/api/sessions/retention-preview', 'manage'],
  ['GET', '/api/session-instructions/tips', 'manage'],

  // ide group: IDE bridge (off by default)
  ['GET', '/api/sessions/:id/ide/open-files', 'ide'],
  ['POST', '/api/sessions/:id/ide/open-file', 'ide'],
  ['GET', '/api/sessions/:id/ide/diagnostics', 'ide'],
];

/** Literal siblings of a `:param` segment; shared, since the phone routes by session too. */
export { RESERVED_SEGMENTS };

/** A segment restricted to this alphabet can't spell `.`, `..`, a `%`-escape, or be empty. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Control characters, DEL and anything past ASCII, by UTF-16 code unit. A
 * loop rather than a character-class regex: lint's `no-control-regex`
 * rejects control characters in a regex even when written as escapes.
 */
function hasNonPrintableAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c >= 0x7f) return true;
  }
  return false;
}

/**
 * The result of checking whether a path is allowed and what grant it requires.
 */
export type AllowedPathResult = {
  /** The canonical path, never different from input. */
  path: string;
  /** The grant group required to access this path. */
  group: GrantGroup;
};

/**
 * Returns path info if `method`+`rawPath` is on the allowlist and `rawPath`
 * is already the exact string Fastify's router will see — or `null` otherwise.
 * Callers that forward the request (e.g. to `inject`) must use the return
 * value's path, never the input, so a rejected string is never accidentally forwarded.
 */
export function allowedPath(method: string, rawPath: string): AllowedPathResult | null {
  // Reject anything the WHATWG URL parser (what the router effectively
  // runs) would rewrite into a different destination: `\` becomes `/`,
  // `#` starts a fragment that never reaches the server, control
  // characters and other whitespace are stripped or mangled, and non-ASCII
  // characters get percent-encoded.
  if (
    rawPath.includes('\\') ||
    rawPath.includes('#') ||
    hasNonPrintableAscii(rawPath) ||
    /\s/.test(rawPath)
  ) return null;
  if (!rawPath.startsWith('/')) return null;

  let url: URL;
  try {
    url = new URL(rawPath, 'http://localhost');
  } catch {
    return null;
  }
  // The raw string must already be canonical: nothing the parser would
  // change (dot segments, percent-decoded dot segments, etc.).
  if (url.pathname + url.search !== rawPath) return null;

  // No trailing-slash stripping: a trailing slash is a different segment
  // shape (an empty final segment) and Fastify is not configured with
  // ignoreTrailingSlash, so it would route differently (typically a 404).
  const segments = url.pathname.slice(1).split('/');
  if (segments.some((s) => !SAFE_SEGMENT.test(s))) return null;

  for (const [m, template, group] of ALLOWED_ROUTES) {
    if (m !== method) continue;
    const parts = template.slice(1).split('/');
    if (parts.length !== segments.length) continue;
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      if (parts[i].startsWith(':')) ok = !RESERVED_SEGMENTS.has(segments[i]);
      else ok = parts[i] === segments[i];
    }
    if (ok) return { path: rawPath, group };
  }
  return null;
}

/**
 * Check if a path is allowed (does not check grants, only allowlist).
 */
export function isAllowed(method: string, rawPath: string): boolean {
  return allowedPath(method, rawPath) !== null;
}
