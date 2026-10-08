import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchDir, type DirWatch } from './watchDir.js';
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
  /** The Claude directory whose registry lists it — set by `LiveRegistries`, never by a scan. */
  claudeDirId?: number;
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
  private watcher: DirWatch | null = null;
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
    // Any event rescans the directory, so the name it carries does not matter,
    // and a directory that appears later rescans on arrival.
    const rescan = () => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.scan(), 200);
    };
    this.watcher = watchDir(this.sessionsDir, { onEvent: rescan, onAppear: rescan });
  }

  close(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
  }

  get(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  all(): LiveSession[] {
    return [...this.sessions.values()];
  }
}

/** What the rest of the server asks of the live CLIs: one session, or all of them. */
export interface LiveSessions {
  get(sessionId: string): LiveSession | undefined;
  all(): LiveSession[];
}

/**
 * One `SessionRegistry` per Claude directory, read as one (spec
 * 2026-10-04-multiple-claude-directories-design § 2). Their `upsert` and
 * `remove` events come out of here, so a directory added later is heard the
 * same way as one that was there at boot. Removing a directory announces its
 * live sessions as gone: they are hidden with it.
 */
export class LiveRegistries extends EventEmitter implements LiveSessions {
  private byDir = new Map<number, SessionRegistry>();

  /** Starts reading `registry` for this directory: scanned now, watched from here on. */
  add(claudeDirId: number, registry: SessionRegistry): void {
    this.remove(claudeDirId);
    this.byDir.set(claudeDirId, registry);
    // A copy, stamped: the registry compares its own entries scan to scan.
    registry.on('upsert', (session: LiveSession) => this.emit('upsert', { ...session, claudeDirId }));
    registry.on('remove', (id: string) => this.emit('remove', id));
    registry.scan();
    registry.watch();
  }

  remove(claudeDirId: number): void {
    const registry = this.byDir.get(claudeDirId);
    if (!registry) return;
    this.byDir.delete(claudeDirId);
    registry.close();
    registry.removeAllListeners();
    for (const session of registry.all()) this.emit('remove', session.sessionId);
  }

  get(sessionId: string): LiveSession | undefined {
    for (const [claudeDirId, registry] of this.byDir) {
      const live = registry.get(sessionId);
      if (live) return { ...live, claudeDirId };
    }
    return undefined;
  }

  all(): LiveSession[] {
    return [...this.byDir].flatMap(([claudeDirId, registry]) =>
      registry.all().map((live) => ({ ...live, claudeDirId })));
  }

  /** The directory whose registry lists this session, for one not indexed yet. */
  dirOf(sessionId: string): number | undefined {
    return this.get(sessionId)?.claudeDirId;
  }

  close(): void {
    for (const registry of this.byDir.values()) {
      registry.close();
      registry.removeAllListeners();
    }
    this.byDir.clear();
  }
}
