/**
 * A countdown that stops while the pointer rests on what it would close and
 * goes on from where it was (canvas `Feature - Notifications off` 1b: "It stays
 * 8 s and the timer pauses while the pointer is over it"). Resuming does not
 * start over: hovering on and off cannot keep a notice up for ever.
 */
export class PausableTimer {
  private remaining: number
  private startedAt: number | null = null
  private handle: ReturnType<typeof setTimeout> | null = null
  private done = false
  private readonly onElapsed: () => void
  private readonly now: () => number

  constructor(ms: number, onElapsed: () => void, now: () => number = Date.now) {
    this.remaining = ms
    this.onElapsed = onElapsed
    this.now = now
  }

  /** Starts, or goes on after a pause. A no-op while running or once elapsed. */
  resume(): void {
    if (this.done || this.handle !== null) return
    this.startedAt = this.now()
    this.handle = setTimeout(() => {
      this.handle = null
      this.done = true
      this.onElapsed()
    }, this.remaining)
  }

  pause(): void {
    if (this.handle === null || this.startedAt === null) return
    clearTimeout(this.handle)
    this.handle = null
    this.remaining = Math.max(0, this.remaining - (this.now() - this.startedAt))
    this.startedAt = null
  }

  /** Stops for good; nothing fires after this. */
  cancel(): void {
    if (this.handle !== null) clearTimeout(this.handle)
    this.handle = null
    this.done = true
  }
}
