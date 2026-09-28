import { closeSync, openSync, readSync, statSync } from 'node:fs';

/**
 * The most of a background task's output file one read hands out — the tail
 * `GET /api/sessions/:id/tasks/:taskId/output` returns, and the most one
 * follow step publishes at once. The view keeps only its last lines anyway
 * (spec 2026-09-28-background-tasks-design § 4), so there is no paging back
 * past it.
 */
export const OUTPUT_TAIL_BYTES = 256 * 1024;

/**
 * How often a followed output file is checked for new bytes. A poll rather
 * than `fs.watch`: a file watch on macOS is a kqueue descriptor with a
 * registration race (see `TranscriptTail`), the CLI's tasks directory holds a
 * file per task ever run, and one `stat` per open view per tick is nothing.
 */
export const TASK_OUTPUT_POLL_MS = 250;

/** How much of the file's end `readExitCode` looks at for the closing line. */
const EXIT_LINE_BYTES = 512;

/** A slice of an output file: `text` is bytes `[start, end)` of it, decoded. */
export interface OutputSlice {
  text: string;
  start: number;
  end: number;
}

/**
 * The exit code the CLI appends as an output file's closing line,
 * `[exited with code N]`, or undefined when the last non-empty line is
 * anything else — a task still running, one that was killed before the line
 * was written, or a file that is not a shell's at all. The SDK sends no exit
 * code; this line is the only source (spec § 2).
 */
export function parseExitCode(tail: string): number | undefined {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = /^\[exited with code (-?\d+)\]$/.exec(line);
    return m ? Number(m[1]) : undefined;
  }
  return undefined;
}

/**
 * How many bytes at the start of `buf` form whole UTF-8 characters. A read
 * that ends inside a multi-byte character leaves its first bytes out, so the
 * next read can start with them and nothing is ever decoded in halves.
 */
export function completeUtf8Length(buf: Buffer): number {
  const n = buf.length;
  // A character is at most four bytes, so only the last three can belong to
  // one that has not finished.
  for (let back = 1; back <= Math.min(3, n); back++) {
    const byte = buf[n - back];
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte: keep looking
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? n - back : n;
  }
  return n;
}

/** How many continuation bytes `buf` starts with — a read cut into the middle of a character. */
function leadingContinuationBytes(buf: Buffer): number {
  let i = 0;
  while (i < buf.length && i < 3 && (buf[i] & 0xc0) === 0x80) i++;
  return i;
}

function readRange(path: string, start: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    const read = readSync(fd, buf, 0, length, start);
    return read === length ? buf : buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The last `maxBytes` of an output file, cut forward to the first line start
 * so the view never opens on half a line — unless the slice starts at byte 0,
 * or holds no line break at all (a progress bar redrawn with `\r` is one long
 * line), where it is cut only to the first whole character instead. A partial
 * character at the end is left for the next read. `null` when the file does
 * not exist; any other failure throws.
 */
export function readOutputTail(path: string, maxBytes: number = OUTPUT_TAIL_BYTES): OutputSlice | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  let start = Math.max(0, size - maxBytes);
  let buf: Buffer;
  try {
    buf = readRange(path, start, size - start);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  if (start > 0) {
    const newline = buf.indexOf(0x0a);
    const cut = newline >= 0 ? newline + 1 : leadingContinuationBytes(buf);
    buf = buf.subarray(cut);
    start += cut;
  }
  const whole = completeUtf8Length(buf);
  return { text: buf.subarray(0, whole).toString('utf8'), start, end: start + whole };
}

/**
 * The exit code off the end of an output file, or undefined — no file, no
 * closing line yet, or one that is not an exit line.
 */
export function readExitCode(path: string): number | undefined {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - EXIT_LINE_BYTES);
    return parseExitCode(readRange(path, start, size - start).toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Follows one output file while a view has it open: every tick, the bytes
 * appended since the last one go out as `{ offset, text }`, where `offset` is
 * the byte offset of `text`'s first byte in the file — the same offset-delta
 * shape the streamed transcript text uses (adr
 * streamed-text-rides-as-offset-deltas-on-the-rows-id). It starts at the end
 * of the file: the client subscribes first and then reads the tail over REST,
 * dropping whatever of a delta lies below that tail's `end`, so an overlap
 * is harmless and a gap cannot open.
 *
 * A file that falls more than `OUTPUT_TAIL_BYTES` behind between ticks is
 * skipped forward to its last `OUTPUT_TAIL_BYTES`; the view keeps only its
 * last lines, so the skipped bytes would have been dropped there anyway.
 */
export class OutputFollower {
  private pos = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private path: string,
    private onOutput: (offset: number, text: string) => void,
    private onGone: () => void,
    private pollMs: number = TASK_OUTPUT_POLL_MS,
  ) {}

  start(): void {
    try {
      this.pos = statSync(this.path).size;
    } catch (err) {
      if (isMissing(err)) return this.onGone();
    }
    this.timer = setInterval(() => this.tick(), this.pollMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check for new bytes. Public so a test can drive it without the clock. */
  tick(): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch (err) {
      if (isMissing(err)) {
        this.stop();
        this.onGone();
      }
      return;
    }
    // Output files only grow; one that shrank was replaced, so read it anew.
    if (size < this.pos) this.pos = 0;
    if (size === this.pos) return;
    let from = this.pos;
    let skipped = false;
    if (size - from > OUTPUT_TAIL_BYTES) {
      from = size - OUTPUT_TAIL_BYTES;
      skipped = true;
    }
    let buf: Buffer;
    try {
      buf = readRange(this.path, from, size - from);
    } catch {
      return;
    }
    if (skipped) {
      const cut = leadingContinuationBytes(buf);
      buf = buf.subarray(cut);
      from += cut;
    }
    const whole = completeUtf8Length(buf);
    if (whole === 0) return;
    this.pos = from + whole;
    this.onOutput(from, buf.subarray(0, whole).toString('utf8'));
  }
}
