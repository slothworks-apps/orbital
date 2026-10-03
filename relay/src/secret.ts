/**
 * The relay's shared secret check (ADR the-relay-takes-a-shared-secret).
 * Both sides are hashed first so `timingSafeEqual` always compares equal
 * lengths: neither the content nor the length of the secret leaks through
 * timing.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export function secretMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false;
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(given));
}
