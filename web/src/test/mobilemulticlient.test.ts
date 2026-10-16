import { describe, expect, it, vi } from 'vitest'
import type { RemoteClientEvent, TunnelResponse } from '@orbital/shared/remote/client'
import type { SwappableClient } from '../mobile/transport/clientRef'
import { MultiClient } from '../mobile/transport/multiClient'

type Answer = (method: string, path: string, body?: unknown) => TunnelResponse

/** A Mac's client: answers from `answer`, and lets a test say what its Mac sent. */
function fakeMac(answer: Answer, ready = true) {
  const listeners = new Set<(event: RemoteClientEvent) => void>()
  const client = {
    ready,
    on: (l: (event: RemoteClientEvent) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    stop: vi.fn(),
    request: vi.fn(async (method: string, path: string, body?: unknown) => answer(method, path, body)),
    getBlob: vi.fn(),
    getFile: vi.fn(),
    putBlob: vi.fn(async () => ({ kind: 'ok' as const, entry: { ref: 'r', w: 1, h: 1, bytes: 1 } })),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    getNotifications: vi.fn(),
    setNotifications: vi.fn(async (s: unknown) => s),
    seen: vi.fn(),
    recheck: vi.fn(async () => true),
    pushToken: vi.fn(),
  }
  const emit = (event: RemoteClientEvent) => {
    for (const l of [...listeners]) l(event)
  }
  return { client: client as unknown as SwappableClient & typeof client, emit }
}

const STUDIO = 'S'.repeat(43)
const LAPTOP = 'L'.repeat(43)

function session(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, status: 'idle', tagIds: [], ...extra }
}

/** The main Mac (laptop) knows the studio as its peer; the phone is paired with the studio too. */
function setup() {
  const laptop = fakeMac((_method, path) => {
    if (path === '/api/tags') return { status: 200, body: { tags: [{ id: 1, name: 'orbital' }] } }
    if (path.startsWith('/api/sessions?')) {
      return {
        status: 200,
        body: { sessions: [session('l1'), session('s1', { machine: { id: STUDIO, name: 'studio', online: true } })] },
      }
    }
    return { status: 200, body: { from: 'laptop', path } }
  })
  const studio = fakeMac((_method, path) => {
    if (path === '/api/tags') return { status: 200, body: { tags: [{ id: 7, name: 'orbital' }] } }
    if (path.startsWith('/api/sessions?')) {
      return {
        status: 200,
        body: { sessions: [session('s1', { tagIds: [7] }), session('l1', { machine: { id: LAPTOP, name: 'laptop', online: true } })] },
      }
    }
    return { status: 200, body: { from: 'studio', path } }
  })
  const multi = new MultiClient(laptop.client)
  multi.add({ mac: STUDIO, name: 'studio', client: studio.client })
  return { multi, laptop, studio }
}

describe('MultiClient', () => {
  it('lists every Mac once: a session reached directly wins over the same one passed on', async () => {
    const { multi } = setup()
    await multi.request('GET', '/api/tags')
    const res = await multi.request('GET', '/api/sessions?limit=50')
    const sessions = (res.body as { sessions: { id: string; machine?: { name: string }; tagIds: number[] }[] }).sessions
    expect(sessions.map((s) => s.id).sort()).toEqual(['l1', 's1'])
    const s1 = sessions.find((s) => s.id === 's1')!
    expect(s1.machine?.name).toBe('studio')
    // The studio's tag 7 is the main Mac's tag 1 of the same name.
    expect(s1.tagIds).toEqual([1])
    expect(sessions.find((s) => s.id === 'l1')!.machine).toBeUndefined()
  })

  it('sends a session\'s requests, topics and files to the Mac that listed it', async () => {
    const { multi, laptop, studio } = setup()
    await multi.request('GET', '/api/sessions?limit=50')
    await multi.request('POST', '/api/sessions/s1/messages', { text: 'hi' })
    expect(studio.client.request).toHaveBeenCalledWith('POST', '/api/sessions/s1/messages', { text: 'hi' })
    await multi.request('GET', '/api/sessions/l1/messages')
    expect(laptop.client.request).toHaveBeenCalledWith('GET', '/api/sessions/l1/messages', undefined)
    multi.subscribe('session:s1')
    expect(studio.client.subscribe).toHaveBeenCalledWith('session:s1')
    expect(laptop.client.subscribe).not.toHaveBeenCalledWith('session:s1')
    multi.seen('s1')
    expect(studio.client.seen).toHaveBeenCalledWith('s1')
  })

  it('starts a session on the Mac the body names, without the name', async () => {
    const { multi, studio } = setup()
    await multi.request('POST', '/api/sessions', { cwd: '/p', machine: STUDIO })
    expect(studio.client.request).toHaveBeenCalledWith('POST', '/api/sessions', { cwd: '/p' })
    await multi.request('GET', `/api/projects?machine=${STUDIO}`)
    expect(studio.client.request).toHaveBeenCalledWith('GET', '/api/projects', undefined)
  })

  it('drops what another Mac passes on, and marks its own with its machine', () => {
    const { multi, studio } = setup()
    const frames: unknown[] = []
    multi.on((e) => {
      if (e.type === 'hub') frames.push(e.frame)
    })
    studio.emit({ type: 'hub', frame: { topic: 'sessions', event: 'upsert', session: session('l1', { machine: { id: LAPTOP } }) } })
    studio.emit({ type: 'hub', frame: { topic: 'sessions', event: 'upsert', session: session('s2') } })
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ session: { id: 's2', machine: { id: STUDIO, name: 'studio' } } })
  })

  it('reads as ready while any Mac is', () => {
    const laptop = fakeMac(() => ({ status: 200, body: {} }), false)
    const studio = fakeMac(() => ({ status: 200, body: { sessions: [] } }), true)
    const multi = new MultiClient(laptop.client)
    const ready: boolean[] = []
    multi.on((e) => {
      if (e.type === 'ready') ready.push(e.ready)
    })
    multi.add({ mac: STUDIO, name: 'studio', client: studio.client })
    expect(multi.ready).toBe(true)
    expect(ready).toEqual([true])
  })

  it('forgets a Mac that revoked this phone', () => {
    const onGone = vi.fn()
    const laptop = fakeMac(() => ({ status: 200, body: {} }))
    const studio = fakeMac(() => ({ status: 200, body: { sessions: [] } }))
    const multi = new MultiClient(laptop.client, onGone)
    multi.add({ mac: STUDIO, name: 'studio', client: studio.client })
    studio.emit({ type: 'unpaired' })
    expect(onGone).toHaveBeenCalledWith(STUDIO)
    expect(multi.macs()).toEqual([])
  })
})
