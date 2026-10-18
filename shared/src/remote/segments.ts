/**
 * Literal route segments that would otherwise match a `:param` template.
 * Every literal sibling of a parameter belongs here, whether a member may
 * call it (`count`, `defaults`, `restart`, `preview`, `draft` — each passes
 * through its own literal template, for its one method only) or not
 * (`retention-preview`). Nothing a parameter names — a session, an MCP
 * server, a rule, a template — is ever named one of these, so a parameter
 * that spells one is a request aimed at the literal route. Here, not in the
 * server, because the phone routes a request by its session the same way.
 */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['retention-preview', 'count', 'defaults', 'restart', 'preview', 'draft']);

/** The session a per-session hub topic is about: `session:<id>`, `subagent:<id>:…`, `task-output:<id>:…`. */
export function sessionOfTopic(topic: string): string | null {
  const m = /^(?:session|subagent|task-output):([^:]+)/.exec(topic);
  return m ? m[1] : null;
}

/**
 * The session an API request is about, read off its path and query the way
 * the server routes it: `/api/sessions/:id…` or `/api/stats/sessions/:id…`
 * (never a `RESERVED_SEGMENTS` sibling of `:id`), else `?session=`, else the
 * harness's `?sessionId=`. Null when it names none, or an id that does not decode.
 */
export function sessionOfRequest(url: string): string | null {
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const m = /^\/api\/(?:stats\/)?sessions\/([^/?#]+)/.exec(path);
  if (m && !RESERVED_SEGMENTS.has(m[1])) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  }
  const params = new URLSearchParams(q < 0 ? '' : url.slice(q + 1));
  return params.get('session') ?? params.get('sessionId');
}
