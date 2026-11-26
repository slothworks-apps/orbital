import { describe, expect, it, vi } from 'vitest'
import type { TunnelEvent } from '@orbital/shared/remote/tunnel'
import { sessionForWake, wakeTagOf } from '../mobile/wakeOpen'

const TAG = 'ab'.repeat(16)

function fakeClient(opts: { ready: boolean; answer?: { status: number; body: unknown } | Error }) {
  const listeners = new Set<(event: TunnelEvent) => void>()
  const request = vi.fn(async () => {
    if (opts.answer instanceof Error) throw opts.answer
    return opts.answer ?? { status: 404, body: null }
  })
  return {
    client: {
      get ready() { return opts.ready },
      on: (listener: (event: TunnelEvent) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      request,
    },
    request,
    up: () => {
      opts.ready = true
      for (const l of [...listeners]) l({ type: 'ready', ready: true })
    },
    listening: () => listeners.size,
  }
}

describe('wakeTagOf', () => {
  it('takes a 16-byte hex token and nothing else', () => {
    expect(wakeTagOf({ tag: TAG })).toBe(TAG)
    expect(wakeTagOf({ tag: TAG.toUpperCase() })).toBeNull()
    expect(wakeTagOf({ tag: 'ab' })).toBeNull()
    expect(wakeTagOf({ tag: `${TAG}/../x` })).toBeNull()
    expect(wakeTagOf({})).toBeNull()
    expect(wakeTagOf(undefined)).toBeNull()
  })
})

describe('sessionForWake', () => {
  it('asks once the tunnel is up and answers the session', async () => {
    const f = fakeClient({ ready: false, answer: { status: 200, body: { sessionId: 's1' } } })
    const found = sessionForWake(f.client, TAG, () => true, 1000)
    expect(f.request).not.toHaveBeenCalled()
    f.up()
    await expect(found).resolves.toBe('s1')
    expect(f.request).toHaveBeenCalledWith('GET', `/api/wake/${TAG}`)
    expect(f.listening()).toBe(0)
  })

  it('gives up when the tunnel does not come up in time', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeClient({ ready: false })
      const found = sessionForWake(f.client, TAG, () => true, 1000)
      vi.advanceTimersByTime(1000)
      await expect(found).resolves.toBeNull()
      expect(f.listening()).toBe(0)
      expect(f.request).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not ask a Mac too old for the route', async () => {
    const f = fakeClient({ ready: true, answer: { status: 200, body: { sessionId: 's1' } } })
    await expect(sessionForWake(f.client, TAG, () => false, 1000)).resolves.toBeNull()
    expect(f.request).not.toHaveBeenCalled()
  })

  it('reads a miss, a refusal or a failed request as no session', async () => {
    for (const answer of [{ status: 404, body: { error: 'not_found' } }, { status: 403, body: null }, { status: 200, body: {} }, new Error('offline')]) {
      const f = fakeClient({ ready: true, answer })
      await expect(sessionForWake(f.client, TAG, () => true, 1000)).resolves.toBeNull()
    }
  })
})
