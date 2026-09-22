import { api, ApiError } from './api'
import { useOrbital } from '../store/store'

/**
 * Turns whatever was thrown into the long form the error log keeps.
 *
 * An `ApiError`'s `message` IS the response body (see `request()` in
 * `api.ts`, which reads `response.text()` into it), so for those the body is
 * the detail. Anything else contributes its stack.
 */
function detailOf(err: unknown): string | null {
  if (err instanceof ApiError) return err.message || null
  if (err instanceof Error) return err.stack ?? null
  if (err === undefined || err === null) return null
  if (typeof err === 'string') return err
  // Something that is not an Error was thrown. `String()` on an object gives
  // `[object Object]`, which records nothing; JSON at least keeps the fields.
  try {
    return JSON.stringify(err) ?? null
  } catch {
    return null
  }
}

/**
 * Sets the shared error toast for a failed fire-and-forget API call kicked
 * off directly from a component (rename, tag-toggle, stop, clear), mirroring
 * the pattern the store's own `sendPrompt` action uses for the same class of
 * error. Shared across `DetailPanel`/`StopDialog`/`ClearDialog` rather than
 * duplicated in each.
 *
 * It also records the failure in the shared error log, with the two things
 * the toast has never had room for and this function used to throw away: the
 * HTTP status and the response body
 * (`docs/superpowers/specs/2026-09-17-error-surface-design.md`).
 */
export function reportError(err: unknown, fallback: string): void {
  const message = err instanceof Error ? err.message : fallback
  useOrbital.setState({ toast: { kind: 'error', message } })

  const context: Record<string, unknown> = {}
  if (err instanceof ApiError) {
    context.status = err.status
    if (err.url) context.url = err.url
  }

  void api
    .reportErrorToServer({
      kind: 'api_request',
      message,
      detail: detailOf(err),
      context: Object.keys(context).length > 0 ? context : null,
    })
    // The one call in this design that must NOT be reported the normal way.
    // Routing a failed report back through `reportError` would post about
    // the post, fail again, and keep going — so it stops at the console.
    .catch((reportErr) => {
      console.error('orbital: failed to record an error', reportErr)
    })
}
