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
