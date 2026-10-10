import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { homedir } from 'node:os';

/**
 * What a terminal's tab is called (spec 2026-10-05-embedded-terminal-design
 * § What a tab is called): the foreground command while one runs, otherwise
 * the shell's folder. Read from the system, never from the OSC title a prompt
 * theme sets.
 */

export interface TerminalStatus {
  label: string;
  busy: boolean;
}

/** Tools whose first argument says what they do: `git rebase`, not `git`. */
const SUBCOMMAND_TOOLS = new Set([
  'git', 'gh', 'docker', 'kubectl', 'cargo', 'go', 'brew', 'make', 'terraform', 'claude',
]);
/** Package managers: `npm run dev` keeps the script, anything else the subcommand. */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Launchers named for what they launch: `npx vitest run` is `vitest`. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
/** Interpreters named for their script: `node vite.js` is `vite`. */
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'deno', 'tsx']);
/** Scripts that stand for a command of another name. */
const SCRIPT_NAMES: Record<string, string> = { 'npm-cli': 'npm', 'npx-cli': 'npx' };

export function commandLabel(args: string): string {
  return labelOf(args.trim().split(/\s+/).filter(Boolean));
}

function labelOf(tokens: string[]): string {
  if (tokens.length === 0) return '';
  const program = basename(tokens[0]).replace(/^-/, '');
  const rest = tokens.slice(1);
  const firstArg = (from: string[]) => from.findIndex((t) => !t.startsWith('-'));
  if (INTERPRETERS.has(program)) {
    const i = firstArg(rest);
    if (i < 0) return program;
    const script = basename(rest[i]).replace(/\.[cm]?[jt]s$|\.py$|\.rb$/, '');
    return labelOf([SCRIPT_NAMES[script] ?? script, ...rest.slice(i + 1)]);
  }
  if (RUNNERS.has(program)) {
    const i = firstArg(rest);
    return i < 0 ? program : labelOf(rest.slice(i));
  }
  if (PACKAGE_MANAGERS.has(program)) {
    const i = firstArg(rest);
    if (i < 0) return program;
    const sub = rest[i];
    if (sub === 'run' || sub === 'run-script') {
      const j = firstArg(rest.slice(i + 1));
      return j < 0 ? `${program} run` : `${program} run ${rest[i + 1 + j]}`;
    }
    return `${program} ${sub}`;
  }
  if (SUBCOMMAND_TOOLS.has(program)) {
    const i = firstArg(rest);
    return i < 0 ? program : `${program} ${rest[i]}`;
  }
  return program;
}

/** The folder as a tab shows it: its base name, and `~` for the home folder. */
export function folderLabel(cwd: string, home = homedir()): string {
  if (cwd === home) return '~';
  return basename(cwd) || cwd;
}

interface PsRow {
  pid: number;
  pgid: number;
  tpgid: number;
  args: string;
}

/** `ps -o pid=,pgid=,tpgid=,args=` output, one process per line. */
export function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), tpgid: Number(m[3]), args: m[4].trim() });
  }
  return rows;
}

/**
 * The foreground command on a pty, or null while the shell itself holds the
 * foreground (it is at a prompt). The group's leader names the command: for
 * `npm run dev` that is npm, not the `sh -c vite` it started.
 */
export function foregroundCommand(rows: PsRow[], shellPid: number): string | null {
  const tpgid = rows.find((r) => r.tpgid > 0)?.tpgid;
  if (tpgid === undefined || tpgid === shellPid) return null;
  const group = rows.filter((r) => r.pgid === tpgid);
  const leader = group.find((r) => r.pid === tpgid) ?? group[0];
  return leader ? leader.args : null;
}

/** Reads a terminal's status from the system: `ps` on its pty, the shell's folder at a prompt. */
export async function readStatus(shellPid: number, ptsName: string, fallbackCwd: string): Promise<TerminalStatus> {
  const tty = ptsName.replace(/^\/dev\//, '');
  const rows = parsePs(await run('ps', ['-t', tty, '-o', 'pid=,pgid=,tpgid=,args=']).catch(() => ''));
  const command = foregroundCommand(rows, shellPid);
  if (command !== null) return { label: commandLabel(command), busy: true };
  const cwd = (await cwdOf(shellPid)) ?? fallbackCwd;
  return { label: folderLabel(cwd), busy: false };
}

async function cwdOf(pid: number): Promise<string | null> {
  if (process.platform === 'linux') return readlink(`/proc/${pid}/cwd`).catch(() => null);
  const out = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).catch(() => '');
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2_000 }, (err, stdout) => {
      // `ps -t` exits 1 when the pty has no process left; its output, empty, is the answer.
      if (err && !stdout) reject(new Error(err.message));
      else resolve(stdout);
    });
  });
}
