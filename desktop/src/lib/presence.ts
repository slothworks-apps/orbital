/**
 * Whether the user is at the Mac, for the server to quiet the phone with
 * (spec 2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design § 1).
 * Pure: `main.ts` reads `powerMonitor` and sends what this decides.
 */

/** Input seen within this many seconds, in any app, counts as being at the Mac. */
export const PRESENCE_IDLE_SECONDS = 180;
/** How often presence is read and, while it holds, sent as a heartbeat; shorter than the server's `PRESENCE_TTL_MS`. */
export const PRESENCE_POLL_MS = 15_000;

/** `powerMonitor.getSystemIdleState`'s answer. */
export type IdleState = 'active' | 'idle' | 'locked' | 'unknown';

/**
 * What to report after one reading: `true` on every reading while present
 * (the heartbeat), `false` once when presence ends, `null` while away. An
 * `unknown` state is not presence: a phone that buzzes needlessly is a lesser
 * loss than one that stays silent.
 */
export function presenceReport(state: IdleState, wasPresent: boolean): boolean | null {
  if (state === 'active') return true;
  return wasPresent ? false : null;
}
