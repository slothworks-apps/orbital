import { execFile } from 'node:child_process';
import type { McpScope, McpServerDefinition } from '../types.js';
import { readMcpConfig, type McpConfigSnapshot } from './claudeJson.js';

/**
 * MCP config changes, made by the CLI (spec
 * 2026-10-01-mcp-servers-in-the-session-design § Config; adr
 * mcp-config-is-written-by-the-cli-in-private-scopes). Every write is
 * `claude mcp add-json` or `claude mcp remove`, run through `execFile` — never
 * a shell — with the session's cwd, so `local` lands on that project.
 */

/** How long one `claude mcp` call may take before it counts as a refusal. */
export const MCP_CLI_TIMEOUT_MS = 30_000;

/** What one CLI call said: whether it exited cleanly, and its output, stdout and stderr together. */
export interface McpCliResult {
  ok: boolean;
  output: string;
}

/** Runs the CLI with these arguments in `cwd`, under `env` when given. Injected so tests never run a real `claude`. */
export type McpCliRun = (cliPath: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<McpCliResult>;

/** The real one: `execFile`, no shell, bounded by `MCP_CLI_TIMEOUT_MS`. */
export const execMcpCli: McpCliRun = (cliPath, args, cwd, env) =>
  new Promise((resolve) => {
    execFile(
      cliPath, args,
      { cwd, env, timeout: MCP_CLI_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const output = [stdout, stderr].map((s) => (s ?? '').trim()).filter(Boolean).join('\n');
        resolve({ ok: !err, output: output || (err ? err.message : '') });
      },
    );
  });

/** No `claude` could be resolved, so nothing can be written; the route answers 503. */
export class McpCliMissingError extends Error {
  constructor() {
    super('Claude Code CLI was not found, so MCP config cannot be changed from Orbital');
  }
}

/**
 * The CLI refused a change. `command` is the line that ran with every env and
 * header value masked — the only form of it that leaves this module.
 */
export class McpCliRefusedError extends Error {
  constructor(
    readonly command: string,
    readonly output: string,
  ) {
    super(output || 'the CLI refused the change');
  }
}

/** A body the form should never have sent; the route answers 400 with `code`. */
export class McpDefinitionError extends Error {
  constructor(
    readonly code: 'invalid' | 'project_scope',
    message: string,
  ) {
    super(message);
  }
}

const MASK = '***';
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An HTTP header name: RFC 9110's token characters. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function stringRecord(value: unknown, field: string, key: RegExp): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new McpDefinitionError('invalid', `${field} must be an object of strings`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!key.test(k)) throw new McpDefinitionError('invalid', `${field} has an invalid name: ${k}`);
    if (typeof v !== 'string') throw new McpDefinitionError('invalid', `${field}.${k} must be a string`);
    out[k] = v;
  }
  return out;
}

/**
 * A request body as a definition, or `McpDefinitionError`. The JSON the CLI
 * gets is built from what this returns, never from the body itself.
 *
 * A name may not start with `-`: it is a positional argument of `claude mcp`,
 * and one that looks like an option would be read as one.
 */
export function parseDefinition(body: unknown): McpServerDefinition {
  if (!body || typeof body !== 'object') throw new McpDefinitionError('invalid', 'body must be an object');
  const b = body as Record<string, unknown>;
  const name = b.name;
  if (typeof name !== 'string' || !name || /\s/.test(name) || name.startsWith('-')) {
    throw new McpDefinitionError('invalid', 'name is required, without whitespace, and may not start with -');
  }
  const scope = b.scope ?? 'local';
  if (scope === 'project') {
    throw new McpDefinitionError('project_scope', 'Orbital does not write the project scope (.mcp.json)');
  }
  if (scope !== 'local' && scope !== 'user') throw new McpDefinitionError('invalid', 'scope must be local or user');
  if (b.transport === 'stdio') {
    if (typeof b.command !== 'string' || !b.command.trim()) {
      throw new McpDefinitionError('invalid', 'command is required');
    }
    const args = b.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
      throw new McpDefinitionError('invalid', 'args must be a list of strings');
    }
    return { name, scope, transport: 'stdio', command: b.command, args: [...args], env: stringRecord(b.env, 'env', ENV_KEY) };
  }
  if (b.transport === 'http' || b.transport === 'sse') {
    if (typeof b.url !== 'string' || !/^https?:\/\/\S+$/.test(b.url)) {
      throw new McpDefinitionError('invalid', 'url must start with http:// or https://');
    }
    return { name, scope, transport: b.transport, url: b.url, headers: stringRecord(b.headers, 'headers', HEADER_NAME) };
  }
  throw new McpDefinitionError('invalid', 'transport must be stdio, http or sse');
}

/** The server's JSON as `claude mcp add-json` takes it; `mask` replaces every env and header value. */
export function definitionJson(def: McpServerDefinition, mask = false): string {
  const hide = (r: Record<string, string>) =>
    mask ? Object.fromEntries(Object.keys(r).map((k) => [k, MASK])) : r;
  return JSON.stringify(
    def.transport === 'stdio'
      ? { type: 'stdio', command: def.command, args: def.args, env: hide(def.env) }
      : { type: def.transport, url: def.url, headers: hide(def.headers) },
  );
}

export function addArgs(def: McpServerDefinition, mask = false): string[] {
  return ['mcp', 'add-json', '--scope', def.scope, def.name, definitionJson(def, mask)];
}

export function removeArgs(name: string, scope: McpScope): string[] {
  return ['mcp', 'remove', '--scope', scope, name];
}

/** Every env and header value of a definition — what no refusal may carry. */
function secretsOf(def: McpServerDefinition): string[] {
  return Object.values(def.transport === 'stdio' ? def.env : def.headers).filter(Boolean);
}

/**
 * The CLI's output with every secret replaced: a refusal of the JSON may quote
 * it back. Longest first, so a value containing another is masked whole.
 */
export function maskSecrets(text: string, secrets: string[]): string {
  return [...secrets]
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.split(secret).join(MASK), text);
}

/** One word as a shell would need it written; for showing a command line, never for running one. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_\-./:=@,+%]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The command line as the user may see it. Callers pass masked arguments. */
export function commandLine(args: string[]): string {
  return ['claude', ...args].map(shellWord).join(' ');
}

export class McpConfig {
  private cliPath: string | null;
  private path: string;
  private run: McpCliRun;
  private readFile?: (path: string) => string;
  private realpath?: (path: string) => string;
  private env?: NodeJS.ProcessEnv;

  constructor(deps: {
    /** The CLI `resolveClaudeCli` arrived at, as an executable path; null when it is `missing`. */
    cliPath: string | null;
    /** The Claude directory's `claudeJsonPath(dir)` in the server; a fixture in tests. */
    claudeJsonPath: string;
    /**
     * The Claude directory's environment (`claudeDirEnv`), so `claude mcp`
     * writes into the same `.claude.json` this reads. Absent in tests.
     */
    env?: NodeJS.ProcessEnv;
    run?: McpCliRun;
    readFile?: (path: string) => string;
    realpath?: (path: string) => string;
  }) {
    this.cliPath = deps.cliPath;
    this.path = deps.claudeJsonPath;
    this.env = deps.env;
    this.run = deps.run ?? execMcpCli;
    this.readFile = deps.readFile;
    this.realpath = deps.realpath;
  }

  /** Whether writes can run at all — false when the CLI is missing. */
  get writable(): boolean {
    return this.cliPath !== null;
  }

  /** The `user` and `local` servers of the project at `cwd`, read now. */
  read(cwd: string): McpConfigSnapshot {
    return readMcpConfig({ path: this.path, cwd, readFile: this.readFile, realpath: this.realpath });
  }

  add(cwd: string, def: McpServerDefinition): Promise<void> {
    return this.exec(cwd, addArgs(def), addArgs(def, true), secretsOf(def));
  }

  remove(cwd: string, name: string, scope: McpScope): Promise<void> {
    const args = removeArgs(name, scope);
    return this.exec(cwd, args, args, []);
  }

  /**
   * Replaces `current` with `next` — a rename or a move between scopes is the
   * same thing. Remove, then add; when the add is refused the old definition
   * is added back, and the add's refusal is what the caller sees. No step
   * leaves the server gone without saying so: a failed restore is named in
   * the refusal's output.
   */
  async edit(cwd: string, current: McpServerDefinition, next: McpServerDefinition): Promise<void> {
    await this.remove(cwd, current.name, current.scope);
    try {
      await this.add(cwd, next);
    } catch (err) {
      if (!(err instanceof McpCliRefusedError)) throw err;
      try {
        await this.add(cwd, current);
      } catch (restoreErr) {
        const detail = restoreErr instanceof McpCliRefusedError ? restoreErr.output : String(restoreErr);
        throw new McpCliRefusedError(
          err.command,
          `${err.output}\n\nRestoring the previous definition of ${current.name} failed as well: ${detail}`,
        );
      }
      throw err;
    }
  }

  private async exec(cwd: string, args: string[], masked: string[], secrets: string[]): Promise<void> {
    if (this.cliPath === null) throw new McpCliMissingError();
    const result = await this.run(this.cliPath, args, cwd, this.env);
    if (!result.ok) throw new McpCliRefusedError(commandLine(masked), maskSecrets(result.output, secrets));
  }
}
