import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'

// ---------------------------------------------------------------------------
// This file exists to keep `apiMock`'s resolving defaults alive across the
// cleanup two files in this suite run between tests (they spy on
// `console.error`): `vi.resetAllMocks()`, which rolls every mock back to its
// original implementation and strips one installed with
// `.mockResolvedValue(…)` after the mock was made, then `vi.restoreAllMocks()`,
// which takes the spies off and leaves `vi.fn` mocks alone. A stripped default
// used to put the whole `undefined.catch` class of bug back inside those files
// from their second test onward. The defaults are therefore passed to `vi.fn`
// as its argument, which vitest keeps as the original implementation.
//
// The order matters: the assertions below only mean anything in the test that
// runs AFTER the first `afterEach`.
// ---------------------------------------------------------------------------
afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

describe('the api mock under resetAllMocks and restoreAllMocks', () => {
  it('starts out resolving, and takes a test-local override', async () => {
    expect(api.listSessions()).toBeInstanceOf(Promise)

    vi.mocked(api.listSessions).mockResolvedValue([])
    await expect(api.listSessions()).resolves.toEqual([])
  })

  it('still resolves for a method this test never stubbed', async () => {
    // `undefined` here is the bug: the store chains `.catch` onto calls like
    // this one, and `undefined.catch` throws past the test's assertions.
    expect(api.patchSettings({})).toBeInstanceOf(Promise)
    await expect(api.patchSettings({})).resolves.toBeUndefined()
  })

  it('undoes the previous test’s override without losing the default', async () => {
    // The `mockResolvedValue([])` above is gone — resetting rolls back to the
    // default, not past it.
    expect(api.listSessions()).toBeInstanceOf(Promise)
    await expect(api.listSessions()).resolves.toBeUndefined()
  })
})
