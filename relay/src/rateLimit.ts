/**
 * The one per-IP budget for guessing at the relay: signed pairing requests
 * and WebSocket `auth` refused for its secret draw on it alike, so a short
 * `RELAY_SECRET` cannot be guessed faster over the socket than over pairing.
 */

export const PAIR_RATE_LIMIT_PER_MIN = 20;
/** Past this many tracked IPs, the idle ones are forgotten. */
export const RATE_LIMIT_MAX_IPS = 4096;
const RATE_WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number) {}

  /** Counts one attempt from `ip`; true when that puts it past the budget. */
  hit(ip: string): boolean {
    const now = this.now();
    const recent = this.recent(ip, now);
    recent.push(now);
    this.hits.set(ip, recent);
    if (this.hits.size > RATE_LIMIT_MAX_IPS) {
      for (const [key, times] of this.hits) {
        if (now - times[times.length - 1] >= RATE_WINDOW_MS) this.hits.delete(key);
      }
    }
    return recent.length > PAIR_RATE_LIMIT_PER_MIN;
  }

  /** Whether `ip` has used its budget up, without counting this look. */
  spent(ip: string): boolean {
    return this.recent(ip, this.now()).length >= PAIR_RATE_LIMIT_PER_MIN;
  }

  private recent(ip: string, now: number): number[] {
    return (this.hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  }
}
