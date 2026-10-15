/**
 * The most recent output of one terminal, replayed to a window that attaches
 * (spec 2026-10-05-embedded-terminal-design § Scrollback). Held in memory
 * only: the shell does not outlive the server, so neither does its history.
 */
export class Scrollback {
  private chunks: string[] = [];
  private length = 0;

  constructor(private readonly limit: number) {}

  /** Trims only past twice the limit, so a busy shell does not re-join the buffer on every write. */
  push(data: string): void {
    this.chunks.push(data);
    this.length += data.length;
    if (this.length > this.limit * 2) this.trim();
  }

  text(): string {
    return this.chunks.join('');
  }

  /**
   * Drops the oldest output down to the limit, and then to the next line
   * start, so the replay does not open in the middle of a line or of an
   * escape sequence that line began.
   */
  private trim(): void {
    let text = this.chunks.join('').slice(this.length - this.limit);
    const newline = text.indexOf('\n');
    if (newline >= 0) text = text.slice(newline + 1);
    this.chunks = [text];
    this.length = text.length;
  }
}
