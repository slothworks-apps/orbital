import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { SessionStatus } from '../types.js';

/**
 * The CLI writes its *own* status vocabulary into
 * `~/.claude/sessions/<pid>.json` -- `busy` | `shell` | `idle` | `waiting` --
 * which is not orbital's. It never writes `working`, so anything unmapped
 * has to fall back to `idle` rather than be treated as the live-but-unknown
 * state it isn't. A newer CLI adding a word lands on `idle` until we map it.
 *
 * `waiting` is the CLI parked on a prompt the human has to answer (a
 * permission request, a question), which is exactly what orbital's
 * `needs_input` means -- the status is purely a visual state on the map, with
 * no web-session-only behaviour hanging off it.
 */
const CLI_STATUS: Record<string, Extract<SessionStatus, 'working' | 'needs_input' | 'idle'>> = {
  busy: 'working',
  shell: 'working',
  waiting: 'needs_input',
  idle: 'idle',
};

export interface LiveSession {
  sessionId: string;
  pid: number;
  cwd: string;
  name: string;
  /** Never `ended`: a registry entry only exists while the process lives. */
  status: Extract<SessionStatus, 'working' | 'needs_input' | 'idle'>;
  kind: string;
  startedAt: number;
  updatedAt: number;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, LiveSession>();
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private isPidAlive: (pid: number) => boolean;

  constructor(
    private sessionsDir: string,
    opts: { isPidAlive?: (pid: number) => boolean } = {},
  ) {
    super();
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  }

  scan(): void {
    const next = new Map<string, LiveSession>();
    let files: string[];
    try {
      files = readdirSync(this.sessionsDir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      files = [];
    }
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(this.sessionsDir, file), 'utf8'));
        if (typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') continue;
        if (!this.isPidAlive(raw.pid)) continue;
        // CLIs spawned through the Agent SDK (Orbital's own runner included)
        // register themselves here too, with `entrypoint: "sdk-ts"`. They are
        // not terminals: listing them makes Orbital treat its own sessions as
        // "live in a terminal" — read-only composer, 409s (fix:
        // reviving-a-terminal-session-leaves-it-read-only). Older CLIs write
        // no entrypoint at all, so only a declared sdk-* is skipped.
        if (typeof raw.entrypoint === 'string' && raw.entrypoint.startsWith('sdk')) continue;
        next.set(raw.sessionId, {
          sessionId: raw.sessionId,
          pid: raw.pid,
          cwd: String(raw.cwd ?? ''),
          name: String(raw.name ?? ''),
          status: CLI_STATUS[String(raw.status)] ?? 'idle',
          kind: String(raw.kind ?? ''),
          startedAt: Number(raw.startedAt ?? 0),
          updatedAt: Number(raw.updatedAt ?? 0),
        });
      } catch (err) {
        console.warn(`orbital: bad registry file ${file}:`, err);
      }
    }
    for (const [id, session] of next) {
      const prev = this.sessions.get(id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(session)) {
        this.emit('upsert', session);
      }
    }
    for (const id of this.sessions.keys()) {
      if (!next.has(id)) this.emit('remove', id);
    }
    this.sessions = next;
  }

  watch(): void {
    this.watcher = chokidar.watch(this.sessionsDir, { ignoreInitial: true });
    this.watcher.on('all', () => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.scan(), 200);
    });
  }

  async close(): Promise<void> {
    if (this.debounce) clearTimeout(this.debounce);
    await this.watcher?.close();
  }

  get(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  all(): LiveSession[] {
    return [...this.sessions.values()];
  }
}
