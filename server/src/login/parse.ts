/**
 * The pure half of logging a profile in from Orbital (spec
 * 2026-10-21-log-in-from-orbital-design § What the CLI does, § 1): reading
 * what `claude auth login`, `claude design-login --json` and the two status
 * commands write, and the environment both are spawned under.
 *
 * Every one of these outputs is undocumented — `design-login` is a hidden
 * command outright — and can change with any CLI update, like the
 * transcript format. So every read here is field by field and tolerant: a
 * line or a shape Orbital does not know is ignored or read as unknown, never
 * thrown.
 */
import { homedir } from 'node:os';
import { claudeDirEnv } from '../claudeDirs/paths.js';
import type { LoginKind } from '../types.js';

/** Which login: the profile's own (`auth login`) or its Claude Design sign-in (`design-login`). */
export type { LoginKind };

export const LOGIN_KINDS: readonly LoginKind[] = ['claude', 'design'];

export function isLoginKind(value: unknown): value is LoginKind {
  return value === 'claude' || value === 'design';
}

/**
 * What `BROWSER` is set to for a login started from another device: a
 * command that does nothing, so no browser opens on a Mac nobody is at and
 * only the pasted code finishes the login (spec § 1 Started from another
 * device).
 */
export const SILENT_BROWSER = '/usr/bin/true';

/** The variable the CLI marks a process it spawned with; `design-login` refuses to run under it. */
const CLAUDECODE = 'CLAUDECODE';
const CLAUDE_CODE_PREFIX = 'CLAUDE_CODE_';

/**
 * The environment a login or a status read runs under: the profile's
 * (`claudeDirEnv` — no `CLAUDE_CONFIG_DIR` for the CLI's default directory),
 * without `CLAUDECODE` and every `CLAUDE_CODE_*` variable — `design-login`
 * refuses to run when it sees it was spawned from a Claude Code session, and
 * a server started from one inherits them. `BROWSER` is silenced for a
 * login started from another device and removed otherwise, so the CLI opens
 * the default browser itself.
 */
export function loginEnv(
  base: NodeJS.ProcessEnv,
  dirPath: string,
  opts: { remote: boolean; home?: string },
): Record<string, string> {
  const env = claudeDirEnv(base, dirPath, opts.home ?? homedir());
  for (const key of Object.keys(env)) {
    if (key === CLAUDECODE || key.startsWith(CLAUDE_CODE_PREFIX)) delete env[key];
  }
  if (opts.remote) env.BROWSER = SILENT_BROWSER;
  else delete env.BROWSER;
  return env;
}

// ---- Lines ---------------------------------------------------------------

/**
 * Splits a stream into lines as it arrives. `pending` is what came after the
 * last newline — where `auth login`'s prompt sits, since it is written with
 * no newline after it.
 */
export class LineSplitter {
  private rest = '';

  /** The complete lines this chunk finished, without their line ends. */
  push(chunk: string): string[] {
    const text = this.rest + chunk;
    const parts = text.split(/\r?\n/);
    this.rest = parts.pop() ?? '';
    return parts;
  }

  /** What has arrived since the last newline. */
  get pending(): string {
    return this.rest;
  }

  /** The stream ended: what is left, as a last line, or nothing. */
  flush(): string[] {
    const rest = this.rest;
    this.rest = '';
    return rest === '' ? [] : [rest];
  }
}

/** Terminal colour and cursor codes, which the CLI may write even to a pipe. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** A line with terminal codes taken off and trimmed. */
export function plainLine(line: string): string {
  return line.replace(ANSI, '').trim();
}

/** An `http:` or `https:` URL, or null — nothing else is ever handed to a browser. */
function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---- `claude auth login` --------------------------------------------------

const MANUAL_URL_LINE = /browser didn.t open[^:]*:\s*(\S+)/i;
const CODE_PROMPT = /paste code here/i;
const OPENING_BROWSER = /^opening browser/i;

/** The manual sign-in URL out of `If the browser didn't open, visit: <url>`, or null. */
export function manualUrlOf(line: string): string | null {
  const match = MANUAL_URL_LINE.exec(plainLine(line));
  return match ? httpUrl(match[1]) : null;
}

/** Whether this text is the prompt for the pasted code (`Paste code here if prompted > `). */
export function isCodePrompt(text: string): boolean {
  return CODE_PROMPT.test(plainLine(text));
}

/**
 * The last line worth showing a user when the login failed: not blank, not
 * the CLI's own narration of the flow (the browser line, the manual URL, the
 * prompt). What the CLI said last is usually why — `Login failed: …`.
 */
export function lastMeaningfulLine(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = plainLine(lines[i]);
    if (line === '' || OPENING_BROWSER.test(line) || manualUrlOf(line) !== null) continue;
    // The prompt can lead a line when what followed it ended with a newline.
    const text = line.replace(/^.*paste code here if prompted\s*>\s*/i, '').trim();
    if (text === '' || isCodePrompt(text)) continue;
    return text;
  }
  return null;
}

// ---- `claude design-login --json` -----------------------------------------

/** One JSON line of `design-login --json` that Orbital acts on. */
export type DesignEvent =
  | { event: 'pages'; url: string | null; manualUrl: string | null; manualFirst: boolean }
  | { event: 'done'; ok: boolean; message: string | null };

/**
 * One line of `design-login --json`: `pages` (the two URLs) or `done`.
 * Anything else — an event added since, a line that is not JSON, a `pages`
 * with neither URL — is null.
 */
export function readDesignEvent(line: string): DesignEvent | null {
  const obj = jsonObject(line);
  if (!obj) return null;
  if (obj.event === 'pages') {
    const url = httpUrl(obj.url);
    const manualUrl = httpUrl(obj.manual_url);
    if (url === null && manualUrl === null) return null;
    return { event: 'pages', url, manualUrl, manualFirst: obj.manual_first === true };
  }
  if (obj.event === 'done') {
    return { event: 'done', ok: obj.ok === true, message: nonEmpty(obj.message) };
  }
  return null;
}

// ---- Status answers -------------------------------------------------------

/** `auth status --json`, as the profile's account. */
export interface AccountStatus {
  loggedIn: boolean;
  email: string | null;
  orgName: string | null;
  /** `subscriptionType`: `max`, `pro`, `team`… */
  plan: string | null;
}

/**
 * `claude auth status --json`'s answer, or null when it is not one. The
 * command exits 1 when logged out, so the exit code says nothing here; only
 * `loggedIn` does, and an answer without it is unknown — not logged out.
 */
export function readAuthStatus(stdout: string): AccountStatus | null {
  const obj = jsonObject(stdout);
  if (!obj || typeof obj.loggedIn !== 'boolean') return null;
  return {
    loggedIn: obj.loggedIn,
    email: nonEmpty(obj.email),
    orgName: nonEmpty(obj.orgName),
    plan: nonEmpty(obj.subscriptionType),
  };
}

/** `design-login --json --status`, as the profile's Claude Design state. */
export interface DesignStatus {
  available: boolean;
  signedIn: boolean;
}

/**
 * `claude design-login --json --status`'s answer, or null when it is not
 * one. `signed_in` is what the answer is about; without it nothing is known.
 * A missing `available` reads as available: the command answered, so it
 * exists on this CLI.
 */
export function readDesignStatus(stdout: string): DesignStatus | null {
  const obj = jsonObject(stdout);
  if (!obj || typeof obj.signed_in !== 'boolean') return null;
  return { available: obj.available !== false, signedIn: obj.signed_in };
}

/** The last line of `text` that parses as a JSON object, or null. */
function jsonObject(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed: unknown = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Not this line.
    }
  }
  // A pretty-printed answer spans several lines.
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Not JSON at all.
  }
  return null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// ---- The pasted code ------------------------------------------------------

/** The longest code accepted; the CLI's are far shorter, this only bounds what reaches its stdin. */
export const LOGIN_CODE_MAX_CHARS = 4096;

/**
 * A pasted code as it is handed to the CLI, or null when it cannot be one.
 * Trimmed — a paste often carries a newline — and refused when what is left
 * is empty, too long, or has a control character in it: the code goes to the
 * CLI's stdin as one line, and a newline inside it would be a second answer.
 */
export function cleanLoginCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  if (code === '' || code.length > LOGIN_CODE_MAX_CHARS) return null;
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  return code;
}
