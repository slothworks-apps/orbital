import { describe, expect, it, vi } from 'vitest'
import { TunnelError, type RemoteClientEvent, type TunnelResponse } from '@orbital/shared/remote/client'
import type { GroupClientEvent, PeerInfo } from '@orbital/shared/remote/groupClient'
import type { HelloMessage } from '@orbital/shared/remote/messages'
import { GroupFederation, sessionOfRequest, type FederatedGroup } from '../mobile/transport/groupFederation'

type Answer = (method: string, path: string, body?: unknown) => TunnelResponse | undefined

const STUDIO = 'S'.repeat(43)
const LAPTOP = 'L'.repeat(43)
const BOX = 'H'.repeat(43)

function hello(name: string, capabilities = ['sessions', 'map', 'presence', 'group'], kind = 'desktop'): HelloMessage {
  return { t: 'hello', protocol: 1, app: 'orbital', server: '0.9.0', macName: name, name, kind, os: 'macos', capabilities }
}

/** A member's channel: answers from `answer` (tags and lists from the member's own data), records what it is asked. */
function fakeChannel(h: HelloMessage, data: { tags: { id: number; name: string; hue?: number }[]; sessions: unknown[] }, answer: Answer = () => undefined) {
  const topics = new Set<string>()
  let nextTag = 90
  const channel = {
    ready: true,
    serves: true,
    peer: h as HelloMessage | null,
    topics,
    request: vi.fn(async (method: string, path: string, body?: unknown): Promise<TunnelResponse> => {
      const own = answer(method, path, body)
      if (own) return own
      if (method === 'GET' && path === '/api/tags') return { status: 200, body: { tags: data.tags } }
      if (method === 'GET' && path.startsWith('/api/sessions?')) return { status: 200, body: { sessions: data.sessions } }
      if (method === 'POST' && path === '/api/tags') {
        const made = { id: nextTag++, name: (body as { name: string }).name }
        data.tags.push(made)
        return { status: 200, body: { id: made.id } }
      }
      return { status: 200, body: { from: h.name, path } }
    }),
    getBlob: vi.fn(async (_ref: string) => ({ status: 404, bytes: new Uint8Array(0), mediaType: null as string | null })),
    getFile: vi.fn(),
    putBlob: vi.fn(async () => ({ kind: 'ok' as const, entry: { ref: 'r.png', w: 1, h: 1, bytes: 1 } })),
    getNotifications: vi.fn(),
    setNotifications: vi.fn(async (s: unknown) => s),
    seen: vi.fn(),
    subscribe: vi.fn((t: string) => {
      topics.add(t)
    }),
    unsubscribe: vi.fn((t: string) => {
      topics.delete(t)
    }),
  }
  return channel
}
type FakeChannel = ReturnType<typeof fakeChannel>

/** The group's surface: peers and their channels as a test sets them, events as a test emits them. */
class FakeGroup implements FederatedGroup {
  readonly infos: PeerInfo[] = []
  readonly channels = new Map<string, FakeChannel>()
  private readonly listeners = new Set<(event: GroupClientEvent) => void>()
  readonly stop = vi.fn()
  readonly recheck = vi.fn(async () => {})
  readonly pushToken = vi.fn()

  add(id: string, name: string, channel: FakeChannel | null, kind: string | null = 'desktop'): void {
    this.infos.push({ id, name, kind, os: 'macos', online: channel !== null, ready: channel?.ready ?? false, hello: channel?.peer ?? null })
    if (channel) this.channels.set(id, channel)
  }

  on(listener: (event: GroupClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  peers(): PeerInfo[] {
    return this.infos.map((p) => ({ ...p, ready: this.channels.get(p.id)?.ready === true }))
  }

  channel(id: string): never {
    return (this.channels.get(id) ?? null) as never
  }

  emit(event: GroupClientEvent): void {
    for (const l of [...this.listeners]) l(event)
  }

  /** A channel's tunnel went: the group says so with `peer`. */
  down(id: string): void {
    this.channels.get(id)!.ready = false
    this.emit({ type: 'peer', peer: id })
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function session(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, status: 'idle', tagIds: [], ...extra }
}

type Listed = { id: string; tagIds: number[]; machine?: { id: string; name: string; online: boolean; asOf: number | null } }

async function setup() {
  const group = new FakeGroup()
  const studio = fakeChannel(hello('studio'), {
    tags: [{ id: 7, name: 'orbital', hue: 200 }],
    // `l1` is the laptop's, passed on by the studio: never taken second-hand.
    sessions: [session('s1', { tagIds: [7] }), session('l1', { machine: { id: LAPTOP, name: 'laptop' } })],
  })
  const laptop = fakeChannel(hello('laptop'), {
    tags: [{ id: 1, name: 'orbital', hue: 200 }, { id: 2, name: 'work', hue: 40 }],
    sessions: [session('l1', { tagIds: [1, 2] })],
  })
  group.add(STUDIO, 'studio', studio)
  group.add(LAPTOP, 'laptop', laptop)
  let now = 1000
  const fed = new GroupFederation(group, { now: () => now })
  const events: RemoteClientEvent[] = []
  fed.on((e) => events.push(e))
  await settle()
  const frames = () => events.flatMap((e) => (e.type === 'hub' ? [e.frame as Record<string, unknown>] : []))
  return { group, studio, laptop, fed, events, frames, setNow: (n: number) => (now = n) }
}

async function list(fed: GroupFederation, query = 'limit=50') {
  const res = await fed.request('GET', `/api/sessions?${query}`)
  return (res.body as { sessions: Listed[] }).sessions
}

async function localTags(fed: GroupFederation) {
  const res = await fed.request('GET', '/api/tags')
  return new Map((res.body as { tags: { id: number; name: string }[] }).tags.map((t) => [t.name, t.id]))
}

describe('GroupFederation', () => {
  it('lists every member once, each session with its machine and the phone\'s tag ids', async () => {
    const { fed } = await setup()
    const tags = await localTags(fed)
    expect([...tags.keys()].sort()).toEqual(['orbital', 'work'])
    const sessions = await list(fed)
    expect(sessions.map((s) => s.id).sort()).toEqual(['l1', 's1'])
    const s1 = sessions.find((s) => s.id === 's1')!
    const l1 = sessions.find((s) => s.id === 'l1')!
    expect(s1.machine).toMatchObject({ id: STUDIO, name: 'studio', online: true, asOf: null })
    expect(l1.machine).toMatchObject({ id: LAPTOP, name: 'laptop' })
    // The studio's 7 and the laptop's 1 are one `orbital` on the phone.
    expect(s1.tagIds).toEqual([tags.get('orbital')])
    expect(l1.tagIds.sort()).toEqual([tags.get('orbital'), tags.get('work')].sort())
    expect(fed.ownerOf('l1')).toBe(LAPTOP)
  })

  it('asks each member for the phone\'s tag filter in its own ids', async () => {
    const { fed, studio, laptop } = await setup()
    const tags = await localTags(fed)
    studio.request.mockClear()
    await list(fed, `tag=${tags.get('work')}`)
    // The studio has no `work`: not asked at all.
    expect(studio.request.mock.calls.map(([, path]) => path)).not.toContainEqual(expect.stringContaining('/api/sessions'))
    expect(laptop.request.mock.calls.map(([, path]) => path)).toContain('/api/sessions?tag=2')
  })

  it('drops a session another member passes on as a third device\'s', async () => {
    const { studio, group, frames } = await setup()
    group.emit({ type: 'hub', peer: STUDIO, frame: { topic: 'sessions', event: 'upsert', session: session('x', { machine: { id: BOX } }) } })
    group.emit({ type: 'hub', peer: STUDIO, frame: { topic: 'sessions', event: 'upsert', session: session('s2') } })
    const upserts = frames().filter((f) => f.event === 'upsert').map((f) => (f.session as Listed).id)
    expect(upserts).not.toContain('x')
    expect(upserts).toContain('s2')
    expect(studio.ready).toBe(true)
  })

  it('routes a request by its path, ?session=, ?sessionId=, machine, else the default member', async () => {
    const { fed, studio, laptop } = await setup()
    await fed.request('POST', '/api/sessions/l1/messages', { text: 'hi' })
    expect(laptop.request).toHaveBeenLastCalledWith('POST', '/api/sessions/l1/messages', { text: 'hi' })
    await fed.request('GET', '/api/stats/sessions/s1/usage')
    expect(studio.request).toHaveBeenLastCalledWith('GET', '/api/stats/sessions/s1/usage', undefined)
    await fed.request('GET', '/api/files?session=l1&path=a')
    expect(laptop.request).toHaveBeenLastCalledWith('GET', '/api/files?session=l1&path=a', undefined)
    await fed.request('GET', '/api/harness/templates?sessionId=s1')
    expect(studio.request).toHaveBeenLastCalledWith('GET', '/api/harness/templates?sessionId=s1', undefined)
    await fed.request('GET', `/api/projects?machine=${LAPTOP}`)
    expect(laptop.request).toHaveBeenLastCalledWith('GET', '/api/projects', undefined)
    await fed.request('POST', '/api/dirs', { path: '/p', machine: LAPTOP })
    expect(laptop.request).toHaveBeenLastCalledWith('POST', '/api/dirs', { path: '/p' })
    // `count` is a literal sibling, not a session: the default member, the first that is up.
    await fed.request('GET', '/api/sessions/count')
    expect(studio.request).toHaveBeenLastCalledWith('GET', '/api/sessions/count', undefined)
    await expect(fed.request('GET', '/api/projects?machine=nobody')).resolves.toMatchObject({ status: 404 })
  })

  it('makes the member the last session started on the default, and its minted id its own', async () => {
    const { fed, laptop } = await setup()
    await fed.request('POST', '/api/sessions', { cwd: '/p', prompt: 'go', sessionId: 'n1', machine: LAPTOP })
    expect(laptop.request).toHaveBeenLastCalledWith('POST', '/api/sessions', { cwd: '/p', prompt: 'go', sessionId: 'n1' })
    expect(fed.ownerOf('n1')).toBe(LAPTOP)
    await fed.request('GET', '/api/sessions/defaults')
    expect(laptop.request).toHaveBeenLastCalledWith('GET', '/api/sessions/defaults', undefined)
  })

  it('keeps a member\'s sessions, offline, when its channel goes', async () => {
    const { fed, group, frames, events, setNow } = await setup()
    setNow(5000)
    group.down(LAPTOP)
    const offline = frames().filter((f) => f.event === 'upsert' && (f.session as Listed).id === 'l1').at(-1)!
    expect((offline.session as Listed).machine).toMatchObject({ online: false, asOf: 5000 })
    // The studio still answers: the phone stays ready, and lists the laptop's as it last knew them.
    expect(events.some((e) => e.type === 'ready' && !e.ready)).toBe(false)
    const sessions = await list(fed)
    expect(sessions.find((s) => s.id === 'l1')?.machine).toMatchObject({ online: false, asOf: 5000 })
    expect(fed.sources().find((s) => s.id === LAPTOP)).toMatchObject({ ready: false, asOf: 5000 })
    await expect(fed.request('GET', '/api/sessions/l1')).rejects.toEqual(new TunnelError('offline'))
  })

  it('makes a tag the owner lacks there, for a spawn\'s tagId and a tags PUT', async () => {
    const { fed, studio } = await setup()
    const tags = await localTags(fed)
    await fed.request('POST', '/api/sessions', { cwd: '/p', prompt: 'go', tagId: tags.get('work'), machine: STUDIO })
    expect(studio.request).toHaveBeenCalledWith('POST', '/api/tags', { name: 'work', hue: 40 })
    expect(studio.request).toHaveBeenLastCalledWith('POST', '/api/sessions', { cwd: '/p', prompt: 'go', tagId: 90 })
    await fed.request('PUT', '/api/sessions/s1/tags', { tagIds: [tags.get('orbital'), tags.get('work')] })
    expect(studio.request).toHaveBeenLastCalledWith('PUT', '/api/sessions/s1/tags', { tagIds: [7, 90] })
    // Made once, not again.
    expect(studio.request.mock.calls.filter(([m, p]) => m === 'POST' && p === '/api/tags')).toHaveLength(1)
  })

  it('subscribes sessions everywhere and a session\'s topics on its owner, once it is known', async () => {
    const { fed, group, studio, laptop } = await setup()
    fed.subscribe('sessions')
    fed.subscribe('session:l1')
    fed.subscribe('session:n2')
    expect(studio.topics.has('sessions') && laptop.topics.has('sessions')).toBe(true)
    expect(laptop.topics.has('session:l1')).toBe(true)
    expect(studio.topics.has('session:l1')).toBe(false)
    expect(studio.topics.has('session:n2') || laptop.topics.has('session:n2')).toBe(false)
    group.emit({ type: 'hub', peer: STUDIO, frame: { topic: 'sessions', event: 'upsert', session: session('n2') } })
    expect(studio.topics.has('session:n2')).toBe(true)
    // Undone on the owner alone.
    const before = studio.topics.size
    fed.unsubscribe('session:l1')
    expect(laptop.topics.has('session:l1')).toBe(false)
    expect(studio.topics.size).toBe(before)
  })

  it('re-subscribes a member\'s new channel', async () => {
    const { fed, group, laptop } = await setup()
    fed.subscribe('sessions')
    fed.subscribe('session:l1')
    const fresh = fakeChannel(hello('laptop'), { tags: [], sessions: [] })
    fresh.ready = false
    group.channels.set(LAPTOP, fresh)
    group.emit({ type: 'channel', peer: LAPTOP, channel: fresh as never })
    expect([...fresh.topics].sort()).toEqual(['presence', 'session:l1', 'sessions'])
    expect(laptop.topics.has('sessions')).toBe(true)
  })

  it('says the user is at a member while they are at any member that is up', async () => {
    const group = new FakeGroup()
    const studio = fakeChannel(hello('studio'), { tags: [], sessions: [] })
    const laptop = fakeChannel(hello('laptop'), { tags: [], sessions: [] })
    const box = fakeChannel(hello('box', ['sessions', 'group'], 'headless'), { tags: [], sessions: [] })
    group.add(STUDIO, 'studio', studio)
    group.add(LAPTOP, 'laptop', laptop)
    group.add(BOX, 'box', box, 'headless')
    const fed = new GroupFederation(group)
    const presence: unknown[] = []
    fed.on((e) => {
      if (e.type === 'hub') presence.push((e.frame as { atMac?: unknown }).atMac)
    })
    expect(studio.topics.has('presence') && laptop.topics.has('presence')).toBe(true)
    expect(box.topics.has('presence')).toBe(false)
    const at = (peer: string, atMac: boolean) => group.emit({ type: 'hub', peer, frame: { topic: 'presence', event: 'state', atMac } })
    at(STUDIO, true)
    at(LAPTOP, true)
    at(STUDIO, false)
    expect(presence).toEqual([true])
    at(LAPTOP, false)
    expect(presence).toEqual([true, false])
    at(LAPTOP, true)
    group.down(LAPTOP)
    expect(presence).toEqual([true, false, true, false])
  })

  it('puts an image on the member of the session it is for, else the default member', async () => {
    const { fed, studio, laptop } = await setup()
    await fed.putBlob(new Uint8Array([1]), 'image/png', 'l1')
    expect(laptop.putBlob).toHaveBeenCalledTimes(1)
    expect(studio.putBlob).not.toHaveBeenCalled()
    await fed.putBlob(new Uint8Array([1]), 'image/png')
    expect(studio.putBlob).toHaveBeenCalledTimes(1)
  })

  it('carries an image put on one member to the member a turn goes to', async () => {
    const { fed, studio, laptop } = await setup()
    await fed.putBlob(new Uint8Array([1]), 'image/png')
    studio.getBlob.mockResolvedValueOnce({ status: 200, bytes: new Uint8Array([1]), mediaType: 'image/png' })
    await fed.request('POST', '/api/sessions/l1/messages', { text: 'look', attachments: ['r.png'] })
    expect(laptop.putBlob).toHaveBeenCalledWith(new Uint8Array([1]), 'image/png')
  })

  it('reads an image from whichever member has it', async () => {
    const { fed, laptop } = await setup()
    laptop.getBlob.mockResolvedValueOnce({ status: 200, bytes: new Uint8Array([9]), mediaType: 'image/png' })
    await expect(fed.getBlob('x.png')).resolves.toMatchObject({ status: 200, bytes: new Uint8Array([9]) })
  })

  it('answers offline with no member up, and reads as not ready', async () => {
    const group = new FakeGroup()
    group.add(STUDIO, 'studio', null)
    const fed = new GroupFederation(group)
    expect(fed.ready).toBe(false)
    await expect(fed.request('GET', '/api/sessions?limit=50')).rejects.toEqual(new TunnelError('offline'))
    await expect(fed.request('POST', '/api/sessions', { cwd: '/p' })).rejects.toEqual(new TunnelError('offline'))
    await expect(fed.putBlob(new Uint8Array([1]), 'image/png')).rejects.toEqual(new TunnelError('offline'))
    expect(fed.sources()).toEqual([expect.objectContaining({ id: STUDIO, ready: false, online: false })])
  })

  it('tells the app of every pair gone, not of one member\'s revoke, and of members changing', async () => {
    const { fed, group, events } = await setup()
    const members = vi.fn()
    fed.onMembers(members)
    group.emit({ type: 'bye', peer: LAPTOP, reason: 'revoked' })
    expect(events.some((e) => e.type === 'bye')).toBe(false)
    group.down(LAPTOP)
    expect(members).toHaveBeenCalledTimes(1)
    group.emit({ type: 'unpaired_all' })
    expect(events.at(-1)).toEqual({ type: 'unpaired' })
  })

  it('takes a member that is no longer paired out of the list', async () => {
    const { group, frames } = await setup()
    group.infos.splice(group.infos.findIndex((p) => p.id === LAPTOP), 1)
    group.channels.delete(LAPTOP)
    group.emit({ type: 'group' })
    expect(frames().at(-1)).toEqual({ topic: 'sessions', event: 'remove', sessionId: 'l1' })
  })
})

describe('sessionOfRequest', () => {
  const of = (path: string) => sessionOfRequest(new URL(path, 'http://phone'))
  it('reads the session of a path, never of a literal sibling', () => {
    expect(of('/api/sessions/abc/messages')).toBe('abc')
    expect(of('/api/stats/sessions/abc')).toBe('abc')
    expect(of('/api/sessions/count')).toBeNull()
    expect(of('/api/sessions/defaults')).toBeNull()
    expect(of('/api/files?session=s')).toBe('s')
    expect(of('/api/harness?sessionId=t')).toBe('t')
    expect(of('/api/sessions/%E0%A4%A')).toBeNull()
  })
})
