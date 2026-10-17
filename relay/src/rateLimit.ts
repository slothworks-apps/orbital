/**
 * Per-IP budgets at the relay. The one for guessing: signed pairing requests
 * and WebSocket `auth` refused for its secret draw on it alike, so a short
 * `RELAY_SECRET` cannot be guessed faster over the socket than over pairing.
 * Mutual pairs and revokes, which group members post by themselves, draw on
 * a second one instead, so linking never locks a connect out.
 */

export const PAIR_RATE_LIMIT_PER_MIN = 20;
/**
 * The budget for `/pair/mutual` and `/pair/revoke`: every member asks for a
 * pair with every other at each relay connection, so it is larger than
 * `PAIR_RATE_LIMIT_PER_MIN`. It is never what a connect checks.
 */
export const MUTUAL_RATE_LIMIT_PER_MIN = 4 * PAIR_RATE_LIMIT_PER_MIN;
/** Past this many tracked IPs, the idle ones are forgotten. */
export const RATE_LIMIT_MAX_IPS = 4096;
const RATE_WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  private readonly now: () => number;
  private readonly perMin: number;

  constructor(now: () => number, perMin = PAIR_RATE_LIMIT_PER_MIN) {
    this.now = now;
    this.perMin = perMin;
  }

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
    return recent.length > this.perMin;
  }

  /** Whether `ip` has used its budget up, without counting this look. */
  spent(ip: string): boolean {
    return this.recent(ip, this.now()).length >= this.perMin;
  }

  private recent(ip: string, now: number): number[] {
    return (this.hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  }
}
