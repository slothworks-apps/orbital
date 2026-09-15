import { EventEmitter } from 'node:events';
import { openSync, readSync, closeSync, statSync, watch, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import { parseTranscriptLine, type TranscriptEntry } from '../transcript/parser.js';

export class TranscriptTail extends EventEmitter {
  offset = 0;
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(private filePath: string) {
    super();
  }

  private readNew(): void {
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return;
    }
    if (size <= this.offset) return;
    const length = size - this.offset;
    const buf = Buffer.alloc(length);
    let fd: number;
    try {
      fd = openSync(this.filePath, 'r');
    } catch {
      return;
    }
    try {
      readSync(fd, buf, 0, length, this.offset);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return; // only a partial line so far
    const complete = text.slice(0, lastNewline + 1);
    this.offset += Buffer.byteLength(complete);
    const entries: TranscriptEntry[] = [];
    for (const line of complete.split('\n')) {
      const e = parseTranscriptLine(line);
      if (e) entries.push(e);
    }
    if (entries.length) this.emit('entries', entries);
  }

  start(fromByte = 0): void {
    this.offset = fromByte;
    this.readNew();
    // Watch the containing directory rather than the file itself. On macOS,
    // fs.watch(filePath) registers its kqueue vnode watch with enough latency
    // that a write occurring synchronously right after the watch() call (as
    // happens whenever a caller writes immediately after start()) can be
    // missed entirely — reproduced deterministically outside this class with
    // plain fs.watch + appendFileSync. Watching the parent directory does not
    // suffer from this race, so filter events down to this file by name.
    const target = basename(this.filePath);
    try {
      this.watcher = watch(dirname(this.filePath), (_eventType, filename) => {
        if (filename && filename !== target) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.readNew(), 150);
      });
    } catch (err) {
      console.warn(`orbital: cannot watch ${this.filePath}:`, err);
    }
  }

  stop(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = null;
  }
}

