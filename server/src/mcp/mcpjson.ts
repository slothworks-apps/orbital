import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeJsonPathFor } from '../claudeDirs/paths.js';

/**
 * Which servers of a project's `.mcp.json` nobody has approved or turned
 * down yet, and recording the user's answer (spec
 * 2026-10-08-mcpjson-approval-design § Server). The SDK starts every
 * `.mcp.json` server that is not in `disabledMcpjsonServers`, so whatever
 * this module finds undecided is what `Runner.start` keeps out.
 *
 * Reads are best-effort and fail safe: a missing or unreadable decision file
 * decides nothing, so its servers stay undecided — kept out — rather than
 * let in. An unreadable `.mcp.json` names no servers, so there is nothing
 * to keep out.
 */

/** One undecided server, as the question shows it: what would run. */
export interface McpjsonServer {
  name: string;
  /**
   * The command as written; for an `http` or `sse` server, which runs
   * nothing locally, its `url`. Empty when the entry names neither.
   */
  command: string;
  args: string[];
}

/** The user's answer, by server name. */
export interface McpjsonDecisions {
  allow: string[];
  deny: string[];
}

const ENABLED = 'enabledMcpjsonServers';
const DISABLED = 'disabledMcpjsonServers';
const ENABLE_ALL = 'enableAllProjectMcpServers';

/** Where the CLI keeps a project's own decisions, and where Orbital records them. */
export function localSettingsPath(cwd: string): string {
  return join(cwd, '.claude', 'settings.local.json');
}

/**
 * A name as the CLI compares it: everything outside `[A-Za-z0-9_-]` reads
 * as `_`, so `my.server` in `.mcp.json` and `my_server` in a decision list
 * are one server.
 */
function nameKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A file's JSON object, or null for a missing, unreadable or non-object file. */
function readObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The project's entry in a `.claude.json`, keyed by the real path of its cwd as the CLI writes it. */
function claudeJsonProject(path: string, cwd: string): Record<string, unknown> | null {
  const projects = readObject(path)?.projects;
  if (!isObject(projects)) return null;
  let key = cwd;
  try {
    key = realpathSync(cwd);
  } catch {
    // A cwd that is gone keeps its own spelling.
  }
  const entry = Object.hasOwn(projects, key) ? projects[key] : undefined;
  return isObject(entry) ? entry : null;
}

/** The servers `.mcp.json` names, in its order; empty when it is missing or unreadable. */
function mcpjsonServers(cwd: string): McpjsonServer[] {
  const servers = readObject(join(cwd, '.mcp.json'))?.mcpServers;
  if (!isObject(servers)) return [];
  return Object.entries(servers).map(([name, raw]) => {
    const entry = isObject(raw) ? raw : {};
    if (typeof entry.command === 'string') return { name, command: entry.command, args: stringList(entry.args) };
    return { name, command: typeof entry.url === 'string' ? entry.url : '', args: [] };
  });
}

/**
 * The servers of `<cwd>/.mcp.json` that no decision source names. The four
 * sources: `settings.json` in `claudeDir`, the project's
 * `.claude/settings.json` and `.claude/settings.local.json`, and the
 * project's entry in that directory's `.claude.json`. A name in either list
 * of any of them is decided; `enableAllProjectMcpServers: true` in any of
 * them decides every server. `home` is injected for tests.
 */
export function undecidedServers(cwd: string, claudeDir: string, opts: { home?: string } = {}): McpjsonServer[] {
  const servers = mcpjsonServers(cwd);
  if (servers.length === 0) return [];
  const sources = [
    readObject(join(claudeDir, 'settings.json')),
    readObject(join(cwd, '.claude', 'settings.json')),
    readObject(localSettingsPath(cwd)),
    claudeJsonProject(claudeJsonPathFor(claudeDir, opts.home ?? homedir()), cwd),
  ];
  const decided = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    if (source[ENABLE_ALL] === true) return [];
    for (const name of [...stringList(source[ENABLED]), ...stringList(source[DISABLED])]) decided.add(nameKey(name));
  }
  return servers.filter((s) => !decided.has(nameKey(s.name)));
}

/**
 * Records the user's answer in `<cwd>/.claude/settings.local.json`, where
 * the CLI keeps it too: each allowed name joins `enabledMcpjsonServers` and
 * leaves `disabledMcpjsonServers`, each denied one the reverse. Every other
 * key is kept as it was. A file that exists but is not a JSON object is not
 * overwritten — this throws instead, and the user's file stays intact.
 *
 * The only write Orbital makes to that file (adr
 * mcp-config-is-written-by-the-cli-in-private-scopes): no CLI command
 * records an approval. Atomic, through a temp file and a rename, so the CLI
 * never reads it half-written.
 */
export function recordDecisions(cwd: string, decisions: McpjsonDecisions): void {
  const path = localSettingsPath(cwd);
  let current: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (text !== null && text.trim() !== '') {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) throw new Error(`${path} is not a JSON object`);
    current = parsed;
  }
  const allow = new Set(decisions.allow);
  const deny = new Set(decisions.deny);
  const merge = (list: unknown, add: Set<string>, remove: Set<string>): string[] => {
    const out = stringList(list).filter((n) => !remove.has(n));
    for (const name of add) if (!out.includes(name)) out.push(name);
    return [...new Set(out)];
  };
  const next = {
    ...current,
    [ENABLED]: merge(current[ENABLED], allow, deny),
    [DISABLED]: merge(current[DISABLED], deny, allow),
  };
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
