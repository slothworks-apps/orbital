/**
 * How a device compares relay URLs and decides what a change of its relay
 * settings does — the same on the desktop's Settings → Devices, the
 * pairing ceremony and the `orbital` CLI. Platform-free.
 */

/** A relay URL as two devices compare it: a trailing slash does not make it another relay. */
export function sameRelay(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** What committing a relay setting does (`relayUrlCommit`, `relaySecretCommit`). */
export type RelayCommit = 'none' | 'unknown' | 'save' | 'ask';

/**
 * What committing the Relay URL does: nothing when the trimmed value is
 * what is saved, save it when no phone is paired, and otherwise ask first —
 * the paired phones are removed with the change. With the count unknown (no
 * status yet) a change is `unknown`: it can neither skip the confirm nor ask
 * about phones it cannot count, so it waits.
 */
export function relayUrlCommit(saved: string, typed: string, pairedCount: number | null): RelayCommit {
  if (typed.trim() === saved.trim()) return 'none';
  if (pairedCount === null) return 'unknown';
  return pairedCount === 0 ? 'save' : 'ask';
}

/**
 * What committing the Relay secret does (ADR
 * the-relay-takes-a-shared-secret): as `relayUrlCommit`, except that clearing
 * it saves without asking — a relay without `RELAY_SECRET` accepts the secret
 * the paired phones still send, so nothing strands them.
 */
export function relaySecretCommit(saved: string, typed: string, pairedCount: number | null): RelayCommit {
  if (typed.trim() !== saved.trim() && typed.trim() === '') return 'save';
  return relayUrlCommit(saved, typed, pairedCount);
}
