import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

export interface LiveSession {
  sessionId: string;
  pid: number;
  cwd: string;
  name: string;
  status: 'working' | 'idle';
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
    let files: string[] = [];
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
        next.set(raw.sessionId, {
          sessionId: raw.sessionId,
          pid: raw.pid,
          cwd: String(raw.cwd ?? ''),
          name: String(raw.name ?? ''),
          status: raw.status === 'working' ? 'working' : 'idle',
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
