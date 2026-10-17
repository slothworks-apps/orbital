import { RESERVED_SEGMENTS } from '@orbital/shared/remote/segments';

/**
 * What another member of the group — a phone, a desktop, a headless server —
 * may call on this device through its channel. One literal list for every
 * member, not a pattern: every route is named, and a new route on the server
 * is NOT reachable from any member until someone adds it here (ADR
 * every-member-reaches-one-literal-allowlist, spec
 * 2026-10-16-device-group-design § 6). What is missing is as deliberate as
 * what is present.
 *
 * Never on it, on purpose:
 * - the IDE bridge (`/api/sessions/:id/ide/…`) and anything that opens an
 *   editor: it acts on this machine's screen, not on the asker's;
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
export const ALLOWED_ROUTES: readonly (readonly [method: string, template: string])[] = [
  ['GET', '/api/health'],
  ['GET', '/api/sessions'],
  ['GET', '/api/sessions/count'],
  ['GET', '/api/sessions/defaults'],
  ['POST', '/api/sessions'],
  ['GET', '/api/sessions/:id'],
  ['PATCH', '/api/sessions/:id'],
  ['GET', '/api/sessions/:id/messages'],
  ['GET', '/api/sessions/:id/media'],
  ['POST', '/api/sessions/:id/messages'],
  ['GET', '/api/sessions/:id/subagents/:toolUseId/messages'],
  ['POST', '/api/sessions/:id/tasks/:taskId/stop'],
  ['GET', '/api/sessions/:id/tasks/:taskId/output'],
  ['PUT', '/api/sessions/:id/pinned'],
  ['PUT', '/api/sessions/:id/tags'],
  ['POST', '/api/sessions/:id/decision/:decisionId'],
  ['POST', '/api/sessions/:id/interrupt'],
  ['POST', '/api/sessions/:id/model'],
  ['POST', '/api/sessions/:id/permission-mode'],
  ['POST', '/api/sessions/:id/end'],
  ['POST', '/api/sessions/:id/reopen'],
  ['POST', '/api/sessions/:id/clear'],
  ['POST', '/api/sessions/:id/retitle'],
  // A session's harness, the whole set the detail panel uses.
  ['GET', '/api/sessions/:id/harness'],
  ['POST', '/api/sessions/:id/harness'],
  ['PATCH', '/api/sessions/:id/harness'],
  ['DELETE', '/api/sessions/:id/harness'],
  ['POST', '/api/sessions/:id/harness/carry'],
  ['GET', '/api/sessions/:id/harness/steps/:index/diff'],
  ['POST', '/api/sessions/:id/harness/steps/:index/approve'],
  ['POST', '/api/sessions/:id/harness/steps/:index/reopen'],
  ['POST', '/api/sessions/:id/harness/steps/:index/go-back'],
  ['POST', '/api/sessions/:id/harness/steps/:index/decide-myself'],
  ['POST', '/api/sessions/:id/rewind'],
  ['DELETE', '/api/sessions/:id/rewind'],
  ['POST', '/api/sessions/:id/limit-wait/cancel'],
  ['POST', '/api/sessions/:id/limit-wait/undo'],
  ['GET', '/api/sessions/:id/walkthrough'],
  ['GET', '/api/sessions/:id/walkthrough/summary'],
  ['POST', '/api/sessions/:id/walkthrough/narrate'],
  // A session's MCP servers. A server whose name has a character outside
  // `SAFE_SEGMENT` cannot be reached by name.
  ['GET', '/api/sessions/:id/mcp'],
  ['POST', '/api/sessions/:id/mcp'],
  ['POST', '/api/sessions/:id/mcp/restart'],
  ['PUT', '/api/sessions/:id/mcp/:name'],
  ['DELETE', '/api/sessions/:id/mcp/:name'],
  ['GET', '/api/sessions/:id/mcp/:name/config'],
  ['POST', '/api/sessions/:id/mcp/:name/enabled'],
  ['POST', '/api/sessions/:id/mcp/:name/login'],
  ['POST', '/api/sessions/:id/mcp/:name/reconnect'],
  ['GET', '/api/stats/sessions/:id'],
  // The detail panel's file preview and the composer's `@` and `/` completion.
  ['GET', '/api/files'],
  ['GET', '/api/files/complete'],
  ['GET', '/api/commands/content'],
  ['GET', '/api/tags'],
  ['POST', '/api/tags'],
  ['PATCH', '/api/tags/:id'],
  ['DELETE', '/api/tags/:id'],
  ['GET', '/api/projects'],
  // New Session's missing-directory line and its *Create and start* (spec
  // 2026-10-12-new-session-missing-directory-design § Phone), and the
  // folder chooser that browses another device one level at a time.
  ['GET', '/api/directory'],
  ['POST', '/api/directory'],
  ['GET', '/api/dirs'],
  ['GET', '/api/models'],
  ['GET', '/api/commands'],
  // The New Session question about a project's `.mcp.json` servers; its
  // answers ride `POST /api/sessions` (spec 2026-10-08-mcpjson-approval-design).
  ['GET', '/api/mcpjson'],
  // A federated Settings (spec 2026-10-16-device-group-design § 6). The
  // `remote_` keys stay this device's own: `PATCH /api/settings` refuses
  // them from a member.
  ['GET', '/api/settings'],
  ['PATCH', '/api/settings'],
  ['GET', '/api/tag-rules'],
  ['POST', '/api/tag-rules'],
  ['POST', '/api/tag-rules/preview'],
  ['PATCH', '/api/tag-rules/:id'],
  ['DELETE', '/api/tag-rules/:id'],
  ['GET', '/api/harness/templates'],
  ['POST', '/api/harness/templates'],
  ['POST', '/api/harness/templates/draft'],
  ['PUT', '/api/harness/templates/:id'],
  ['DELETE', '/api/harness/templates/:id'],
  ['POST', '/api/harness/templates/:id/duplicate'],
  ['GET', '/api/harness/projects'],
  ['GET', '/api/harness/interview'],
  ['POST', '/api/harness/interview'],
  ['GET', '/api/limits'],
  ['POST', '/api/limits/refresh'],
  ['GET', '/api/stats/overview'],
  ['GET', '/api/claude-dirs'],
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
 * Returns `rawPath` unchanged if `method`+`rawPath` is on the allowlist and
 * `rawPath` is already the exact string Fastify's router will see — or
 * `null` otherwise. Callers that forward the request (e.g. to `inject`)
 * must use the return value, never the input, so a rejected string is never
 * accidentally forwarded.
 */
export function allowedPath(method: string, rawPath: string): string | null {
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

  for (const [m, template] of ALLOWED_ROUTES) {
    if (m !== method) continue;
    const parts = template.slice(1).split('/');
    if (parts.length !== segments.length) continue;
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      if (parts[i].startsWith(':')) ok = !RESERVED_SEGMENTS.has(segments[i]);
      else ok = parts[i] === segments[i];
    }
    if (ok) return rawPath;
  }
  return null;
}

export function isAllowed(method: string, rawPath: string): boolean {
  return allowedPath(method, rawPath) !== null;
}
