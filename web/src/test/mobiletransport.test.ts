import { describe, expect, it, vi } from 'vitest'
import { TunnelError, type RemoteClientEvent } from '@orbital/shared/remote/client'
import { OrbitalSocket } from '../lib/ws'
import { ClientRef } from '../mobile/transport/clientRef'
import { makeImageResolver, mediaTypeOf } from '../mobile/transport/imageResolver'
import { makeTunnelFetch } from '../mobile/transport/tunnelFetch'
import { TunnelSocket } from '../mobile/transport/tunnelSocket'
import { FakeClient } from './fakeRemoteClient'

const ORIGIN = 'https://localhost'

describe('tunnelFetch', () => {
  it('sends a relative /api path and its query as the Mac routes them', async () => {
    const client = new FakeClient()
    client.request.mockResolvedValueOnce({ status: 200, body: { sessions: [] } })
    const res = await makeTunnelFetch(client, ORIGIN)('/api/sessions?limit=30')
    expect(client.request).toHaveBeenCalledWith('GET', '/api/sessions?limit=30', undefined)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ sessions: [] })
  })

  it("strips this page's origin, upper-cases the method and parses a JSON body", async () => {
    const client = new FakeClient()
    await makeTunnelFetch(client, ORIGIN)(`${ORIGIN}/api/sessions/s1/pinned`, {
      method: 'put', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }),
    })
    expect(client.request).toHaveBeenCalledWith('PUT', '/api/sessions/s1/pinned', { pinned: true })
  })

  it('hands a 413 and a 403 back as ordinary statuses with their bodies', async () => {
    const client = new FakeClient()
    client.request.mockResolvedValueOnce({ status: 413, body: { error: 'too_large' } })
    client.request.mockResolvedValueOnce({ status: 403, body: { error: 'not_allowed' } })
    const f = makeTunnelFetch(client, ORIGIN)
    const big = await f('/api/sessions/s1/messages?limit=30')
    expect(big.ok).toBe(false)
    expect(big.status).toBe(413)
    await expect(big.text()).resolves.toBe('{"error":"too_large"}')
    expect((await f('/api/settings')).status).toBe(403)
  })

  it('answers a 204 with no body', async () => {
    const client = new FakeClient()
    client.request.mockResolvedValueOnce({ status: 204, body: '' })
    const res = await makeTunnelFetch(client, ORIGIN)('/api/sessions/s1/tasks/t1/stop', { method: 'POST' })
    expect(res.status).toBe(204)
    await expect(res.text()).resolves.toBe('')
  })

  it('fails as fetch does on a network error when the tunnel is down', async () => {
    const client = new FakeClient()
    client.request.mockRejectedValueOnce(new TunnelError('offline'))
    await expect(makeTunnelFetch(client, ORIGIN)('/api/sessions')).rejects.toBeInstanceOf(TypeError)
  })

  it('refuses what it cannot carry: another origin, a path outside /api, a multipart body', async () => {
    const client = new FakeClient()
    const f = makeTunnelFetch(client, ORIGIN)
    await expect(f('https://elsewhere.test/api/sessions')).rejects.toBeInstanceOf(TypeError)
    await expect(f('/health')).rejects.toBeInstanceOf(TypeError)
    await expect(f('/api/attachments', { method: 'POST', body: new FormData() })).rejects.toBeInstanceOf(TypeError)
    expect(client.request).not.toHaveBeenCalled()
  })
})

describe('TunnelSocket', () => {
  it('opens only once the tunnel is ready, and closes when it goes', async () => {
    const client = new FakeClient()
    const socket = new TunnelSocket(client)
    const onopen = vi.fn()
    const onclose = vi.fn()
    socket.onopen = onopen
    socket.onclose = onclose
    await Promise.resolve()
    expect(socket.readyState).toBe(TunnelSocket.CONNECTING)
    client.emit({ type: 'ready', ready: true })
    expect(socket.readyState).toBe(TunnelSocket.OPEN)
    expect(onopen).toHaveBeenCalledOnce()
    client.emit({ type: 'ready', ready: false })
    expect(socket.readyState).toBe(TunnelSocket.CLOSED)
    expect(onclose).toHaveBeenCalledOnce()
    client.emit({ type: 'ready', ready: true })
    expect(onopen).toHaveBeenCalledOnce()
  })

  it('opens on the next microtask when the tunnel is already up', async () => {
    const client = new FakeClient()
    client.ready = true
    const socket = new TunnelSocket(client)
    const onopen = vi.fn()
    socket.onopen = onopen
    await Promise.resolve()
    expect(onopen).toHaveBeenCalledOnce()
  })

  it('turns subscribe frames into client calls and hub events into messages', () => {
    const client = new FakeClient()
    const socket = new TunnelSocket(client)
    const onmessage = vi.fn()
    socket.onmessage = onmessage
    client.emit({ type: 'ready', ready: true })
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'session:s1' }))
    socket.send(JSON.stringify({ type: 'unsubscribe', topic: 'session:s1' }))
    expect(client.subscribe).toHaveBeenCalledWith('session:s1')
    expect(client.unsubscribe).toHaveBeenCalledWith('session:s1')
    client.emit({ type: 'hub', frame: { topic: 'sessions', event: 'upsert' } })
    expect(JSON.parse((onmessage.mock.calls[0][0] as MessageEvent).data as string)).toEqual({ topic: 'sessions', event: 'upsert' })
  })

  it("carries OrbitalSocket's subscriptions and frames", async () => {
    const client = new FakeClient()
    client.ready = true
    const socket = new OrbitalSocket('/ws', { WebSocketImpl: () => new TunnelSocket(client) as unknown as WebSocket })
    const handler = vi.fn()
    socket.subscribe('sessions', handler)
    await vi.waitFor(() => expect(socket.status).toBe('open'))
    expect(client.subscribe).toHaveBeenCalledWith('sessions')
    client.emit({ type: 'hub', frame: { topic: 'sessions', event: 'upsert' } })
    expect(handler).toHaveBeenCalledWith({ topic: 'sessions', event: 'upsert' })
    socket.close()
  })
})

describe('makeImageResolver', () => {
  const REF = `${'c'.repeat(64)}.png`
  const toUrl = (bytes: Uint8Array, type: string) => `blob:${type}:${bytes.length}`

  it('serves a cached image without asking the Mac, then synchronously', async () => {
    const client = new FakeClient()
    const io = { read: vi.fn(async () => new Uint8Array([1])), write: vi.fn(async () => {}) }
    const resolve = makeImageResolver(client, io, toUrl)
    await expect(resolve(REF)).resolves.toBe('blob:image/png:1')
    expect(client.getBlob).not.toHaveBeenCalled()
    expect(resolve(REF)).toBe('blob:image/png:1')
  })

  it('fetches a missing image once over the tunnel, however often it is asked, and caches it', async () => {
    const client = new FakeClient()
    client.getBlob.mockResolvedValue({ status: 200, bytes: new Uint8Array([1, 2]), mediaType: 'image/png' })
    const io = { read: vi.fn(async () => null), write: vi.fn(async () => {}) }
    const resolve = makeImageResolver(client, io, toUrl)
    const [a, b] = await Promise.all([resolve(REF), resolve(REF)])
    expect(a).toBe('blob:image/png:2')
    expect(b).toBe(a)
    expect(client.getBlob).toHaveBeenCalledTimes(1)
    expect(io.write).toHaveBeenCalledWith(REF, new Uint8Array([1, 2]))
  })

  it('rejects when the Mac has no such image, and asks again next time', async () => {
    const client = new FakeClient()
    const io = { read: vi.fn(async () => null), write: vi.fn(async () => {}) }
    const resolve = makeImageResolver(client, io, toUrl)
    await expect(resolve(REF)).rejects.toThrow('404')
    await expect(resolve(REF)).rejects.toThrow('404')
    expect(client.getBlob).toHaveBeenCalledTimes(2)
  })

  it('names the media type from the ref', () => {
    expect(mediaTypeOf(`${'d'.repeat(64)}.jpg`)).toBe('image/jpeg')
    expect(mediaTypeOf('x.bin')).toBe('application/octet-stream')
  })
})

describe('ClientRef', () => {
  it("forwards the current client's events, and a ready client replaced reads as the tunnel going", () => {
    const ref = new ClientRef()
    const events: RemoteClientEvent[] = []
    ref.on((e) => events.push(e))
    const first = new FakeClient()
    first.ready = true
    ref.set(first)
    expect(ref.ready).toBe(true)
    first.emit({ type: 'hub', frame: 1 })
    expect(events).toContainEqual({ type: 'hub', frame: 1 })
    ref.set(new FakeClient())
    expect(first.stop).toHaveBeenCalledOnce()
    expect(events).toContainEqual({ type: 'ready', ready: false })
    first.emit({ type: 'hub', frame: 2 })
    expect(events).not.toContainEqual({ type: 'hub', frame: 2 })
  })

  it('answers offline with no client behind it', async () => {
    const ref = new ClientRef()
    await expect(ref.request('GET', '/api/sessions')).rejects.toMatchObject({ reason: 'offline' })
    await expect(ref.recheck(10)).resolves.toBe(false)
  })
})
