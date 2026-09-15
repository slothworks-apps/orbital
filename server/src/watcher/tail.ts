import { EventEmitter } from 'node:events';
import { openSync, readSync, closeSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { parseTranscriptLine, type TranscriptEntry } from '../transcript/parser.js';

export class TranscriptTail extends EventEmitter {
  offset = 0;
  private watching = false;
  private lastSize = 0;
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
    try {
      this.lastSize = statSync(this.filePath).size;
    } catch {
      // ignore
    }
    this.watching = true;
    try {
      watchFile(this.filePath, { interval: 100 }, () => {
        if (!this.watching) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.readNew(), 150);
      });
    } catch (err) {
      console.warn(`orbital: cannot watch ${this.filePath}:`, err);
    }
  }

  stop(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.watching = false;
    unwatchFile(this.filePath);
  }
}

