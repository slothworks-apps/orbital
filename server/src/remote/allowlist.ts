/**
 * What a phone may call through the tunnel. A literal list, not a pattern:
 * every route is named, and a new route on the server is NOT reachable from
 * a phone until someone adds it here (spec 2026-09-30-mobile-remote-design
 * § 3). What is missing is as deliberate as what is present — see the spec's
 * Global Constraints in the backend plan for the denied set and why.
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
  // Answering a harness gate: read it, and the four answers. Starting,
  // removing, pausing, carrying or editing a harness and the step diff stay
  // off (spec 2026-10-05-mobile-next-design § 1 Server).
  ['GET', '/api/sessions/:id/harness'],
  ['POST', '/api/sessions/:id/harness/steps/:index/approve'],
  ['POST', '/api/sessions/:id/harness/steps/:index/reopen'],
  ['POST', '/api/sessions/:id/harness/steps/:index/go-back'],
  ['POST', '/api/sessions/:id/harness/steps/:index/decide-myself'],
  // Go back's rewind only; cancelling a pending rewind (`DELETE`) stays off.
  ['POST', '/api/sessions/:id/rewind'],
  ['POST', '/api/sessions/:id/limit-wait/cancel'],
  ['POST', '/api/sessions/:id/limit-wait/undo'],
  ['GET', '/api/sessions/:id/walkthrough'],
  ['GET', '/api/sessions/:id/walkthrough/summary'],
  ['GET', '/api/tags'],
  ['GET', '/api/projects'],
  ['GET', '/api/models'],
  ['GET', '/api/commands'],
  // The New Session question about a project's `.mcp.json` servers; its
  // answers ride `POST /api/sessions` (spec 2026-10-08-mcpjson-approval-design).
  ['GET', '/api/mcpjson'],
];

/**
 * Literal route segments that would otherwise match a `:id` template. Every
 * literal sibling of `:id` under `/api/sessions` belongs here, whether the
 * phone may call it (`count`, `defaults` — each passes through its own
 * literal template, for its one method only) or not (`retention-preview`).
 * No session is ever named one of these, so an `:id` that spells one is a
 * request aimed at the literal route, never at a session.
 */
const RESERVED_SEGMENTS = new Set(['retention-preview', 'count', 'defaults']);

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
