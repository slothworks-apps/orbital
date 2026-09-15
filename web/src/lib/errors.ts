import { useOrbital } from '../store/store'

/**
 * Sets the shared error toast for a failed fire-and-forget API call kicked
 * off directly from a component (rename, tag-toggle, stop, clear), mirroring
 * the pattern the store's own `sendPrompt` action uses for the same class of
 * error. Shared across `DetailPanel`/`StopDialog`/`ClearDialog` rather than
 * duplicated in each.
 */
export function reportError(err: unknown, fallback: string): void {
  const message = err instanceof Error ? err.message : fallback
  useOrbital.setState({ toast: { kind: 'error', message } })
}
