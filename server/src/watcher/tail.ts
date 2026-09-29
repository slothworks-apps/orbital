import { EventEmitter } from 'node:events';
import { openSync, readSync, closeSync, statSync, watch, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import { parseTranscript, parseTranscriptLine, type TranscriptEntry } from '../transcript/parser.js';
import { BranchFollower } from '../transcript/liveBranch.js';

/**
 * Follows a transcript's appends and emits them as `entries`, the live branch
 * only (spec 2026-09-29-rewind-design § Reading the live branch). A batch
 * that changes the branch — a rewind, or an interrupt's dangling call
 * dropped — emits `reset` instead: what a reader already holds is no longer
 * the transcript, and it has to be read again.
 */
export class TranscriptTail extends EventEmitter {
  offset = 0;
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  /**
   * Built on the first append, from the file up to where the tail started:
   * a tail opened on a session that never writes again costs no parse.
   */
  private follower: BranchFollower | null = null;

  constructor(private filePath: string) {
    super();
  }

  private readRange(from: number, length: number): string | null {
    const buf = Buffer.alloc(length);
    let fd: number;
    try {
      fd = openSync(this.filePath, 'r');
    } catch {
      return null;
    }
    try {
      readSync(fd, buf, 0, length, from);
    } finally {
      closeSync(fd);
    }
    return buf.toString('utf8');
  }

  private readNew(): void {
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return;
    }
    if (size <= this.offset) return;
    const text = this.readRange(this.offset, size - this.offset);
    if (text === null) return;
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return; // only a partial line so far
    const complete = text.slice(0, lastNewline + 1);
    const before = this.offset;
    this.offset += Buffer.byteLength(complete);
    const entries: TranscriptEntry[] = [];
    for (const line of complete.split('\n')) {
      const e = parseTranscriptLine(line);
      if (e) entries.push(e);
    }
    if (!entries.length) return;
    this.follower ??= new BranchFollower(before > 0 ? parseTranscript(this.readRange(0, before) ?? '') : []);
    const result = this.follower.append(entries);
    if (result.kind === 'reset') this.emit('reset');
    else if (result.entries.length) this.emit('entries', result.entries);
  }

  start(fromByte = 0): void {
    this.offset = fromByte;
    this.follower = null;
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

