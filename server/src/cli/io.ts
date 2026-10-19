/**
 * The terminal as the CLI's flows see it: lines out, lines in, a clock and
 * Ctrl-C. Injected, so the flows run against scripted answers in tests.
 */
import { createInterface, type Interface } from 'node:readline';

/**
 * `s` with every C0 and C1 control character and DEL taken out, and the
 * Unicode controls that reorder or break a line (bidi embeddings, overrides
 * and isolates, LRM/RLM, the line and paragraph separators). Names, OS
 * words and codes come from other devices, and an escape sequence in one
 * would move the cursor, recolour or retitle the terminal, or forge a line;
 * a bidi override would make one read as something else.
 * The CLI prints no control character of its own, so everything it prints
 * goes through this (`TerminalIo`).
 */
export function printable(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');
}

/** What `ask` answers when its deadline passed before a line came. */
export const TIMED_OUT = Symbol('timed out');

/**
 * Ctrl-C held for a stretch of work: `signal` settles at the first one, and
 * the work decides how to end. Released, Ctrl-C ends the CLI again.
 */
export interface Trap {
  signal: Promise<void>;
  release(): void;
}

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /**
   * One line typed, trimmed; null at the end of input or on Ctrl-C;
   * `TIMED_OUT` once `until` (epoch ms) passes first.
   */
  ask(question: string, until?: number): Promise<string | null | typeof TIMED_OUT>;
  /** As `ask`, with nothing echoed while it is typed on a terminal. */
  askSecret(question: string): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  /** Holds Ctrl-C until released (`Trap`). */
  trap(): Trap;
  now(): number;
}

/** `[y/N]`: only a yes is a yes. */
export async function confirm(io: Io, question: string): Promise<boolean> {
  const answer = await io.ask(`${question} [y/N] `);
  return typeof answer === 'string' && /^y(es)?$/i.test(answer);
}

/**
 * The process's own terminal. One readline for every question, so piped
 * lines are not lost between two of them. Ctrl-C ends a question as no
 * answer, settles a trap, and outside both ends the CLI.
 */
export class TerminalIo implements Io {
  private rl: Interface | null = null;
  private lines: string[] = [];
  private ended = false;
  private reader: ((line: string | null) => void) | null = null;
  private traps: (() => void)[] = [];
  /** A trap was sprung: a second Ctrl-C while its work ends ends the CLI at once. */
  private sprung = false;
  private readonly onSigint = () => this.interrupt();

  constructor() {
    process.on('SIGINT', this.onSigint);
  }

  out(line: string): void {
    process.stdout.write(`${printable(line)}\n`);
  }

  err(line: string): void {
    process.stderr.write(`${printable(line)}\n`);
  }

  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  trap(): Trap {
    let fire!: () => void;
    const signal = new Promise<void>((resolve) => {
      fire = resolve;
    });
    this.traps.push(fire);
    return { signal, release: () => void (this.traps = this.traps.filter((t) => t !== fire)) };
  }

  ask(question: string, until?: number): Promise<string | null | typeof TIMED_OUT> {
    process.stdout.write(printable(question));
    const line = this.readLine();
    if (until === undefined) return line;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        // The question is withdrawn: a line typed later is no answer to it.
        this.reader = null;
        process.stdout.write('\n');
        resolve(TIMED_OUT);
      }, Math.max(0, until - Date.now()));
    });
    return Promise.race([line, late]).finally(() => clearTimeout(timer));
  }

  async askSecret(question: string): Promise<string | null> {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      process.stdout.write(printable(question));
      return this.readLine();
    }
    // Raw, unechoed: the line reader would echo nothing either, but it must not see these keys.
    const rl = this.rl;
    this.rl = null;
    rl?.close();
    process.stdout.write(printable(question));
    stdin.setRawMode(true);
    stdin.resume();
    try {
      return await new Promise<string | null>((resolve) => {
        let typed = '';
        const onData = (chunk: Buffer) => {
          for (const ch of chunk.toString('utf8')) {
            if (ch === '\r' || ch === '\n') return done(typed.trim());
            if (ch === '\u0003' || (ch === '\u0004' && typed === '')) return done(null);
            if (ch === '\u007f' || ch === '\b') typed = typed.slice(0, -1);
            else if (ch >= ' ') typed += ch;
          }
        };
        const done = (value: string | null) => {
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
        };
        stdin.on('data', onData);
      });
    } finally {
      stdin.setRawMode(false);
      stdin.pause();
    }
  }

  close(): void {
    process.off('SIGINT', this.onSigint);
    this.rl?.close();
  }

  private readLine(): Promise<string | null> {
    const rl = this.readline();
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued.trim());
    if (this.ended) return Promise.resolve(null);
    rl.resume();
    return new Promise((resolve) => {
      this.reader = (line) => {
        this.reader = null;
        resolve(line === null ? null : line.trim());
      };
    });
  }

  private interrupt(): void {
    if (this.reader) {
      process.stdout.write('\n');
      this.reader(null);
    } else if (this.traps.length > 0 && !this.sprung) {
      this.sprung = true;
      process.stdout.write('\n');
      for (const fire of this.traps) fire();
    } else {
      this.close();
      process.exit(1);
    }
  }

  private readline(): Interface {
    if (this.rl) return this.rl;
    this.ended = false;
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      if (this.reader) this.reader(line);
      else this.lines.push(line);
    });
    rl.on('close', () => {
      // Closed for a secret prompt, not the end of input.
      if (this.rl !== rl) return;
      this.ended = true;
      this.reader?.(null);
    });
    this.rl = rl;
    return rl;
  }
}
