import { describe, expect, it, vi } from 'vitest'
import { TunnelError, type RemoteClientEvent } from '@orbital/shared/remote/client'
import { ATTACHMENT_MAX_BYTES } from '../lib/attachments'
import { OrbitalSocket } from '../lib/ws'
import { ClientRef } from '../mobile/transport/clientRef'
import { makeImageResolver, mediaTypeOf } from '../mobile/transport/imageResolver'
import { makeTunnelFetch } from '../mobile/transport/tunnelFetch'
import { makeTunnelUpload } from '../mobile/transport/tunnelUpload'
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

  it('treats an empty string body as no body', async () => {
    const client = new FakeClient()
    client.request.mockResolvedValueOnce({ status: 200, body: {} })
    await makeTunnelFetch(client, ORIGIN)('/api/sessions', { method: 'POST', body: '' })
    expect(client.request).toHaveBeenCalledWith('POST', '/api/sessions', undefined)
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

  it('lets go of what it held when the tunnel drops, so the next socket resubscribes only what is still wanted', () => {
    const client = new FakeClient()
    const socket = new TunnelSocket(client)
    client.emit({ type: 'ready', ready: true })
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'sessions' }))
    client.emit({ type: 'ready', ready: false })
    expect(client.unsubscribe).toHaveBeenCalledWith('sessions')

    // The socket OrbitalSocket builds on the next reconnect attempt: it only
    // resends what it still has handlers for.
    client.unsubscribe.mockClear()
    client.subscribe.mockClear()
    const next = new TunnelSocket(client)
    client.emit({ type: 'ready', ready: true })
    next.send(JSON.stringify({ type: 'subscribe', topic: 'sessions' }))
    expect(client.subscribe).toHaveBeenCalledTimes(1)
    expect(client.subscribe).toHaveBeenCalledWith('sessions')
    expect(client.unsubscribe).not.toHaveBeenCalled()
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

  it('falls through to the tunnel when the cache read itself fails', async () => {
    const client = new FakeClient()
    client.getBlob.mockResolvedValue({ status: 200, bytes: new Uint8Array([1]), mediaType: 'image/png' })
    const io = { read: vi.fn(async () => { throw new Error('disk error') }), write: vi.fn(async () => {}) }
    const resolve = makeImageResolver(client, io, toUrl)
    await expect(resolve(REF)).resolves.toBe('blob:image/png:1')
    expect(client.getBlob).toHaveBeenCalledTimes(1)
  })

  describe('a bounded cache of URLs', () => {
    const ref = (c: string) => `${c.repeat(64)}.png`

    function setup() {
      let n = 0
      const client = new FakeClient()
      const io = { read: vi.fn(async () => new Uint8Array([1])), write: vi.fn(async () => {}) }
      const revoke = vi.fn()
      const counting = (bytes: Uint8Array, type: string) => `blob:${type}:${bytes.length}:${++n}`
      return { client, io, revoke, resolve: makeImageResolver(client, io, counting, revoke, 2) }
    }

    it('revokes the oldest URL once past the bound', async () => {
      const { resolve, revoke } = setup()
      const a = await resolve(ref('a'))
      await resolve(ref('b'))
      expect(revoke).not.toHaveBeenCalled()
      await resolve(ref('c'))
      expect(revoke).toHaveBeenCalledTimes(1)
      expect(revoke).toHaveBeenCalledWith(a)
    })

    it('keeps a URL that was asked for again and evicts the one left untouched', async () => {
      const { resolve, revoke } = setup()
      const a = await resolve(ref('a'))
      const b = await resolve(ref('b'))
      expect(resolve(ref('a'))).toBe(a)
      await resolve(ref('c'))
      expect(revoke).toHaveBeenCalledTimes(1)
      expect(revoke).toHaveBeenCalledWith(b)
    })

    it('reads an evicted image back from the file cache, not the tunnel', async () => {
      const { resolve, io, client } = setup()
      const a = await resolve(ref('a'))
      await resolve(ref('b'))
      await resolve(ref('c'))
      io.read.mockClear()
      const again = await resolve(ref('a'))
      expect(again).not.toBe(a)
      expect(io.read).toHaveBeenCalledWith(ref('a'))
      expect(client.getBlob).not.toHaveBeenCalled()
    })
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

  it('reads a client handed over already ready as the tunnel just coming up', () => {
    const ref = new ClientRef()
    const events: RemoteClientEvent[] = []
    ref.on((e) => events.push(e))
    const client = new FakeClient()
    client.ready = true
    ref.set(client)
    expect(ref.ready).toBe(true)
    expect(events).toContainEqual({ type: 'ready', ready: true })
  })
})

describe('makeTunnelUpload', () => {
  const ENTRY = { ref: `${'a'.repeat(64)}.jpg`, w: 1568, h: 1176, bytes: 3 }
  // jsdom's File has no `arrayBuffer`; the WebView's does, and that is what the uploader reads.
  const fileOf = (bytes: Uint8Array<ArrayBuffer>, name: string, type: string): File =>
    Object.assign(new File([bytes], name, { type }), { arrayBuffer: async () => bytes.slice().buffer })
  const photo = () => fileOf(new Uint8Array([1, 2, 3]), 'IMG_090507.jpg', 'image/jpeg')

  it("hands the file's bytes and media type to putBlob and answers ok with the entry", async () => {
    const client = new FakeClient()
    client.putBlob.mockResolvedValueOnce({ kind: 'ok', entry: ENTRY })
    await expect(makeTunnelUpload(client)('s1', photo())).resolves.toEqual({ kind: 'ok', entry: ENTRY })
    expect(client.putBlob).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'image/jpeg')
  })

  it("answers too_large with the file's size, which is exact", async () => {
    const client = new FakeClient()
    client.putBlob.mockResolvedValueOnce({ kind: 'too_large' })
    await expect(makeTunnelUpload(client)(null, photo())).resolves.toEqual({ kind: 'too_large', size: 3, truncated: false })
  })

  it("answers the Mac's not_image with the file's media type", async () => {
    const client = new FakeClient()
    client.putBlob.mockResolvedValueOnce({ kind: 'not_image' })
    const file = fileOf(new TextEncoder().encode('hello'), 'fake.png', 'image/png')
    await expect(makeTunnelUpload(client)('s1', file)).resolves.toEqual({ kind: 'not_image', mediaType: 'image/png' })
  })

  it('refuses a file that is not an image without reading it or touching the tunnel', async () => {
    const client = new FakeClient()
    const file = fileOf(new TextEncoder().encode('hello'), 'notes.txt', 'text/plain')
    const read = vi.spyOn(file, 'arrayBuffer')
    await expect(makeTunnelUpload(client)('s1', file)).resolves.toEqual({ kind: 'not_image', mediaType: 'text/plain' })
    expect(read).not.toHaveBeenCalled()
    expect(client.putBlob).not.toHaveBeenCalled()
  })

  it('refuses a file past ATTACHMENT_MAX_BYTES without reading it or touching the tunnel', async () => {
    const client = new FakeClient()
    const file = photo()
    Object.defineProperty(file, 'size', { value: ATTACHMENT_MAX_BYTES + 1 })
    const read = vi.spyOn(file, 'arrayBuffer')
    await expect(makeTunnelUpload(client)('s1', file)).resolves.toEqual({
      kind: 'too_large', size: ATTACHMENT_MAX_BYTES + 1, truncated: false,
    })
    expect(read).not.toHaveBeenCalled()
    expect(client.putBlob).not.toHaveBeenCalled()
  })

  it('answers empty for an empty file without touching the tunnel', async () => {
    const client = new FakeClient()
    const empty = fileOf(new Uint8Array(0), 'IMG_000000.jpg', 'image/jpeg')
    await expect(makeTunnelUpload(client)('s1', empty)).resolves.toEqual({ kind: 'empty' })
    expect(client.putBlob).not.toHaveBeenCalled()
  })

  it('rejects with the TunnelError as it came, so the chip offers retry', async () => {
    const client = new FakeClient()
    const lost = new TunnelError('lost')
    client.putBlob.mockRejectedValueOnce(lost)
    await expect(makeTunnelUpload(client)('s1', photo())).rejects.toBe(lost)
  })
})
