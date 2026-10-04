import { vi } from 'vitest'
import type * as apiModule from '../lib/api'

/**
 * The module factory every test file hands to `vi.mock('../lib/api', …)`.
 *
 * It is built from the real `api`'s own keys rather than from a list written
 * out by hand, because of two mistakes a list invites and cannot catch. A
 * method the list forgets is `undefined`. A `vi.fn()` the test forgets to
 * stub returns `undefined`. Both of them throw on the `.catch` the store
 * chains onto the call, outside React's dispatch and therefore outside the
 * test's assertions — so the test passes, and the run fails on an unhandled
 * error pointing at a line the test never meant to exercise.
 *
 * Here every method on `api` exists, and every one the test leaves alone
 * resolves. Tests override what they care about the usual way:
 *
 * ```ts
 * vi.mocked(api.listSessions).mockResolvedValue([…])
 * ```
 *
 * The resolving default is passed to `vi.fn` as its ARGUMENT, not installed
 * afterwards with `.mockResolvedValue(undefined)`. That is load-bearing, not
 * style: vitest treats the argument as the mock's original implementation, so
 * it survives `mockReset`, `mockRestore` and `vi.resetAllMocks()`, while an
 * implementation installed afterwards is stripped by all three. A file that
 * resets mocks between tests used to fall back to a bare `vi.fn()` and get
 * the `undefined` this helper exists to prevent; now resetting only undoes the
 * test's own overrides and lands back on a default that still resolves.
 * (`vi.restoreAllMocks()` leaves `vi.fn` mocks alone; it only takes spies off.)
 *
 * The rest of the module — `ApiError` above all, which `instanceof` checks in
 * the store depend on — is passed through untouched.
 */
export async function mockApiModule(): Promise<typeof apiModule> {
  const actual = await vi.importActual<typeof apiModule>('../lib/api')
  const api = Object.fromEntries(
    Object.keys(actual.api).map((name) => [name, vi.fn(async () => undefined)]),
  ) as unknown as typeof actual.api
  return { ...actual, api }
}
