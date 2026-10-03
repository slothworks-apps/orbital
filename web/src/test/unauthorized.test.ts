import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fresh modules per test: the flag is one-way module state.
async function load() {
  const api = await import('../lib/api')
  const flag = await import('../lib/unauthorized')
  return { ...api, ...flag }
}

const refused = () => Promise.resolve(new Response('{"error":"unauthorized"}', { status: 401 }))

describe('a 401 from the API', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks the page unauthorized on the port’s own transport', async () => {
    vi.stubGlobal('fetch', vi.fn(refused))
    const { api, ApiError, isUnauthorized } = await load()
    await expect(api.listTags()).rejects.toBeInstanceOf(ApiError)
    expect(isUnauthorized()).toBe(true)
  })

  it('leaves the phone’s tunnel alone', async () => {
    const { api, configureApi, isUnauthorized } = await load()
    configureApi({ fetch: vi.fn(refused) })
    await expect(api.listTags()).rejects.toThrow()
    expect(isUnauthorized()).toBe(false)
  })

  it('is not set by any other refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('no', { status: 403 }))))
    const { api, isUnauthorized } = await load()
    await expect(api.listTags()).rejects.toThrow()
    expect(isUnauthorized()).toBe(false)
  })
})
