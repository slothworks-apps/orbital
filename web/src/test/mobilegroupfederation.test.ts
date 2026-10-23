import { describe, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { TunnelError, type RemoteClientEvent, type TunnelResponse } from '@orbital/shared/remote/client'
import type { GroupClientEvent, PeerInfo } from '@orbital/shared/remote/groupClient'
import type { HelloMessage } from '@orbital/shared/remote/messages'
import { GroupFederation, RELIST_RETRY_MS, type FederatedGroup } from '../mobile/transport/groupFederation'

type Answer = (method: string, path: string, body?: unknown) => TunnelResponse | Promise<TunnelResponse> | undefined

const STUDIO = 'S'.repeat(43)
/** A store ref naming exactly `bytes`. */
const refOf = (bytes: number[]) => `${bytesToHex(sha256(new Uint8Array(bytes)))}.png`
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
      const one = method === 'GET' ? /^\/api\/sessions\/([^/?]+)$/.exec(path) : null
      if (one) {
        const found = data.sessions.find((x) => (x as { id: string }).id === one[1])
        return found ? { status: 200, body: { session: found } } : { status: 404, body: { error: 'session_not_found' } }
      }
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
    // A member that reports nothing readable: the phone adopts no rules from it.
    getNotifications: vi.fn(async (): Promise<unknown> => undefined),
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
  /** Devices whose pair is ending: removed, and not yet acknowledged. */
  readonly ending = new Set<string>()

  exiting(id: string): boolean {
    return this.ending.has(id)
  }

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

async function setup(opts: { laptopAnswer?: Answer; laptopOld?: unknown[]; settle?: boolean } = {}) {
  const group = new FakeGroup()
  const studio = fakeChannel(hello('studio'), {
    tags: [{ id: 7, name: 'orbital', hue: 200 }],
    // `l1` is the laptop's, passed on by the studio: never taken second-hand.
    sessions: [session('s1', { tagIds: [7] }), session('l1', { machine: { id: LAPTOP, name: 'laptop' } })],
  })
  const laptop = fakeChannel(hello('laptop'), {
    tags: [{ id: 1, name: 'orbital', hue: 200 }, { id: 2, name: 'work', hue: 40 }],
    sessions: [session('l1', { tagIds: [1, 2] })],
  }, opts.laptopAnswer)
  group.add(STUDIO, 'studio', studio)
  group.add(LAPTOP, 'laptop', laptop)
  let now = 1000
  const fed = new GroupFederation(group, { now: () => now })
  const events: RemoteClientEvent[] = []
  fed.on((e) => events.push(e))
  if (opts.settle !== false) await settle()
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

  it('names the member a profile login event came from', async () => {
    const { fed, group, frames } = await setup()
    fed.subscribe('claude-dir-logins')
    group.emit({ type: 'hub', peer: STUDIO, frame: { topic: 'claude-dir-logins', event: 'login', login: { claudeDirId: 1 } } })
    expect(frames().filter((f) => f.topic === 'claude-dir-logins')).toEqual([
      { topic: 'claude-dir-logins', event: 'login', login: { claudeDirId: 1 }, machine: STUDIO },
    ])
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
    // `defaults` is a literal sibling, not a session: the default member, the first that is up.
    await fed.request('GET', '/api/sessions/defaults')
    expect(studio.request).toHaveBeenLastCalledWith('GET', '/api/sessions/defaults', undefined)
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
    // One frame for the member, not an upsert per session.
    expect(frames().filter((f) => f.event === 'upsert' && (f.session as Listed).id === 'l1')).toHaveLength(1)
    expect(frames().at(-1)).toEqual({ topic: 'sessions', event: 'machine', machine: expect.objectContaining({ id: LAPTOP, online: false, asOf: 5000 }) })
    // The studio still answers: the phone stays ready, and lists the laptop's as it last knew them.
    expect(events.some((e) => e.type === 'ready' && !e.ready)).toBe(false)
    const sessions = await list(fed)
    expect(sessions.find((s) => s.id === 'l1')?.machine).toMatchObject({ online: false, asOf: 5000 })
    expect(fed.sources().find((s) => s.id === LAPTOP)).toMatchObject({ ready: false, asOf: 5000 })
    await expect(fed.request('GET', '/api/sessions/l1')).rejects.toEqual(new TunnelError('offline'))
  })

  it('names a member that is up but whose list did not come back, and none once it answers', async () => {
    let failing = true
    const { fed } = await setup({
      laptopAnswer: (method, path) =>
        failing && method === 'GET' && path.startsWith('/api/sessions?') ? Promise.reject(new TunnelError('timeout')) : undefined,
    })
    const res = await fed.request('GET', '/api/sessions?limit=50')
    expect((res.body as { unanswered?: string[] }).unanswered).toEqual([LAPTOP])
    failing = false
    const again = await fed.request('GET', '/api/sessions?limit=50')
    expect((again.body as { unanswered?: string[] }).unanswered).toBeUndefined()
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

  it('asks a Mac from before groups to make no tag, which it would refuse: the tag is left out there', async () => {
    const { fed, studio } = await setup()
    studio.peer = hello('studio', ['sessions', 'map', 'presence'])
    const tags = await localTags(fed)
    await fed.request('POST', '/api/sessions', { cwd: '/p', prompt: 'go', tagId: tags.get('work'), machine: STUDIO })
    expect(studio.request.mock.calls.filter(([m, p]) => m === 'POST' && p === '/api/tags')).toHaveLength(0)
    expect(studio.request).toHaveBeenLastCalledWith('POST', '/api/sessions', { cwd: '/p', prompt: 'go' })
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
    await expect(fed.getBlob(refOf([9]))).resolves.toMatchObject({ status: 200, bytes: new Uint8Array([9]) })
  })

  it('a full image whose bytes are not the ref\'s does not end the search; a thumbnail is taken as answered', async () => {
    const { fed, studio, laptop } = await setup()
    const ref = refOf([9])
    studio.getBlob.mockResolvedValueOnce({ status: 200, bytes: new Uint8Array([6, 6]), mediaType: 'image/png' })
    laptop.getBlob.mockImplementationOnce(() => new Promise((r) => setTimeout(() => r({ status: 200, bytes: new Uint8Array([9]), mediaType: 'image/png' }), 5)))
    await expect(fed.getBlob(ref)).resolves.toMatchObject({ status: 200, bytes: new Uint8Array([9]) })
    // Nobody with the ref's bytes: not an answer.
    studio.getBlob.mockResolvedValueOnce({ status: 200, bytes: new Uint8Array([6, 6]), mediaType: 'image/png' })
    laptop.getBlob.mockResolvedValueOnce({ status: 200, bytes: new Uint8Array([7]), mediaType: 'image/png' })
    await expect(fed.getBlob(ref)).rejects.toBeInstanceOf(TunnelError)
    studio.getBlob.mockResolvedValueOnce({ status: 200, bytes: new Uint8Array([6, 6]), mediaType: 'image/png' })
    laptop.getBlob.mockImplementationOnce(() => new Promise(() => {}))
    await expect(fed.getBlob(ref, { edge: 1024 })).resolves.toMatchObject({ status: 200, bytes: new Uint8Array([6, 6]) })
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

  it('sends the phone\'s notification rules to a member that comes up later, and the stored ones to each', async () => {
    const { fed, group, studio, laptop } = await setup()
    const chosen = { needsInput: true, sessionEnded: false, sessionFailed: true, onlyWhenBackground: false, sound: false }
    group.down(LAPTOP)
    await fed.setNotifications(chosen)
    expect(studio.setNotifications).toHaveBeenCalledWith(chosen)
    expect(laptop.setNotifications).not.toHaveBeenCalled()
    laptop.ready = true
    group.emit({ type: 'peer', peer: LAPTOP })
    expect(laptop.setNotifications).toHaveBeenCalledWith(chosen)

    // A choice stored with the group reaches every member as it first comes up, and a new one is stored.
    const again = new FakeGroup()
    const box = fakeChannel(hello('box'), { tags: [], sessions: [] })
    again.add(BOX, 'box', box)
    const stored = vi.fn()
    const restored = new GroupFederation(again, { notifications: chosen, onNotifications: stored })
    expect(box.setNotifications).toHaveBeenCalledWith(chosen)
    await restored.setNotifications({ ...chosen, sound: true })
    expect(stored).toHaveBeenCalledWith({ ...chosen, sound: true })
  })

  it('a phone with no rules of its own adopts the first member\'s, once, and sends them to every other member', async () => {
    const rules = { needsInput: true, sessionEnded: true, sessionFailed: false, onlyWhenBackground: true, sound: true }
    const group = new FakeGroup()
    const studio = fakeChannel(hello('studio'), { tags: [], sessions: [] })
    const laptop = fakeChannel(hello('laptop'), { tags: [], sessions: [] })
    studio.getNotifications.mockResolvedValue(rules)
    laptop.getNotifications.mockResolvedValue({ ...rules, sound: false })
    group.add(STUDIO, 'studio', studio)
    group.add(LAPTOP, 'laptop', laptop)
    laptop.ready = false
    const stored = vi.fn()
    const fed = new GroupFederation(group, { onNotifications: stored })
    await settle()
    expect(stored).toHaveBeenCalledWith(rules)
    expect(studio.setNotifications).not.toHaveBeenCalled()
    // A member that links later gets the adopted rules, and is not asked for its own.
    laptop.ready = true
    group.emit({ type: 'peer', peer: LAPTOP })
    await settle()
    expect(laptop.setNotifications).toHaveBeenCalledWith(rules)
    expect(laptop.getNotifications).not.toHaveBeenCalled()
    expect(stored).toHaveBeenCalledTimes(1)
    expect(fed.ready).toBe(true)
  })

  it('a list that fails is logged, naming the member, and tried once more', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let fails = 2
      const { laptop, frames } = await setup({
        settle: false,
        laptopAnswer: (method, path) => {
          if (method === 'GET' && path.startsWith('/api/sessions?') && fails-- > 0) throw new TunnelError('timeout')
          return undefined
        },
      })
      await vi.advanceTimersByTimeAsync(0)
      const lists = () => laptop.request.mock.calls.filter(([m, p]) => m === 'GET' && String(p).startsWith('/api/sessions?')).length
      expect(lists()).toBe(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain(LAPTOP.slice(0, 8))
      await vi.advanceTimersByTimeAsync(RELIST_RETRY_MS)
      expect(lists()).toBe(2)
      // Once more only: the next is at the next time it comes up.
      await vi.advanceTimersByTimeAsync(RELIST_RETRY_MS * 10)
      expect(lists()).toBe(2)
      expect(frames().some((f) => f.event === 'upsert' && (f.session as Listed).id === 'l1')).toBe(false)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('marks what a member that comes back relists as replay', async () => {
    const { group, laptop, frames } = await setup()
    const upsertsOf = (id: string) => frames().filter((f) => f.event === 'upsert' && (f.session as Listed).id === id)
    group.down(LAPTOP)
    const before = upsertsOf('l1').length
    laptop.ready = true
    group.emit({ type: 'peer', peer: LAPTOP })
    await settle()
    expect(upsertsOf('l1').slice(before)).toEqual([expect.objectContaining({ replay: true })])
    // What it says live is news.
    group.emit({ type: 'hub', peer: LAPTOP, frame: { topic: 'sessions', event: 'upsert', session: session('l1', { status: 'working' }) } })
    expect(upsertsOf('l1').at(-1)?.replay).toBeUndefined()
  })

  it('keeps a session with the member that listed it first while that member is up', async () => {
    const { fed, group, frames } = await setup()
    const count = frames().length
    group.emit({ type: 'hub', peer: STUDIO, frame: { topic: 'sessions', event: 'upsert', session: session('l1') } })
    expect(frames()).toHaveLength(count)
    expect(fed.ownerOf('l1')).toBe(LAPTOP)
    // Once the laptop is down, another member may hold it.
    group.down(LAPTOP)
    group.emit({ type: 'hub', peer: STUDIO, frame: { topic: 'sessions', event: 'upsert', session: session('l1') } })
    expect(fed.ownerOf('l1')).toBe(STUDIO)
  })

  it('takes a member that is no longer paired out of the list', async () => {
    const { group, frames } = await setup()
    group.infos.splice(group.infos.findIndex((p) => p.id === LAPTOP), 1)
    group.channels.delete(LAPTOP)
    group.emit({ type: 'group' })
    expect(frames().at(-1)).toEqual({ topic: 'sessions', event: 'remove', sessionId: 'l1' })
  })
})

describe('GroupFederation, a session no member has listed yet', () => {
  /** The laptop holds `old` (past what a relist reads): it answers for it, the studio does not. */
  const old = (method: string, path: string) =>
    method === 'GET' && path === '/api/sessions/old' ? { status: 200, body: { session: session('old') } } : undefined

  it('waits for a list in flight, then goes to the member that listed it', async () => {
    let release: (res: TunnelResponse) => void = () => {}
    const pending = new Promise<TunnelResponse>((resolve) => {
      release = resolve
    })
    const { fed, studio, laptop } = await setup({
      settle: false,
      laptopAnswer: (method, path) => (method === 'GET' && path.startsWith('/api/sessions?') ? pending : undefined),
    })
    const asked = fed.request('GET', '/api/sessions/l1/messages')
    await settle()
    expect(laptop.request.mock.calls.map(([, p]) => p)).not.toContain('/api/sessions/l1/messages')
    release({ status: 200, body: { sessions: [session('l1')] } })
    await asked
    expect(laptop.request).toHaveBeenLastCalledWith('GET', '/api/sessions/l1/messages', undefined)
    expect(studio.request.mock.calls.map(([, p]) => p)).not.toContain('/api/sessions/l1/messages')
  })

  it('asks every member that is up, and the one that has it owns it', async () => {
    const { fed, studio, laptop } = await setup({ laptopAnswer: old })
    await fed.request('GET', '/api/sessions/old/messages')
    expect(fed.ownerOf('old')).toBe(LAPTOP)
    expect(laptop.request).toHaveBeenLastCalledWith('GET', '/api/sessions/old/messages', undefined)
    expect(studio.request.mock.calls.map(([, p]) => p)).toContain('/api/sessions/old')
    expect(studio.request.mock.calls.map(([, p]) => p)).not.toContain('/api/sessions/old/messages')
    const seen = laptop.seen
    fed.seen('old')
    await settle()
    expect(seen).toHaveBeenCalledWith('old')
  })

  it('never sends it to the default member: offline while another member is down', async () => {
    const { fed, group, studio } = await setup()
    group.down(LAPTOP)
    await expect(fed.request('GET', '/api/sessions/zz/messages')).rejects.toEqual(new TunnelError('offline'))
    expect(studio.request.mock.calls.map(([, p]) => p)).toContain('/api/sessions/zz')
    expect(studio.request.mock.calls.map(([, p]) => p)).not.toContain('/api/sessions/zz/messages')
  })

  it('answers a member\'s 404 when every member answered and none has it', async () => {
    const { fed, studio, laptop } = await setup()
    await expect(fed.request('GET', '/api/sessions/gone/messages')).resolves.toEqual({ status: 404, body: { error: 'session_not_found' } })
    for (const channel of [studio, laptop]) expect(channel.request.mock.calls.map(([, p]) => p)).not.toContain('/api/sessions/gone/messages')
    await expect(fed.getFile('gone', 'a.png', 'image')).resolves.toMatchObject({ status: 404 })
  })

  it('answers offline when a member that may hold it is not up', async () => {
    const group = new FakeGroup()
    const studio = fakeChannel(hello('studio'), { tags: [], sessions: [] })
    group.add(STUDIO, 'studio', studio)
    group.add(LAPTOP, 'laptop', null)
    const fed = new GroupFederation(group)
    await settle()
    await expect(fed.request('GET', '/api/sessions/l9')).rejects.toEqual(new TunnelError('offline'))
    await expect(fed.getFile('l9', 'a.png', 'image')).rejects.toEqual(new TunnelError('offline'))
    expect(studio.getFile).not.toHaveBeenCalled()
  })
})

describe('GroupFederation, group-wide answers', () => {
  it('sums the session count of every member that is up', async () => {
    const total = (n: number): Answer => (_method, path) => (path.startsWith('/api/sessions/count') ? { status: 200, body: { total: n } } : undefined)
    const group = new FakeGroup()
    group.add(STUDIO, 'studio', fakeChannel(hello('studio'), { tags: [], sessions: [] }, total(3)))
    group.add(LAPTOP, 'laptop', fakeChannel(hello('laptop'), { tags: [], sessions: [] }, total(4)))
    const fed = new GroupFederation(group)
    await expect(fed.request('GET', '/api/sessions/count')).resolves.toEqual({ status: 200, body: { total: 7 } })
  })

  it('maps tag rules\' tags between the default member and the phone', async () => {
    const rules: Answer = (method, path) =>
      method === 'GET' && path === '/api/tag-rules'
        ? { status: 200, body: { rules: [{ id: 1, tag_id: 7, pattern: 'a' }, { id: 2, tag_id: 55, pattern: 'b' }] } }
        : undefined
    const group = new FakeGroup()
    const studio = fakeChannel(hello('studio'), { tags: [{ id: 7, name: 'orbital', hue: 200 }], sessions: [] }, rules)
    const laptop = fakeChannel(hello('laptop'), { tags: [{ id: 1, name: 'orbital' }, { id: 2, name: 'work', hue: 40 }], sessions: [] })
    group.add(STUDIO, 'studio', studio)
    group.add(LAPTOP, 'laptop', laptop)
    const fed = new GroupFederation(group)
    await settle()
    const tags = await localTags(fed)
    const res = await fed.request('GET', '/api/tag-rules')
    // The rule whose tag the studio does not name is left out.
    expect((res.body as { rules: unknown[] }).rules).toEqual([{ id: 1, tag_id: tags.get('orbital'), pattern: 'a' }])
    await fed.request('POST', '/api/tag-rules', { tagId: tags.get('work'), condition: 'path_matches', pattern: 'x' })
    expect(studio.request).toHaveBeenLastCalledWith('POST', '/api/tag-rules', { tagId: 90, condition: 'path_matches', pattern: 'x' })
  })
})

describe('GroupFederation and a device whose pair is ending', () => {
  it('a removed Mac that never acknowledges is no source: no request, never the default, no rules, its wake and frames ignored', async () => {
    const { group, fed, events, laptop } = await setup()
    expect(fed.sources().map((x) => x.id).sort()).toEqual([LAPTOP, STUDIO].sort())
    // The phone heard the laptop's removal; the laptop never acknowledges.
    group.ending.add(LAPTOP)
    group.emit({ type: 'group' })
    expect(fed.sources().map((x) => x.id)).toEqual([STUDIO])
    const before = events.length
    group.emit({ type: 'wake', peer: LAPTOP, flags: 1 })
    group.emit({ type: 'hub', peer: LAPTOP, frame: { topic: 'sessions', event: 'upsert', session: session('l9') } })
    expect(events.slice(before).filter((e) => e.type === 'wake' || e.type === 'hub')).toEqual([])
    const asked = laptop.request.mock.calls.length
    await fed.request('GET', '/api/sessions').catch(() => {})
    expect(laptop.request.mock.calls.length).toBe(asked)
    // The studio still wakes the phone.
    group.emit({ type: 'wake', peer: STUDIO, flags: 1 })
    expect(events.at(-1)).toEqual({ type: 'wake', flags: 1 })
  })
})


describe('GroupFederation: plan limits across the group', () => {
  const dir = (id: number, account: string | null, extra: Record<string, unknown> = {}) => ({
    id, name: `dir${id}`, account, tracked: true, readAt: '2026-10-20T10:00:00.000Z', stale: false, windows: [], extraUsage: null, waits: [], ...extra,
  })
  type Dir = ReturnType<typeof dir> & { machine?: { id: string; online: boolean } }

  /** Two members, each answering its own directories; the studio passes one of the laptop's on as well. */
  function limitsSetup(opts: { laptopVersion?: string; laptopLimits?: Answer; studioVersion?: string } = {}) {
    const group = new FakeGroup()
    const studio = fakeChannel({ ...hello('studio'), server: opts.studioVersion ?? '0.37.0' }, { tags: [], sessions: [] }, (_method, path) =>
      path.startsWith('/api/limits')
        ? { status: 200, body: { dirs: [dir(1, 'jan@acme.com'), dir(9, null, { machine: { id: LAPTOP } })] } }
        : undefined)
    const laptop = fakeChannel({ ...hello('laptop'), server: opts.laptopVersion ?? '0.37.0' }, { tags: [], sessions: [] }, (method, path, body) =>
      opts.laptopLimits?.(method, path, body) ??
      (path.startsWith('/api/limits') ? { status: 200, body: { dirs: [dir(1, 'JAN@acme.com'), dir(2, null)] } } : undefined))
    group.add(STUDIO, 'studio', studio)
    group.add(LAPTOP, 'laptop', laptop)
    const fed = new GroupFederation(group, { servesLimits: (v) => v === '0.37.0', readsLimits: (v) => v !== '0.33.0' })
    const frames: Record<string, unknown>[] = []
    fed.on((e) => {
      if (e.type === 'hub' && (e.frame as { topic?: string }).topic === 'limits') frames.push(e.frame as Record<string, unknown>)
    })
    return { group, studio, laptop, fed, frames }
  }
  const dirsOf = (body: unknown) => (body as { dirs: Dir[] }).dirs

  it('asks every member for its own and tags each directory with its member, never one passed on', async () => {
    const { fed, studio, laptop } = limitsSetup()
    await settle()
    const res = await fed.request('GET', '/api/limits')
    expect(res.status).toBe(200)
    const dirs = dirsOf(res.body)
    expect(dirs.map((d) => [d.machine?.id, d.id])).toEqual([[STUDIO, 1], [LAPTOP, 1], [LAPTOP, 2]])
    expect(dirs[1].account).toBe('jan@acme.com')
    expect(dirs.every((d) => !d.stale)).toBe(true)
    expect(studio.request).toHaveBeenCalledWith('GET', '/api/limits')
    expect(laptop.request).toHaveBeenCalledWith('GET', '/api/limits')
  })

  it('Read again asks every member to read again', async () => {
    const { fed, studio, laptop } = limitsSetup()
    await settle()
    await fed.request('POST', '/api/limits/refresh')
    expect(studio.request).toHaveBeenCalledWith('POST', '/api/limits/refresh')
    expect(laptop.request).toHaveBeenCalledWith('POST', '/api/limits/refresh')
  })

  it('keeps a member\'s last reading, stale, once it is offline or its read fails', async () => {
    let fail = false
    const { fed, group } = limitsSetup({ laptopLimits: (_m, path) => (fail && path.startsWith('/api/limits') ? { status: 500, body: {} } : undefined) })
    await settle()
    await fed.request('GET', '/api/limits')
    fail = true
    const failed = dirsOf((await fed.request('GET', '/api/limits')).body)
    expect(failed.filter((d) => d.machine?.id === LAPTOP).every((d) => d.stale)).toBe(true)
    expect(failed.find((d) => d.machine?.id === STUDIO)?.stale).toBe(false)
    group.down(LAPTOP)
    const offline = dirsOf((await fed.request('GET', '/api/limits')).body)
    expect(offline.filter((d) => d.machine?.id === LAPTOP).map((d) => [d.id, d.stale, d.machine?.online])).toEqual([[1, true, false], [2, true, false]])
  })

  it('answers a member\'s refusal when no member was ever read', async () => {
    const group = new FakeGroup()
    const studio = fakeChannel(hello('studio'), { tags: [], sessions: [] }, (_m, path) =>
      path === '/api/limits' ? { status: 403, body: { error: 'forbidden' } } : undefined)
    group.add(STUDIO, 'studio', studio)
    const fed = new GroupFederation(group, { servesLimits: () => true })
    await settle()
    expect(await fed.request('GET', '/api/limits')).toEqual({ status: 403, body: { error: 'forbidden' } })
  })

  it('opens a member without the topic with a fresh read, not its last probe', async () => {
    const { fed, studio, laptop } = limitsSetup({ laptopVersion: '0.36.0' })
    await settle()
    await fed.request('GET', '/api/limits')
    expect(studio.request).toHaveBeenCalledWith('GET', '/api/limits')
    expect(laptop.request).toHaveBeenCalledWith('POST', '/api/limits/refresh')
    expect(laptop.request).not.toHaveBeenCalledWith('GET', '/api/limits')
  })

  it('leaves out a member without the limits routes, and its refusal is no answer', async () => {
    const { fed, laptop } = limitsSetup({ laptopVersion: '0.33.0' })
    await settle()
    const dirs = dirsOf((await fed.request('GET', '/api/limits')).body)
    expect(dirs.map((d) => d.machine?.id)).toEqual([STUDIO])
    expect(laptop.request).not.toHaveBeenCalledWith('GET', '/api/limits')
    expect(laptop.request).not.toHaveBeenCalledWith('POST', '/api/limits/refresh')
  })

  it('says no device answered when every member up is too old to ask', async () => {
    const { fed } = limitsSetup({ laptopVersion: '0.33.0', studioVersion: '0.33.0' })
    await settle()
    await expect(fed.request('GET', '/api/limits')).rejects.toThrow()
  })

  it('subscribes `limits` on each member that serves it, and passes on one frame of the whole group', async () => {
    const { fed, studio, laptop, group, frames } = limitsSetup({ laptopVersion: '0.36.0' })
    await settle()
    fed.subscribe('limits')
    expect(studio.topics.has('limits')).toBe(true)
    // An older Mac drops the subscription: it is not sent at all.
    expect(laptop.topics.has('limits')).toBe(false)
    await fed.request('GET', '/api/limits')
    group.emit({ type: 'hub', peer: STUDIO, frame: { topic: 'limits', event: 'limits', limits: { dirs: [dir(1, 'jan@acme.com', { readAt: '2026-10-20T11:00:00.000Z' })] } } })
    const frame = frames.at(-1) as { limits: { dirs: Dir[] } }
    expect(frame.limits.dirs.map((d) => [d.machine?.id, d.id, d.readAt])).toEqual([
      [STUDIO, 1, '2026-10-20T11:00:00.000Z'], [LAPTOP, 1, '2026-10-20T10:00:00.000Z'], [LAPTOP, 2, '2026-10-20T10:00:00.000Z'],
    ])
    // A member gone: its last reading goes out again, stale.
    group.down(LAPTOP)
    const after = frames.at(-1) as { limits: { dirs: Dir[] } }
    expect(after.limits.dirs.filter((d) => d.machine?.id === LAPTOP).every((d) => d.stale)).toBe(true)
  })

  it('reads a member that comes up while the limits are watched', async () => {
    const { fed, laptop, group, frames } = limitsSetup({ laptopVersion: '0.36.0' })
    await settle()
    fed.subscribe('limits')
    group.down(LAPTOP)
    laptop.request.mockClear()
    laptop.ready = true
    group.emit({ type: 'peer', peer: LAPTOP })
    await settle()
    // It does not serve the topic: what it returns on a GET is its last probe, so it reads now.
    expect(laptop.request).toHaveBeenCalledWith('POST', '/api/limits/refresh')
    const frame = frames.at(-1) as { limits: { dirs: Dir[] } }
    expect(frame.limits.dirs.filter((d) => d.machine?.id === LAPTOP).map((d) => d.stale)).toEqual([false, false])
  })
})
