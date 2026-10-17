/**
 * Writes one value at a time, the newest last: a value pushed while a write
 * runs waits, and a newer one replaces it, so storage ends on the last state
 * and never on an older one that finished late. No Capacitor here; the write
 * is injected.
 */
export class PersistQueue<T> {
  private readonly write: (value: T) => Promise<void>
  private running: Promise<void> | null = null
  private pending: { value: T } | null = null
  private closed = false
  /** What the last write threw; null once one succeeds. */
  private failure: unknown = null

  constructor(write: (value: T) => Promise<void>) {
    this.write = write
  }

  push(value: T): void {
    if (this.closed) return
    this.pending = { value }
    if (!this.running) this.running = this.drain()
  }

  /** Nothing more is written: a write still waiting is dropped, one running finishes (`idle`). */
  close(): void {
    this.closed = true
    this.pending = null
  }

  /** Resolves once no write runs. */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  /** What the last write threw, or null when it was stored. */
  get lastError(): unknown {
    return this.failure
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        const { value } = this.pending
        this.pending = null
        try {
          await this.write(value)
          this.failure = null
        } catch (err) {
          // The next push writes the whole state again.
          this.failure = err
          console.warn('[mobile] could not store the device group', err)
        }
      }
    } finally {
      this.running = null
    }
  }
}
