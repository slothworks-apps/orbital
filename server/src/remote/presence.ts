/**
 * Whether the user is at the Mac, from the desktop app's heartbeats (spec
 * 2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design § 1). A
 * heartbeat holds it for `PRESENCE_TTL_MS`; a desktop app that crashes or
 * quits stops sending them, so it cannot keep the phone silent.
 */
import { PRESENCE_TOPIC } from '@orbital/shared/presence';

/** Longer than the desktop's poll, so one late heartbeat does not end presence. */
export const PRESENCE_TTL_MS = 45_000;

export type PresenceOptions = {
  publish: (topic: string, payload: Record<string, unknown>) => void;
  now?: () => number;
  ttlMs?: number;
};

export class Presence {
  private until = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly opts: PresenceOptions) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? PRESENCE_TTL_MS;
  }

  get atMac(): boolean {
    return this.until > this.now();
  }

  /** One report from the desktop: a heartbeat extends presence, `false` ends it now. */
  report(atMac: boolean): void {
    const was = this.atMac;
    this.clearTimer();
    if (atMac) {
      this.until = this.now() + this.ttlMs;
      this.timer = setTimeout(() => this.expire(), this.ttlMs);
      this.timer.unref?.();
    } else {
      this.until = 0;
    }
    if (this.atMac !== was) this.publish();
  }

  dispose(): void {
    this.clearTimer();
  }

  private expire(): void {
    this.timer = null;
    this.until = 0;
    this.publish();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private publish(): void {
    this.opts.publish(PRESENCE_TOPIC, { event: 'state', atMac: this.atMac });
  }
}
