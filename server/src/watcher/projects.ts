import { watchDir, type DirWatch } from './watchDir.js';

/** Quiet time after the last event before the batch is indexed. */
export const PROJECTS_QUIET_MS = 500;
/**
 * The longest an event waits, however steadily events keep coming. A
 * session that is working writes its transcript every few hundred
 * milliseconds; with a quiet period alone, it would not be indexed until it
 * stopped.
 */
export const PROJECTS_MAX_WAIT_MS = 3000;

/** An event that named nothing: only a full pass can tell what changed. */
export const ALL_TRANSCRIPTS = Symbol('all transcripts');

/** What the indexer is told: the relative paths to look at, or everything. */
export type ProjectsBatch = { all: true } | { all: false; paths: string[] };

/**
 * What an event under `projects/` asks the indexer to look at, as a path
 * relative to `projects/`:
 *
 * - `<project>/<id>.jsonl` — that transcript;
 * - `<project>` — that project directory, which is all an event says when a
 *   directory is created or the platform coalesced what happened inside it;
 * - no name at all — everything (`ALL_TRANSCRIPTS`).
 *
 * Everything else is null: subagent transcripts and tool results under
 * `<project>/<id>/`, `memory/`, `sessions-index.json`, `.DS_Store`. The index
 * reads none of them — a subagent file counts toward its session's stats, but
 * only when the session's own transcript changes, which is what it did
 * under the previous watcher as well.
 */
export function projectsEventTarget(relativePath: string | null): string | typeof ALL_TRANSCRIPTS | null {
  if (relativePath === null) return ALL_TRANSCRIPTS;
  const parts = relativePath.split('/');
  if (parts.some((p) => p === '' || p.startsWith('.'))) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2 && parts[1].endsWith('.jsonl')) return relativePath;
  return null;
}

/**
 * The session a subagent's transcript belongs to, for an event on
 * `<project>/<session-id>/subagents/agent-<x>.jsonl`; null for anything
 * else. The index reads none of these, but the tree a running subagent works
 * in is read from them (spec 2026-10-07-live-working-tree-design § 3).
 */
export function subagentEventSession(relativePath: string | null): string | null {
  if (relativePath === null) return null;
  const parts = relativePath.split('/');
  if (parts.length !== 4 || parts.some((p) => p === '' || p.startsWith('.'))) return null;
  if (parts[2] !== 'subagents' || !/^agent-.+\.jsonl$/.test(parts[3])) return null;
  return parts[1];
}

/**
 * Collects targets into one batch: flushed `quietMs` after the last one, and
 * never later than `maxWaitMs` after the first.
 */
export class TargetBatcher {
  private paths = new Set<string>();
  private all = false;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private onFlush: (batch: ProjectsBatch) => void,
    private quietMs = PROJECTS_QUIET_MS,
    private maxWaitMs = PROJECTS_MAX_WAIT_MS,
  ) {}

  add(target: string | typeof ALL_TRANSCRIPTS): void {
    if (target === ALL_TRANSCRIPTS) this.all = true;
    else this.paths.add(target);
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.flush(), this.quietMs);
    this.maxTimer ??= setTimeout(() => this.flush(), this.maxWaitMs);
  }

  flush(): void {
    this.cancel();
    if (!this.all && this.paths.size === 0) return;
    const batch: ProjectsBatch = this.all ? { all: true } : { all: false, paths: [...this.paths] };
    this.all = false;
    this.paths.clear();
    this.onFlush(batch);
  }

  cancel(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.quietTimer = null;
    this.maxTimer = null;
  }
}

/**
 * The `projects/` watch: one recursive directory watch over the whole tree,
 * filtered down to transcripts and batched. A directory that appears only
 * after boot is indexed in full, since nothing announced what was already in
 * it.
 *
 * Subagent transcripts are batched apart, by the session they belong to, and
 * go to `onSubagents`: the index must not read them as transcripts of their
 * own.
 */
export function watchProjects(
  projectsDir: string,
  onBatch: (batch: ProjectsBatch) => void,
  onSubagents?: (sessionIds: string[]) => void,
): DirWatch {
  const batcher = new TargetBatcher(onBatch);
  const agents = new TargetBatcher((batch) => {
    if (!batch.all) onSubagents?.(batch.paths);
  });
  const watch = watchDir(projectsDir, {
    recursive: true,
    onEvent: (rel) => {
      const target = projectsEventTarget(rel);
      if (target !== null) batcher.add(target);
      const session = onSubagents ? subagentEventSession(rel) : null;
      if (session !== null) agents.add(session);
    },
    onAppear: () => batcher.add(ALL_TRANSCRIPTS),
  });
  return {
    close() {
      batcher.cancel();
      agents.cancel();
      watch.close();
    },
  };
}

/**
 * The sessions a batch names by their transcripts, or null when it names
 * something coarser — a project directory, or everything — and so could be
 * any session.
 */
export function batchSessionIds(batch: ProjectsBatch): string[] | null {
  if (batch.all) return null;
  const ids: string[] = [];
  for (const path of batch.paths) {
    const match = path.match(/^[^/]+\/(.+)\.jsonl$/);
    if (!match) return null;
    ids.push(match[1]);
  }
  return ids;
}
