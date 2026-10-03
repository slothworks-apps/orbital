import { useSyncExternalStore } from 'react'

/**
 * Whether the server has refused this page for lacking the API token
 * (spec 2026-10-03-api-token-and-named-files-design § "The client without a
 * token"). One-way: once set, the page shows the one quiet screen until it is
 * reloaded through the link the server printed, which sets the cookie.
 *
 * Module-level rather than in the store, because `lib/api` sets it and the
 * entry point reads it above everything the store drives.
 */
let unauthorized = false
const listeners = new Set<() => void>()

export function markUnauthorized(): void {
  if (unauthorized) return
  unauthorized = true
  for (const listener of [...listeners]) listener()
}

export function isUnauthorized(): boolean {
  return unauthorized
}

/** Called once, when the page is first refused. Returns the unsubscribe. */
export function onUnauthorized(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useUnauthorized(): boolean {
  return useSyncExternalStore(onUnauthorized, isUnauthorized)
}
