/**
 * The relay's log lines: metadata only — id prefixes, states and counts,
 * never a frame body or a display name (spec 2026-09-30-mobile-remote-design
 * § 2 Logs, runbook `run-the-relay` "Logs").
 */

/** Enough of an id or a push token to tell two apart in a log, not to use one. */
export const LOG_ID_PREFIX_CHARS = 8;

export function short(id: string): string {
  return id.slice(0, LOG_ID_PREFIX_CHARS);
}

export function log(line: string): void {
  console.log(`relay: ${line}`);
}
