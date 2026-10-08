import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/**
 * Where a server's code comes from, read from its command (canvas 47e
 * "Source label"): a package runner's registry, a container, a file of the
 * project, a remote URL, or any other program on the machine.
 */
export type McpjsonSource = 'npm' | 'pypi' | 'docker' | 'file' | 'url' | 'program';

/** One undecided server, as the question shows it: what would run. */
export interface McpjsonServer {
  name: string;
  /**
   * The command as written; for an `http` or `sse` server, which runs
   * nothing locally, its `url`. Empty when the entry names neither.
   */
  command: string;
  args: string[];
  source: McpjsonSource;
  /** For `source: 'file'`, the path relative to the project, `/`-separated, for *View file*. */
  file?: string;
}

/** The user's answer, by server name. */
export interface McpjsonDecisions {
  allow: string[];
  deny: string[];
}

/**
 * Orbital's own record of what each allowed server ran when it was allowed
 * (spec § Behaviour 4), keyed by the project's real path and the server's
 * name. Injected so this module stays free of the database.
 */
export interface McpjsonFingerprints {
  /** The recorded hash of each server allowed in `project`, by name. */
  forProject(project: string): ReadonlyMap<string, string>;
  /** Records `allowed` (name → hash) and forgets every name in `denied`. */
  update(project: string, allowed: ReadonlyMap<string, string>, denied: readonly string[]): void;
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

/** A project as the CLI keys it: the real path of its cwd. A cwd that is gone keeps its own spelling. */
export function projectKey(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** The project's entry in a `.claude.json`, keyed by the real path of its cwd as the CLI writes it. */
function claudeJsonProject(path: string, cwd: string): Record<string, unknown> | null {
  const projects = readObject(path)?.projects;
  if (!isObject(projects)) return null;
  const key = projectKey(cwd);
  const entry = Object.hasOwn(projects, key) ? projects[key] : undefined;
  return isObject(entry) ? entry : null;
}

/** Package runners, by the command's basename; a two-word runner by its subcommand. */
const NPM_RUNNERS = new Set(['npx', 'bunx']);
const NPM_SUBCOMMAND_RUNNERS: Record<string, string> = { pnpm: 'dlx', yarn: 'dlx', npm: 'exec' };
const PYPI_RUNNERS = new Set(['uvx']);
const PYPI_SUBCOMMAND_RUNNERS: Record<string, string> = { pipx: 'run' };
/** Interpreters whose first non-flag argument is the script they run. */
const INTERPRETER_RE = /^(node|nodejs|python(\d+(\.\d+)?)?|bash|sh|zsh|deno|bun|tsx)$/;
/** Interpreters that take a `run` subcommand before the script. */
const RUN_SUBCOMMAND = new Set(['deno', 'bun']);
/** Flags after which an interpreter runs inline code or a module, not a file. */
const INLINE_FLAGS = new Set(['-c', '-e', '-m', '-p', '--eval', '--print']);

/** `path` relative to the project, `/`-separated, when it resolves inside it; otherwise null. */
function insideProject(cwd: string, path: string): string | null {
  const root = resolve(cwd);
  const rel = relative(root, resolve(root, path));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** A command the shell would run as a path rather than look up on `PATH`. */
function isPathCommand(command: string): boolean {
  return command.startsWith('./') || command.startsWith('../') || isAbsolute(command);
}

const runsSubcommand = (runners: Record<string, string>, bin: string, args: string[]): boolean =>
  Object.hasOwn(runners, bin) && args[0] === runners[bin];

/**
 * What the question labels a server with (spec § Server, canvas 47e), read
 * from its `.mcp.json` entry and the project it sits in. A command that is
 * a path, or an interpreter's script, counts as the project's own file only
 * when it resolves inside `cwd`; one outside it is just a program.
 */
export function classifySource(entry: Record<string, unknown>, cwd: string): { source: McpjsonSource; file?: string } {
  const command = typeof entry.command === 'string' ? entry.command : '';
  if (entry.type === 'http' || entry.type === 'sse' || (!command && typeof entry.url === 'string')) {
    return { source: 'url' };
  }
  const args = stringList(entry.args);
  const bin = basename(command);
  if (NPM_RUNNERS.has(bin) || runsSubcommand(NPM_SUBCOMMAND_RUNNERS, bin, args)) return { source: 'npm' };
  if (PYPI_RUNNERS.has(bin) || runsSubcommand(PYPI_SUBCOMMAND_RUNNERS, bin, args)) return { source: 'pypi' };
  if (bin === 'docker') return { source: 'docker' };
  if (INTERPRETER_RE.test(bin)) {
    const rest = RUN_SUBCOMMAND.has(bin) && args[0] === 'run' ? args.slice(1) : args;
    const script = rest.find((a) => INLINE_FLAGS.has(a) || !a.startsWith('-'));
    const file = script !== undefined && !INLINE_FLAGS.has(script) ? insideProject(cwd, script) : null;
    if (file) return { source: 'file', file };
  }
  const file = isPathCommand(command) ? insideProject(cwd, command) : null;
  return file ? { source: 'file', file } : { source: 'program' };
}

/** The keys of an entry that decide what runs, and so what a fingerprint covers (spec § Behaviour 4). */
const HASHED_KEYS = ['type', 'command', 'args', 'url', 'env', 'headers'] as const;

/** `value` with every object's keys sorted, so key order in `.mcp.json` never changes a hash. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

/** The fingerprint of one `.mcp.json` entry: a SHA-256 of its `HASHED_KEYS`, canonicalised. */
export function entryHash(entry: Record<string, unknown>): string {
  const picked: Record<string, unknown> = {};
  for (const key of HASHED_KEYS) if (entry[key] !== undefined) picked[key] = canonical(entry[key]);
  return createHash('sha256').update(JSON.stringify(picked)).digest('hex');
}

/** The servers `.mcp.json` names, in its order, with each entry's hash; empty when it is missing or unreadable. */
function mcpjsonServers(cwd: string): { server: McpjsonServer; hash: string }[] {
  const servers = readObject(join(cwd, '.mcp.json'))?.mcpServers;
  if (!isObject(servers)) return [];
  return Object.entries(servers).map(([name, raw]) => {
    const entry = isObject(raw) ? raw : {};
    const { source, file } = classifySource(entry, cwd);
    const runs = typeof entry.command === 'string'
      ? { command: entry.command, args: stringList(entry.args) }
      : { command: typeof entry.url === 'string' ? entry.url : '', args: [] };
    return { server: { name, ...runs, source, ...(file ? { file } : {}) }, hash: entryHash(entry) };
  });
}

/**
 * The servers of `<cwd>/.mcp.json` that no decision source names. The four
 * sources: `settings.json` in `claudeDir`, the project's
 * `.claude/settings.json` and `.claude/settings.local.json`, and the
 * project's entry in that directory's `.claude.json`. A name in either list
 * of any of them is decided; `enableAllProjectMcpServers: true` in any of
 * them decides every server.
 *
 * With `fingerprints`, an allowed server whose entry no longer matches the
 * fingerprint Orbital recorded when it was allowed is undecided again (spec
 * § Behaviour 4); one turned down stays decided whatever its command, and
 * one with no fingerprint (allowed in a terminal) keeps the CLI's decision.
 * Keeping such a server out works because the SDK honours a flag-tier
 * `disabledMcpjsonServers` over every source's approval,
 * `enableAllProjectMcpServers` included (checked 2026-10-08, SDK 0.3.287).
 * `home` is injected for tests.
 */
export function undecidedServers(
  cwd: string,
  claudeDir: string,
  opts: { home?: string; fingerprints?: McpjsonFingerprints } = {},
): McpjsonServer[] {
  const servers = mcpjsonServers(cwd);
  if (servers.length === 0) return [];
  const sources = [
    readObject(join(claudeDir, 'settings.json')),
    readObject(join(cwd, '.claude', 'settings.json')),
    readObject(localSettingsPath(cwd)),
    claudeJsonProject(claudeJsonPathFor(claudeDir, opts.home ?? homedir()), cwd),
  ];
  let enableAll = false;
  const allowed = new Set<string>();
  const denied = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    if (source[ENABLE_ALL] === true) enableAll = true;
    for (const name of stringList(source[ENABLED])) allowed.add(nameKey(name));
    for (const name of stringList(source[DISABLED])) denied.add(nameKey(name));
  }
  const prints = opts.fingerprints?.forProject(projectKey(cwd));
  return servers
    .filter(({ server, hash }) => {
      const key = nameKey(server.name);
      if (denied.has(key)) return false;
      const print = prints?.get(server.name);
      if (print !== undefined && print !== hash) return true;
      return !enableAll && !allowed.has(key);
    })
    .map(({ server }) => server);
}

/**
 * Records the user's answer in `<cwd>/.claude/settings.local.json`, where
 * the CLI keeps it too: each allowed name joins `enabledMcpjsonServers` and
 * leaves `disabledMcpjsonServers`, each denied one the reverse. Every other
 * key is kept as it was. A file that exists but is not a JSON object is not
 * overwritten — this throws instead, and the user's file stays intact.
 *
 * With `fingerprints`, once the file is written each allowed server's
 * current `.mcp.json` entry is fingerprinted and each denied one's
 * fingerprint dropped (spec § Behaviour 4). The entry is read now, not when
 * the question was shown; a `.mcp.json` edited in between is fingerprinted
 * as it is.
 *
 * The only write Orbital makes to that file (adr
 * mcp-config-is-written-by-the-cli-in-private-scopes): no CLI command
 * records an approval. Atomic, through a temp file and a rename, so the CLI
 * never reads it half-written.
 */
export function recordDecisions(
  cwd: string,
  decisions: McpjsonDecisions,
  opts: { fingerprints?: McpjsonFingerprints } = {},
): void {
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
  if (!opts.fingerprints) return;
  const hashes = new Map(mcpjsonServers(cwd).map(({ server, hash }) => [server.name, hash]));
  const allowedHashes = new Map<string, string>();
  for (const name of allow) {
    const hash = hashes.get(name);
    if (hash !== undefined) allowedHashes.set(name, hash);
  }
  opts.fingerprints.update(projectKey(cwd), allowedHashes, [...deny]);
}
