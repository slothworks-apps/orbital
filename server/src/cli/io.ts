/**
 * The terminal as the CLI's flows see it: lines out, lines in, a clock and
 * Ctrl-C. Injected, so the flows run against scripted answers in tests.
 */
import { createInterface, type Interface } from 'node:readline';

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** One line typed, trimmed; null at the end of input or on Ctrl-C. */
  ask(question: string): Promise<string | null>;
  /** Waits `ms`; `interrupt` when Ctrl-C came first. */
  wait(ms: number): Promise<'tick' | 'interrupt'>;
  now(): number;
}

/** `[y/N]`: only a yes is a yes. */
export async function confirm(io: Io, question: string): Promise<boolean> {
  const answer = await io.ask(`${question} [y/N] `);
  return answer !== null && /^y(es)?$/i.test(answer);
}

/**
 * The process's own terminal. One readline for every question, so piped
 * lines are not lost between two of them; Ctrl-C ends a question as no
 * answer and a wait as `interrupt`, and outside both it ends the CLI.
 */
export class TerminalIo implements Io {
  private rl: Interface | null = null;
  private lines: string[] = [];
  private ended = false;
  private reader: ((line: string | null) => void) | null = null;
  private interrupter: (() => void) | null = null;
  private readonly onSigint = () => this.interrupt();

  constructor() {
    process.on('SIGINT', this.onSigint);
  }

  out(line: string): void {
    process.stdout.write(`${line}\n`);
  }

  err(line: string): void {
    process.stderr.write(`${line}\n`);
  }

  now(): number {
    return Date.now();
  }

  ask(question: string): Promise<string | null> {
    const rl = this.readline();
    process.stdout.write(question);
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

  wait(ms: number): Promise<'tick' | 'interrupt'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.interrupter = null;
        resolve('tick');
      }, ms);
      this.interrupter = () => {
        clearTimeout(timer);
        this.interrupter = null;
        resolve('interrupt');
      };
    });
  }

  close(): void {
    process.off('SIGINT', this.onSigint);
    this.rl?.close();
  }

  private interrupt(): void {
    if (this.reader) {
      process.stdout.write('\n');
      this.reader(null);
    } else if (this.interrupter) {
      process.stdout.write('\n');
      this.interrupter();
    } else {
      this.close();
      process.exit(1);
    }
  }

  private readline(): Interface {
    if (this.rl) return this.rl;
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      if (this.reader) this.reader(line);
      else this.lines.push(line);
    });
    rl.on('close', () => {
      this.ended = true;
      this.reader?.(null);
    });
    this.rl = rl;
    return rl;
  }
}
