import { randomUUID } from 'node:crypto';
import { spawn as spawnPty, type IPty } from 'node-pty';
import type { RawData, WebSocket } from 'ws';
import { Scrollback } from './scrollback.js';

/**
 * The shells the user runs inside Orbital, each tied to a session and started
 * in its `cwd` (spec 2026-10-05-embedded-terminal-design). The only place a
 * terminal is spawned or killed.
 */

/** How much recent output a terminal replays to a window that attaches, in characters. */
export const SCROLLBACK_CHARS = 256 * 1024;
/** How long a closed terminal's shell gets to end on `SIGHUP` before its group is killed. */
export const CLOSE_GRACE_MS = 2_000;
/** Unsent output per socket past which the shell is paused until the socket catches up. */
const SOCKET_HIGH_WATER = 1024 * 1024;

export interface TerminalInfo {
  id: string;
  sessionId: string;
  cwd: string;
  createdAt: number;
  /** null while the shell runs. */
  exitCode: number | null;
}

/** What the server sends on a terminal's socket besides output, which goes as binary frames. */
export type TerminalControl = { type: 'exit'; exitCode: number };
/** What the window sends; every frame from it is one of these, as JSON text. */
export type TerminalInput =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

interface Terminal {
  info: TerminalInfo;
  pty: IPty;
  scrollback: Scrollback;
  sockets: Map<WebSocket, { pending: number }>;
  paused: boolean;
  killTimer: NodeJS.Timeout | null;
}

export interface TerminalStoreOptions {
  /** The shell and its arguments; defaults to the user's `$SHELL` as a login shell. */
  shell?: { file: string; args: string[] };
  /** The environment the shell starts from; defaults to the server's own. */
  env?: NodeJS.ProcessEnv;
}

export class TerminalStore {
  private readonly terminals = new Map<string, Terminal>();
  private readonly shell: { file: string; args: string[] };
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: TerminalStoreOptions = {}) {
    // A login shell, so `.zprofile` and what it sets up (nvm, Homebrew) are
    // there, as in a terminal app.
    this.shell = opts.shell ?? { file: process.env.SHELL || '/bin/zsh', args: ['-l'] };
    this.env = opts.env ?? process.env;
  }

  open(sessionId: string, cwd: string, size: { cols: number; rows: number } = { cols: 80, rows: 24 }): TerminalInfo {
    const pty = spawnPty(this.shell.file, this.shell.args, {
      name: 'xterm-256color',
      cwd,
      cols: size.cols,
      rows: size.rows,
      env: shellEnv(this.env),
    });
    const info: TerminalInfo = { id: randomUUID(), sessionId, cwd, createdAt: Date.now(), exitCode: null };
    const terminal: Terminal = {
      info, pty, scrollback: new Scrollback(SCROLLBACK_CHARS), sockets: new Map(), paused: false, killTimer: null,
    };
    this.terminals.set(info.id, terminal);
    pty.onData((data) => {
      terminal.scrollback.push(data);
      for (const socket of terminal.sockets.keys()) this.send(terminal, socket, data);
    });
    pty.onExit(({ exitCode }) => {
      info.exitCode = exitCode;
      if (terminal.killTimer) clearTimeout(terminal.killTimer);
      terminal.killTimer = null;
      const exit: TerminalControl = { type: 'exit', exitCode };
      for (const socket of terminal.sockets.keys()) socket.send(JSON.stringify(exit));
    });
    return { ...info };
  }

  get(id: string): TerminalInfo | null {
    const terminal = this.terminals.get(id);
    return terminal ? { ...terminal.info } : null;
  }

  list(sessionId: string): TerminalInfo[] {
    return [...this.terminals.values()]
      .filter((t) => t.info.sessionId === sessionId)
      .map((t) => ({ ...t.info }));
  }

  /**
   * Ends the shell and forgets the terminal. The shell gets `SIGHUP`, which a
   * shell passes on to its jobs, so a dev server started in it ends too;
   * whatever is still there after `CLOSE_GRACE_MS` is killed with its group.
   */
  close(id: string): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal) return false;
    this.terminals.delete(id);
    for (const socket of terminal.sockets.keys()) socket.close();
    terminal.sockets.clear();
    if (terminal.info.exitCode !== null) return true;
    const pid = terminal.pty.pid;
    signal(pid, 'SIGHUP');
    terminal.killTimer = setTimeout(() => {
      signal(-pid, 'SIGKILL');
      signal(pid, 'SIGKILL');
    }, CLOSE_GRACE_MS);
    terminal.killTimer.unref();
    return true;
  }

  /** Every terminal of a session, as when the user ends it. */
  closeSession(sessionId: string): void {
    for (const t of this.list(sessionId)) this.close(t.id);
  }

  /**
   * Connects a window's socket: the scrollback first, then the live output,
   * and the exit notice when the shell has already ended.
   */
  attach(id: string, socket: WebSocket): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal) return false;
    terminal.sockets.set(socket, { pending: 0 });
    const history = terminal.scrollback.text();
    if (history) this.send(terminal, socket, history);
    if (terminal.info.exitCode !== null) {
      const exit: TerminalControl = { type: 'exit', exitCode: terminal.info.exitCode };
      socket.send(JSON.stringify(exit));
    }
    socket.on('message', (raw, isBinary) => {
      if (isBinary || terminal.info.exitCode !== null) return;
      const msg = parseInput(rawText(raw));
      if (msg?.type === 'input') terminal.pty.write(msg.data);
      else if (msg?.type === 'resize') terminal.pty.resize(msg.cols, msg.rows);
    });
    socket.on('close', () => {
      terminal.sockets.delete(socket);
      this.resumeIfDrained(terminal);
    });
    return true;
  }

  /** Every shell, on the server's way out. */
  dispose(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  private send(terminal: Terminal, socket: WebSocket, data: string): void {
    const state = terminal.sockets.get(socket);
    if (!state) return;
    const bytes = Buffer.from(data, 'utf8');
    state.pending += bytes.length;
    // A window that cannot keep up pauses the shell rather than letting its
    // output pile up here: `yes` in a terminal must not grow the server.
    if (state.pending > SOCKET_HIGH_WATER && !terminal.paused && terminal.info.exitCode === null) {
      terminal.paused = true;
      terminal.pty.pause();
    }
    socket.send(bytes, { binary: true }, () => {
      state.pending -= bytes.length;
      this.resumeIfDrained(terminal);
    });
  }

  private resumeIfDrained(terminal: Terminal): void {
    if (!terminal.paused) return;
    for (const state of terminal.sockets.values()) if (state.pending > SOCKET_HIGH_WATER) return;
    terminal.paused = false;
    if (terminal.info.exitCode === null) terminal.pty.resume();
  }
}

/**
 * The server's environment without what Orbital set for itself: the user's
 * commands should not see Orbital's internals, and an `ORBITAL_*` variable
 * changes how Orbital's own scripts and tests behave when run in it.
 */
export function shellEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.startsWith('ORBITAL_') || key === 'ELECTRON_RUN_AS_NODE') continue;
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Orbital';
  // Launched from Finder the app has no locale, and a shell without one
  // prints every non-ASCII character as escapes.
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'en_US.UTF-8';
  return env;
}

export function parseInput(raw: string): TerminalInput | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type === 'input' && typeof m.data === 'string') return { type: 'input', data: m.data };
  if (m.type === 'resize' && isTerminalSize(m.cols) && isTerminalSize(m.rows)) return { type: 'resize', cols: m.cols, rows: m.rows };
  return null;
}

/** A plausible column or row count, as the window reports it. */
export function isTerminalSize(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 1000;
}

function rawText(raw: RawData): string {
  const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return buf.toString('utf8');
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone.
  }
}
