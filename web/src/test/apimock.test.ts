import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'

// ---------------------------------------------------------------------------
// This file exists to keep `apiMock`'s resolving defaults alive across a
// `vi.restoreAllMocks()`. Two files in this suite restore mocks between tests
// (they spy on `console.error`), and restoring strips an implementation that
// was installed with `.mockResolvedValue(…)` after the mock was made — which
// used to put the whole `undefined.catch` class of bug back inside those
// files from their second test onward. The defaults are therefore passed to
// `vi.fn` as its argument, which vitest keeps as the original implementation.
//
// The order matters: the assertions below only mean anything in the test that
// runs AFTER the first `afterEach`.
// ---------------------------------------------------------------------------
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the api mock under restoreAllMocks', () => {
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
    // The `mockResolvedValue([])` above is gone — restoring rolls back to the
    // default, not past it.
    expect(api.listSessions()).toBeInstanceOf(Promise)
    await expect(api.listSessions()).resolves.toBeUndefined()
  })
})
