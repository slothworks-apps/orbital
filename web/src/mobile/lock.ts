import { APP_LOCK_GRACE_MS } from './constants'

/**
 * Where the app lock stands (spec 2026-10-06-pairing-code-and-app-lock-design
 * § 3, canvas 9t). `open`: the app shows. `covered`: an open app on its way
 * to the background, with 9t drawn over it for the app-switcher snapshot; a
 * quick return uncovers it without asking. `locked`: 9t until the user
 * authenticates (a cancelled prompt leaves it here). `prompt`: 9t, and the
 * system prompt is due to open over it.
 */
export type AppLock = 'open' | 'covered' | 'locked' | 'prompt'

/** A cold start: with the lock on, 9t and its prompt. */
export function lockAtStart(enabled: boolean): AppLock {
  return enabled ? 'prompt' : 'open'
}

/**
 * Whether a return to the foreground asks: only with the lock on, and only
 * after more than APP_LOCK_GRACE_MS away. A foreground with no departure
 * on record is not a return.
 */
export function lockOnForeground({
  enabled, backgroundedAt, now,
}: { enabled: boolean; backgroundedAt: number | null; now: number }): boolean {
  return enabled && backgroundedAt !== null && now - backgroundedAt > APP_LOCK_GRACE_MS
}

/** On the way out: an open app is covered at once, so the snapshot shows 9t and not the last screen. */
export function lockOnBackground(lock: AppLock, enabled: boolean): AppLock {
  if (!enabled) return lock
  if (lock === 'open') return 'covered'
  return lock === 'prompt' ? 'locked' : lock
}

/** Back in the foreground: a quick return uncovers, a long one asks, and a lock never opened stays shut. */
export function lockOnReturn(
  lock: AppLock,
  when: { enabled: boolean; backgroundedAt: number | null; now: number },
): AppLock {
  if (lock === 'open' || !when.enabled) return 'open'
  if (lock === 'prompt' || lockOnForeground(when)) return 'prompt'
  return lock === 'covered' ? 'open' : 'locked'
}
