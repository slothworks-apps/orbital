import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Store for composer attachments that are not images (spec:
 * 2026-10-01-file-attachments-design). The agent reads them by path, so the
 * leaf keeps the name the file was uploaded under and only the directory
 * above it is the content hash: the same bytes are one entry, and the agent
 * still sees `report.xlsx`.
 */
export interface FileEntry {
  kind: 'file';
  path: string;
  name: string;
  bytes: number;
}

export interface FileStore {
  putBytes(name: string, bytes: Buffer): FileEntry | null;
}

/** Cap in the image store's spirit: the store must not grow forever. */
export const FILE_STORE_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * The uploaded name made safe to be a single path segment: no separators, no
 * control characters, never `.` or `..`. A name with nothing left is `file`.
 */
export function safeFileName(name: string): string {
  const cleaned = [...name.replace(/^.*[/\\]/, '')]
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 200);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

export function createFileStore(dir: string, opts: { maxBytes?: number } = {}): FileStore {
  const maxBytes = opts.maxBytes ?? FILE_STORE_MAX_BYTES;
  mkdirSync(dir, { recursive: true });

  function entrySize(entryDir: string): number {
    return readdirSync(entryDir).reduce((sum, name) => sum + statSync(join(entryDir, name)).size, 0);
  }

  function prune(keep: string) {
    const entries = readdirSync(dir).map((name) => {
      const path = join(dir, name);
      return { name, size: entrySize(path), mtimeMs: statSync(path).mtimeMs };
    });
    let bytes = entries.reduce((sum, e) => sum + e.size, 0);
    if (bytes <= maxBytes) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const e of entries) {
      if (bytes <= maxBytes) break;
      if (e.name === keep) continue;
      rmSync(join(dir, e.name), { recursive: true, force: true });
      bytes -= e.size;
    }
  }

  return {
    putBytes(name, bytes) {
      if (bytes.length === 0) return null;
      const sha = createHash('sha256').update(bytes).digest('hex');
      const entryDir = join(dir, sha);
      const leaf = safeFileName(name);
      const path = join(entryDir, leaf);
      mkdirSync(entryDir, { recursive: true });
      try {
        writeFileSync(path, bytes, { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      // Touched on every put, so a file attached again is the newest entry
      // and the last one pruning reaches.
      const now = new Date();
      utimesSync(entryDir, now, now);
      prune(sha);
      return { kind: 'file', path, name: leaf, bytes: bytes.length };
    },
  };
}
