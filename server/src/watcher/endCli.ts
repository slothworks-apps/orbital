import { execFileSync } from 'node:child_process';

/**
 * Ends the terminal CLI that holds a session, for Take over (spec
 * 2026-10-21-take-over-terminal-session-design § 4): `SIGTERM`, then
 * `SIGKILL` once `TERM_GRACE_MS` passes with the process still alive.
 *
 * The pid comes from a registry file, and a CLI that crashed leaves its file
 * behind. The registry skips a dead pid, but not one the OS has handed to
 * another process since — so the process must still be a `claude` one, or
 * nothing is sent.
 */

export type EndCliOutcome = 'ended' | 'not_claude' | 'still_running';

export interface EndCliDeps {
  isAlive: (pid: number) => boolean;
  /** The process's command line, or null when there is no such process. */
  commandOf: (pid: number) => string | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}

/** How long a `SIGTERM`ed CLI gets to exit before it is killed. */
export const TERM_GRACE_MS = 3_000;
/** How long a `SIGKILL`ed process gets to disappear. */
const KILL_GRACE_MS = 1_000;
const POLL_MS = 100;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandOf(pid: number): string | null {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const systemDeps: EndCliDeps = {
  isAlive,
  commandOf,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * True for the command line of a Claude Code CLI, whatever the install: an
 * executable named `claude`, a native build under `claude/versions/`, or the
 * npm package's script run by node.
 */
export function isClaudeCommand(command: string): boolean {
  const [executable = '', script = ''] = command.split(/\s+/);
  if (/(^|\/)claude$/.test(executable) || /\/claude\/versions\//.test(executable)) return true;
  return /(^|\/)node$/.test(executable) && /\/claude-code\//.test(script);
}

async function gone(pid: number, ms: number, deps: EndCliDeps): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += POLL_MS) {
    if (!deps.isAlive(pid)) return true;
    await deps.sleep(POLL_MS);
  }
  return !deps.isAlive(pid);
}

export async function endCli(pid: number, deps: EndCliDeps = systemDeps): Promise<EndCliOutcome> {
  if (!deps.isAlive(pid)) return 'ended';
  const command = deps.commandOf(pid);
  if (command === null) return 'ended';
  if (!isClaudeCommand(command)) return 'not_claude';
  try {
    deps.kill(pid, 'SIGTERM');
  } catch {
    // Exited between the check and the signal.
  }
  if (await gone(pid, TERM_GRACE_MS, deps)) return 'ended';
  try {
    deps.kill(pid, 'SIGKILL');
  } catch {
    // Exited on its own after all.
  }
  return (await gone(pid, KILL_GRACE_MS, deps)) ? 'ended' : 'still_running';
}
