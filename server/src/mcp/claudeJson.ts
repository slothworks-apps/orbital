import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpScope, McpServerDefinition } from '../types.js';

/**
 * The one read Orbital does of the CLI's MCP config itself: `~/.claude.json`,
 * for the edit form and for which rows are editable (spec
 * 2026-10-01-mcp-servers-in-the-session-design § Config). Read-only, like the
 * command catalog's reads — every write goes through `claude mcp`
 * (adr mcp-config-is-written-by-the-cli-in-private-scopes).
 *
 * Best-effort, as a file the CLI rewrites constantly has to be: a missing or
 * half-written file reads as no servers, never as an error.
 */

/** A server the reader found, and its definition — `null` when the entry is not one it understands. */
export interface ConfiguredServer {
  scope: McpScope;
  definition: McpServerDefinition | null;
}

/** The servers in the two scopes Orbital writes, for one project. */
export interface McpConfigSnapshot {
  /**
   * The entry the CLI would run under this name: `local` before `user`, the
   * CLI's own precedence. `undefined` when neither scope has it.
   */
  find(name: string): ConfiguredServer | undefined;
}

/** Where the CLI keeps its global config: `$CLAUDE_CONFIG_DIR/.claude.json` when set, else the home directory's. */
export function claudeJsonPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return join(dir || home, '.claude.json');
}

/** Only these keys are understood; an entry with any other is not edited, so an edit can never drop one. */
const STDIO_KEYS = new Set(['type', 'command', 'args', 'env']);
const REMOTE_KEYS = new Set(['type', 'url', 'headers']);

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

/**
 * One `mcpServers` entry as the form's definition, or `null` when it is not a
 * shape the form can show and write back unchanged. A stdio entry may omit
 * `type` (the CLI's older spelling); every other shape must name it.
 */
export function toDefinition(name: string, scope: McpScope, raw: unknown): McpServerDefinition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const type = entry.type ?? 'stdio';
  if (type === 'stdio') {
    if (Object.keys(entry).some((k) => !STDIO_KEYS.has(k))) return null;
    if (typeof entry.command !== 'string' || !entry.command) return null;
    const args = entry.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return null;
    const env = entry.env ?? {};
    if (!isStringRecord(env)) return null;
    return { name, scope, transport: 'stdio', command: entry.command, args: [...args], env: { ...env } };
  }
  if (type === 'http' || type === 'sse') {
    if (Object.keys(entry).some((k) => !REMOTE_KEYS.has(k))) return null;
    if (typeof entry.url !== 'string' || !entry.url) return null;
    const headers = entry.headers ?? {};
    if (!isStringRecord(headers)) return null;
    return { name, scope, transport: type, url: entry.url, headers: { ...headers } };
  }
  return null;
}

/** An object's own `mcpServers` map, or an empty one for anything else. */
function serversOf(holder: unknown): Record<string, unknown> {
  const servers = (holder as { mcpServers?: unknown } | null | undefined)?.mcpServers;
  return servers && typeof servers === 'object' && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {};
}

/**
 * Reads the snapshot for one project. The project is keyed by the REAL path of
 * its cwd — the CLI resolves `/tmp/…` to `/private/tmp/…` before it writes —
 * so the cwd goes through `realpath` first, falling back to itself when it no
 * longer exists. `readFile` and `realpath` are injected for tests.
 */
export function readMcpConfig(opts: {
  path: string;
  cwd: string;
  readFile?: (path: string) => string;
  realpath?: (path: string) => string;
}): McpConfigSnapshot {
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const realpath = opts.realpath ?? ((p: string) => realpathSync(p));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(opts.path));
  } catch {
    parsed = null;
  }
  let projectKey = opts.cwd;
  try {
    projectKey = realpath(opts.cwd);
  } catch {
    // A cwd that is gone keeps its own spelling; nothing better is known.
  }
  const projects = (parsed as { projects?: unknown } | null)?.projects;
  const project =
    projects && typeof projects === 'object' && Object.hasOwn(projects, projectKey)
      ? (projects as Record<string, unknown>)[projectKey]
      : undefined;
  const local = serversOf(project);
  const user = serversOf(parsed);
  return {
    find(name) {
      if (Object.hasOwn(local, name)) return { scope: 'local', definition: toDefinition(name, 'local', local[name]) };
      if (Object.hasOwn(user, name)) return { scope: 'user', definition: toDefinition(name, 'user', user[name]) };
      return undefined;
    },
  };
}
