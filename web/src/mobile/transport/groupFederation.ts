import {
  TunnelError, type BlobResult, type FileResult, type GetFileOptions, type HttpMethod, type PutBlobResult,
  type TunnelEvent, type TunnelResponse,
} from '@orbital/shared/remote/tunnel'
import { bytesMatchRef, type Channel } from '@orbital/shared/remote/channel'
import type { GroupClient, GroupClientEvent, PeerInfo } from '@orbital/shared/remote/groupClient'
import {
  NotificationSettingsSchema, peerServes, type FileAs, type HelloMessage, type NotificationSettings,
} from '@orbital/shared/remote/messages'
import type { MachineEvent, MachineRef } from '@orbital/shared/remote/device'
import { sessionOfRequest, sessionOfTopic } from '@orbital/shared/remote/segments'
import { PRESENCE_TOPIC, presenceFromFrame } from '@orbital/shared/presence'
import type { SwappableClient } from './clientRef'
import { mediaTypeOf } from './imageResolver'

export type FederationOptions = {
  now?: () => number
  /** The rules the user last chose on this phone (stored with the group). */
  notifications?: NotificationSettings | null
  /** A new choice was made: store it. */
  onNotifications?: (settings: NotificationSettings) => void
}

/** What the federation needs of the group: its peers, their channels, and what it delegates. */
export type FederatedGroup = Pick<GroupClient, 'on' | 'peers' | 'channel' | 'stop' | 'recheck' | 'pushToken'>

/** The asking half of one peer's channel. */
type PeerChannel = Pick<
  Channel,
  'ready' | 'serves' | 'peer' | 'request' | 'getBlob' | 'getFile' | 'putBlob' | 'getNotifications' | 'setNotifications' | 'seen' | 'subscribe' | 'unsubscribe'
>

/** A device whose sessions the phone shows, as task 6's screens read it. */
export type FederatedSource = {
  id: string
  name: string
  kind: string
  os: string
  /** The relay's presence. */
  online: boolean
  /** Its channel is up and its hello in: requests go through. */
  ready: boolean
  /** When it was last ready, while it is not; null while it is, or before it ever was. */
  asOf: number | null
  version: string | null
  capabilities: string[]
}

type Session = { id: string; [key: string]: unknown }
type Tag = { id: number; name: string; [key: string]: unknown }
type Ended = { count: number; latestAt: number | null }

type Source = {
  id: string
  /** Its own sessions, as it last sent them (its tag ids). */
  sessions: Map<string, Session>
  /** Its tags by its ids. */
  tags: Map<number, Tag>
  /** The fold summary of its last `ended=exclude` list, added in while it is not ready. */
  ended: Ended | null
  ready: boolean
  asOf: number | null
  /** Its own `presence`; false while not ready. */
  atMac: boolean
  /** The channel `subscribed` was sent on; a new channel starts with none. */
  channel: PeerChannel | null
  subscribed: Set<string>
}

/** How many sessions a source that comes up is asked for; one channel frame has to carry the answer. */
const RELIST_LIMITS = [80, 30]

/** How long a source whose relist failed waits before it is relisted once more. */
export const RELIST_RETRY_MS = 5_000

/** How long a request about a session no member has listed yet waits for the lists in flight. */
const RELIST_WAIT_MS = 3_000

/**
 * Where a session's owner was looked for: found; on no member (with one
 * member's own answer to pass on); or not knowable now, because a member
 * that may hold it is not up.
 */
type Lookup = { source: Source } | { missing: TunnelResponse } | { offline: true }

const NOT_FOUND: TunnelResponse = { status: 404, body: { error: 'not_found' } }

/**
 * The phone's one client over every member of its group (spec
 * 2026-10-16-device-group-design § 7): each member that serves sessions is
 * asked on its own channel and what they say is merged, with no main Mac —
 * the server's `FederationService` done on the phone's side
 * (`docs/domains/device-federation.md`). Every session carries the
 * `machine` it runs on; whatever is asked about one goes to that member; a
 * member that sleeps keeps its last known sessions, marked offline. Tags are
 * one namespace here, matched to each member's by name.
 */
export class GroupFederation implements SwappableClient {
  private readonly group: FederatedGroup
  private readonly now: () => number
  private readonly sourcesById = new Map<string, Source>()
  /** Which source listed a session. */
  private readonly owners = new Map<string, string>()
  /** What the app subscribed to. */
  private readonly topics = new Set<string>()
  /** Phone-local tag ids by name, assigned in first-seen order. */
  private readonly tagIds = new Map<string, number>()
  private readonly tagNames = new Map<number, string>()
  private nextTagId = 1
  /** Which sources hold an image, by ref: a turn's images are carried to the member it goes to. */
  private readonly blobHomes = new Map<string, Set<string>>()
  /** The source the last new session started on: the default while it is ready. */
  private lastSpawn: string | null = null
  private peerInfo = new Map<string, PeerInfo>()
  /** Relists running: a lookup of an unknown session waits for them first. */
  private readonly relisting = new Set<Promise<void>>()
  /** Lookups running, by session: two requests about one session ask the members once. */
  private readonly lookups = new Map<string, Promise<Lookup>>()
  private readonly listeners = new Set<(event: TunnelEvent) => void>()
  private readonly memberListeners = new Set<() => void>()
  private wasReady = false
  private wasOnline = false
  private wasAtMac = false
  private lastHello = ''
  private lastMembers = ''
  /** The rules the user chose on this phone, sent to every member as it comes up; null before any choice. */
  private chosen: NotificationSettings | null
  /** The first member's rules are being read to become the phone's (`adopt`). */
  private adopting = false
  private readonly onNotifications: (settings: NotificationSettings) => void

  // Plain fields, not parameter properties: `erasableSyntaxOnly`.
  constructor(group: FederatedGroup, opts: FederationOptions = {}) {
    this.group = group
    this.now = opts.now ?? Date.now
    this.chosen = opts.notifications ?? null
    this.onNotifications = opts.onNotifications ?? (() => {})
    group.on((event) => this.onGroup(event))
    this.refresh()
  }

  get ready(): boolean {
    return [...this.sourcesById.values()].some((s) => this.channelOf(s.id) !== null)
  }

  /** Every device that serves sessions, for task 6's screens. */
  sources(): FederatedSource[] {
    return [...this.sourcesById.values()].map((s) => {
      const info = this.peerInfo.get(s.id)
      const hello = this.helloOf(s.id)
      return {
        id: s.id, name: info?.name ?? '', kind: info?.kind ?? hello?.kind ?? 'desktop', os: info?.os ?? '',
        online: info?.online ?? false, ready: s.ready, asOf: s.asOf,
        version: hello?.server ?? hello?.version ?? null, capabilities: hello?.capabilities ?? [],
      }
    })
  }

  ownerOf(sessionId: string): string | null {
    return this.owners.get(sessionId) ?? null
  }

  on(listener: (event: TunnelEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * The `members` event: a source's online, ready or hello changed, and
   * `sources()` says how. Its own listener, so the app's client events keep
   * their one type.
   */
  onMembers(listener: () => void): () => void {
    this.memberListeners.add(listener)
    return () => {
      this.memberListeners.delete(listener)
    }
  }

  stop(): void {
    this.group.stop()
  }

  async recheck(windowMs: number): Promise<boolean> {
    await this.group.recheck(windowMs)
    this.refresh()
    return this.wasOnline
  }

  pushToken(token: string): void {
    this.group.pushToken(token)
  }

  async request(method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    const url = new URL(path, 'http://phone')
    if (method === 'GET' && url.pathname === '/api/sessions') return this.list(url)
    if (method === 'GET' && url.pathname === '/api/tags') return this.listTags()
    if (method === 'GET' && url.pathname === '/api/sessions/count') return this.count(url)
    const tagPath = /^\/api\/tags\/(\d+)$/.exec(url.pathname)
    if (tagPath && (method === 'PATCH' || method === 'DELETE')) return this.changeTag(method, Number(tagPath[1]), body)

    const routed = await this.targetOf(url, body)
    if ('missing' in routed) return routed.missing
    if ('offline' in routed) throw new TunnelError('offline')
    const target = routed.source
    const channel = this.channelOf(target.id)
    if (!channel) throw new TunnelError('offline')

    let sent = body
    let sentPath = path
    if (url.searchParams.has('machine')) {
      url.searchParams.delete('machine')
      sentPath = url.pathname + url.search
    }
    if (isObject(sent) && 'machine' in sent) {
      const { machine: _machine, ...rest } = sent
      sent = rest
    }
    sent = await this.toTheirs(target, method, url.pathname, sent)

    const isSpawn = method === 'POST' && url.pathname === '/api/sessions'
    // A spawn whose id the phone minted: its topics are asked of the member before the spawn goes.
    const minted = isSpawn && isObject(sent) && typeof sent.sessionId === 'string' ? sent.sessionId : null
    if (minted !== null) this.expect(target, minted)
    let res: TunnelResponse
    try {
      res = await channel.request(method, sentPath, sent)
    } catch (err) {
      if (minted !== null) this.unexpect(target, minted)
      throw err
    }
    const answer = isObject(res.body) ? res.body : null
    if (isSpawn) {
      if (res.status < 300) {
        this.lastSpawn = target.id
        if (typeof answer?.sessionId === 'string') this.expect(target, answer.sessionId)
        // The default member may have changed: topics that follow it move.
        this.syncTopics()
      } else if (minted !== null) {
        this.unexpect(target, minted)
      }
    }
    if (method === 'POST' && url.pathname === '/api/tags' && res.status < 300 && isObject(sent)
      && typeof sent.name === 'string' && typeof answer?.id === 'number') {
      target.tags.set(answer.id, { ...sent, id: answer.id, name: sent.name })
      return { status: res.status, body: { ...answer, id: this.localTagId(sent.name) } }
    }
    if (res.status < 300 && method === 'GET' && url.pathname === '/api/tag-rules' && answer && Array.isArray(answer.rules)) {
      await this.readTags(target)
      const rules = answer.rules.flatMap((rule) => {
        if (!isObject(rule) || typeof rule.tag_id !== 'number') return [rule]
        const local = this.fromTheirTag(target, rule.tag_id)
        // A rule whose tag the phone cannot name is left out rather than shown with another tag's id.
        return local === null ? [] : [{ ...rule, tag_id: local }]
      })
      return { status: res.status, body: { ...answer, rules } }
    }
    if (res.status < 300 && method === 'POST' && url.pathname === '/api/tag-rules/preview' && answer
      && typeof answer.tagId === 'number') {
      await this.readTags(target)
      return { status: res.status, body: { ...answer, tagId: this.fromTheirTag(target, answer.tagId) } }
    }
    if (answer && isSession(answer.session) && !carriesMachine(answer.session)) {
      this.own(target, answer.session)
      return { status: res.status, body: { ...answer, session: this.localize(target, answer.session) } }
    }
    return res
  }

  /**
   * Asked of every source that is up at once; the first that has it answers.
   * A full image counts only when its bytes are the ref's (`bytesMatchRef`):
   * a member answering other bytes does not end the search. A thumbnail
   * (`edge`) cannot be checked, so the first one answered is taken as is.
   */
  getBlob(ref: string, opts: { edge?: number } = {}): Promise<BlobResult> {
    const ready = this.readySources()
    if (ready.length === 0) return Promise.reject(new TunnelError('offline'))
    return new Promise((resolve, reject) => {
      let pending = ready.length
      let last: BlobResult | null = null
      let failure: Error | null = null
      for (const [source, channel] of ready) {
        channel.getBlob(ref, opts).then(
          (res) => {
            if (res.status !== 200) {
              last = res
              return
            }
            if (opts.edge === undefined && !bytesMatchRef(ref, res.bytes)) {
              failure ??= new TunnelError('lost')
              return
            }
            this.addHome(ref, source.id)
            resolve(res)
          },
          (err: unknown) => {
            failure ??= err instanceof Error ? err : new TunnelError('lost')
          },
        ).finally(() => {
          if (--pending > 0) return
          if (last) resolve(last)
          else reject(failure ?? new TunnelError('lost'))
        })
      }
    })
  }

  async getFile(session: string, path: string, as: FileAs, opts?: GetFileOptions): Promise<FileResult> {
    const found = await this.ownerLookup(session)
    if ('missing' in found) return { status: 404, bytes: new Uint8Array(0), mediaType: null, size: null, w: null, h: null }
    const channel = 'source' in found ? this.channelOf(found.source.id) : null
    if (!channel) throw new TunnelError('offline')
    return channel.getFile(session, path, as, opts)
  }

  /**
   * Into the store of the member the session runs on; before a session
   * exists (none, or one no member holds yet), the default member's — a
   * store names an image by its hash, and a turn carries it on (`carry`).
   */
  async putBlob(bytes: Uint8Array, mediaType: string, sessionId?: string | null): Promise<PutBlobResult> {
    let source: Source | null = this.defaultSource()
    if (sessionId) {
      const found = await this.ownerLookup(sessionId)
      if ('offline' in found) throw new TunnelError('offline')
      if ('source' in found) source = found.source
    }
    const channel = source ? this.channelOf(source.id) : null
    if (!source || !channel) throw new TunnelError('offline')
    const res = await channel.putBlob(bytes, mediaType)
    if (res.kind === 'ok') this.addHome(res.entry.ref, source.id)
    return res
  }

  subscribe(topic: string): void {
    this.topics.add(topic)
    if (topic === PRESENCE_TOPIC) {
      // A server answers a presence subscription with its state at once; so does this.
      queueMicrotask(() => {
        if (this.topics.has(PRESENCE_TOPIC) && this.ready) this.emitHub(presenceFrame(this.wasAtMac))
      })
      return
    }
    this.syncTopics()
  }

  unsubscribe(topic: string): void {
    this.topics.delete(topic)
    this.syncTopics()
  }

  getNotifications(): Promise<NotificationSettings> {
    const source = this.defaultSource()
    const channel = source ? this.channelOf(source.id) : null
    return channel ? channel.getNotifications() : Promise.reject(new TunnelError('offline'))
  }

  /**
   * The phone's choice holds for every member: each pushes for its own
   * sessions. Members that are up get it now, the others as they come up.
   */
  async setNotifications(settings: NotificationSettings): Promise<NotificationSettings> {
    const ready = this.readySources()
    if (ready.length === 0) throw new TunnelError('offline')
    this.chosen = settings
    this.onNotifications(settings)
    const fallback = this.defaultSource()
    const results = await Promise.allSettled(ready.map(([, channel]) => channel.setNotifications(settings)))
    const fromDefault = results[ready.findIndex(([s]) => s === fallback)]
    if (fromDefault?.status === 'fulfilled') return fromDefault.value
    const ok = results.find((r): r is PromiseFulfilledResult<NotificationSettings> => r.status === 'fulfilled')
    if (ok) return ok.value
    throw (results[0] as PromiseRejectedResult).reason
  }

  seen(sessionId: string): void {
    void this.ownerLookup(sessionId).then(
      (found) => {
        if ('source' in found) this.channelOf(found.source.id)?.seen(sessionId)
      },
      () => undefined,
    )
  }

  private onGroup(event: GroupClientEvent): void {
    switch (event.type) {
      case 'status':
        this.emit({ type: 'status', status: event.status })
        this.refresh()
        return
      case 'peer':
      case 'channel':
      case 'group':
        this.refresh()
        return
      case 'hub':
        this.onHub(event.peer, event.frame)
        return
      case 'wake':
        if (this.sourcesById.has(event.peer)) this.emit({ type: 'wake', flags: event.flags })
        return
      case 'bye':
        // A member that revoked this phone says so in the roster, and the pair goes by the relay; the
        // app hears of that as `unpaired` once every pair is gone. A version refusal is the app's to show.
        if (event.reason !== 'revoked') {
          this.emit({ type: 'bye', reason: event.reason, ...(event.needed !== undefined ? { needed: event.needed } : {}) })
        }
        return
      case 'unpaired_all':
        this.emit({ type: 'unpaired' })
        return
      case 'relay_error':
        this.emit({ type: 'relay_error', code: event.code })
        return
      case 'relay_too_old':
        this.emit({ type: 'relay_too_old', relayVersion: event.relayVersion, needed: event.needed })
        return
      default:
        return
    }
  }

  /** The peers as the group knows them now: sources made, dropped, up and down, and every aggregate after. */
  private refresh(): void {
    const peers = this.group.peers()
    this.peerInfo = new Map(peers.map((p) => [p.id, p]))
    const current = new Set<string>()
    for (const peer of peers) {
      if (!servesSessions(peer)) continue
      current.add(peer.id)
      let source = this.sourcesById.get(peer.id)
      if (!source) {
        source = {
          id: peer.id, sessions: new Map(), tags: new Map(), ended: null, ready: false, asOf: null, atMac: false,
          channel: null, subscribed: new Set(),
        }
        this.sourcesById.set(peer.id, source)
      }
      const ready = this.channelOf(peer.id) !== null
      if (ready === source.ready) continue
      source.ready = ready
      if (ready) {
        source.asOf = null
        this.sendChosen(source)
        this.startRelist(source, false)
      } else {
        source.asOf = this.now()
        source.atMac = false
        // Now offline, nothing new: one frame every session of it takes, which no notifier reads as news.
        this.emitMachine(source)
      }
    }
    for (const source of [...this.sourcesById.values()]) if (!current.has(source.id)) this.dropSource(source)
    this.syncTopics()

    const ready = this.ready
    if (ready !== this.wasReady) {
      this.wasReady = ready
      this.emit({ type: 'ready', ready })
    }
    const online = peers.some((p) => current.has(p.id) && p.online)
    if (online !== this.wasOnline) {
      this.wasOnline = online
      this.emit({ type: 'presence', macOnline: online })
    }
    this.syncAtMac()
    this.syncHello()
    const members = JSON.stringify(this.sources())
    if (members !== this.lastMembers) {
      this.lastMembers = members
      for (const listener of [...this.memberListeners]) {
        try {
          listener()
        } catch (err) {
          console.warn('orbital: a members listener failed', err)
        }
      }
    }
  }

  /**
   * A member that came up gets the phone's rules: it may have missed a
   * change, or never had them. With none chosen yet (a phone from before
   * groups), the first member's become the phone's (`adopt`).
   */
  private sendChosen(source: Source): void {
    const chosen = this.chosen
    const channel = this.channelOf(source.id)
    if (!channel) return
    if (!chosen) {
      this.adopt(source, channel)
      return
    }
    channel.setNotifications(chosen).catch(() => {
      // Sent again the next time it comes up.
    })
  }

  /**
   * Once: the rules `source` reports are taken as the phone's choice — what
   * the user chose against their one Mac before groups — stored, and sent to
   * every other member up now; a member that comes up later gets them then.
   */
  private adopt(source: Source, channel: PeerChannel): void {
    if (this.adopting) return
    this.adopting = true
    channel.getNotifications().then(
      (reported) => {
        this.adopting = false
        const rules = NotificationSettingsSchema.safeParse(reported)
        // A choice made meanwhile wins; an answer that does not read is asked again at the next member up.
        if (this.chosen || !rules.success) return
        this.chosen = rules.data
        this.onNotifications(rules.data)
        for (const [other] of this.readySources()) if (other !== source) this.sendChosen(other)
      },
      () => {
        this.adopting = false
      },
    )
  }

  /** A peer no longer paired: its sessions leave the list. */
  private dropSource(source: Source): void {
    this.sourcesById.delete(source.id)
    for (const id of source.sessions.keys()) {
      if (this.owners.get(id) !== source.id) continue
      this.owners.delete(id)
      this.emitHub({ topic: 'sessions', event: 'remove', sessionId: id })
    }
    for (const homes of this.blobHomes.values()) homes.delete(source.id)
    if (this.lastSpawn === source.id) this.lastSpawn = null
  }

  private onHub(peer: string, raw: unknown): void {
    const source = this.sourcesById.get(peer)
    if (!source || !isObject(raw) || typeof raw.topic !== 'string') return
    if (raw.topic === PRESENCE_TOPIC) {
      const atMac = presenceFromFrame(raw)
      if (atMac !== null) {
        source.atMac = atMac
        this.syncAtMac()
      }
      return
    }
    if (raw.topic === 'sessions') return this.onSessionsFrame(source, raw)
    // Another member's session is that member's to tell.
    const session = sessionOfTopic(raw.topic)
    if (session !== null && this.owners.get(session) !== source.id) return
    this.emitHub(raw)
  }

  private onSessionsFrame(source: Source, frame: Record<string, unknown>): void {
    if (frame.event === 'upsert') {
      // A session passed on as a third device's: the phone has it from that device, or not at all.
      if (!isSession(frame.session) || carriesMachine(frame.session)) return
      if (!this.mayOwn(source, frame.session.id)) return
      if (this.own(source, frame.session)) this.syncTopics()
      this.emitHub({ ...frame, session: this.localize(source, frame.session) })
      return
    }
    const id = typeof frame.sessionId === 'string' ? frame.sessionId : null
    if (id === null || this.owners.get(id) !== source.id) return
    if (frame.event === 'remove') {
      source.sessions.delete(id)
      this.owners.delete(id)
      this.syncTopics()
    } else if (frame.event === 'status') {
      const known = source.sessions.get(id)
      if (known) source.sessions.set(id, { ...known, status: frame.status })
    }
    this.emitHub(frame)
  }

  /** Relists `source`, held in `relisting` while it runs; `retry` when this is the one retry after a failure. */
  private startRelist(source: Source, retry: boolean): void {
    const run = this.relist(source, retry)
    this.relisting.add(run)
    const done = () => {
      this.relisting.delete(run)
    }
    run.then(done, done)
  }

  /**
   * A relist that failed is tried once more after `RELIST_RETRY_MS`, if the
   * source is still the one up on the same channel; after that, the next
   * time it comes up.
   */
  private retryRelist(source: Source, channel: PeerChannel): void {
    setTimeout(() => {
      if (this.sourcesById.get(source.id) !== source || this.channelOf(source.id) !== channel) return
      this.startRelist(source, true)
    }, RELIST_RETRY_MS)
  }

  /** A source that came up: its tags and its sessions, read afresh and sent on as upserts. */
  private async relist(source: Source, retry = false): Promise<void> {
    const channel = this.channelOf(source.id)
    if (!channel) return
    await this.readTags(source)
    for (const limit of RELIST_LIMITS) {
      let res: TunnelResponse
      try {
        res = await channel.request('GET', `/api/sessions?limit=${limit}&ended=exclude`)
      } catch (err) {
        console.warn(`[mobile] could not list the sessions of ${source.id.slice(0, 8)}`, err)
        if (!retry) this.retryRelist(source, channel)
        return
      }
      if (this.channelOf(source.id) !== channel || this.sourcesById.get(source.id) !== source) return
      // Too big for one frame: fewer.
      if (res.status === 413) continue
      const page = isObject(res.body) ? res.body : null
      if (res.status !== 200 || !page || !Array.isArray(page.sessions)) return
      const fresh = ownSessions(page.sessions)
      if (isEnded(page.ended)) source.ended = page.ended
      // A whole list says what went while the source was away; a cut one only what it holds.
      if (fresh.length < limit) {
        const listed = new Set(fresh.map((s) => s.id))
        for (const [id, known] of [...source.sessions]) {
          if (listed.has(id) || folded(known)) continue
          source.sessions.delete(id)
          if (this.owners.get(id) !== source.id) continue
          this.owners.delete(id)
          this.emitHub({ topic: 'sessions', event: 'remove', sessionId: id })
        }
      }
      // What a member that came back lists happened while it was away, and it pushed
      // a wake for what mattered: `replay` folds it into the notifier as a seed.
      for (const s of fresh) {
        if (!this.mayOwn(source, s.id)) continue
        this.own(source, s)
        this.emitHub({ topic: 'sessions', event: 'upsert', session: this.localize(source, s), replay: true })
      }
      this.syncTopics()
      return
    }
  }

  /**
   * Every source that is up asked the same (its own tag ids for the filter),
   * merged; a source that is not up adds its last known sessions, offline,
   * on the first page. The app sorts.
   */
  private async list(url: URL): Promise<TunnelResponse> {
    const machine = url.searchParams.get('machine')
    let targets = [...this.sourcesById.values()]
    if (machine !== null) {
      const one = this.sourcesById.get(machine)
      if (!one) return { status: 404, body: { error: 'unknown_device' } }
      targets = [one]
    }
    const asked = targets.flatMap((s) => {
      const channel = this.channelOf(s.id)
      return channel ? [[s, channel] as const] : []
    })
    if (asked.length === 0) throw new TunnelError('offline')
    const tagFilter = url.searchParams.get('tag')?.split(',').map(Number).filter((n) => Number.isInteger(n)) ?? null
    const results = await Promise.allSettled(asked.map(async ([source, channel]) => {
      await this.readTags(source)
      const theirUrl = new URL(url)
      theirUrl.searchParams.delete('machine')
      if (tagFilter) {
        const theirs = this.theirTagIds(source, tagFilter)
        // None of the tags asked for: nothing of this source matches.
        if (theirs.length === 0) return { status: 200, body: { sessions: [] } }
        theirUrl.searchParams.set('tag', theirs.join(','))
      }
      return channel.request('GET', theirUrl.pathname + theirUrl.search)
    }))

    const sessions: Session[] = []
    let ended: Ended | null = null
    let first: Record<string, unknown> | null = null
    let fallback: TunnelResponse | null = null
    let failure: unknown = null
    let touched = false
    for (const [i, result] of results.entries()) {
      const source = asked[i][0]
      if (result.status === 'rejected') {
        failure ??= result.reason
        continue
      }
      const page = isObject(result.value.body) ? result.value.body : null
      if (result.value.status !== 200 || !page || !Array.isArray(page.sessions)) {
        fallback ??= result.value
        continue
      }
      first ??= page
      const own = ownSessions(page.sessions).filter((s) => this.mayOwn(source, s.id))
      for (const s of own) touched = this.own(source, s) || touched
      sessions.push(...own.map((s) => this.localize(source, s)))
      if (isEnded(page.ended)) {
        if (url.searchParams.get('ended') === 'exclude') source.ended = page.ended
        ended = addEnded(ended, page.ended)
      }
    }
    if (touched) this.syncTopics()
    if (!first) {
      if (fallback) return fallback
      throw failure
    }
    if (Number(url.searchParams.get('offset') ?? 0) <= 0) {
      for (const source of targets) {
        if (source.ready) continue
        const kept = [...source.sessions.values()].filter((s) => matchesList(s, url)).map((s) => this.localize(source, s))
        sessions.push(...(tagFilter ? kept.filter((s) => hasAnyTag(s, tagFilter)) : kept))
        if (url.searchParams.get('ended') === 'exclude' && source.ended) ended = addEnded(ended, source.ended)
      }
    }
    return { status: 200, body: { ...first, sessions, ...(ended ? { ended } : {}) } }
  }

  /** The total of every member that is up. */
  private async count(url: URL): Promise<TunnelResponse> {
    const ready = this.readySources()
    if (ready.length === 0) throw new TunnelError('offline')
    const answers = await Promise.allSettled(ready.map(([, channel]) => channel.request('GET', url.pathname + url.search)))
    let total: number | null = null
    let fallback: TunnelResponse | null = null
    for (const answer of answers) {
      if (answer.status === 'rejected') continue
      const n = isObject(answer.value.body) ? answer.value.body.total : undefined
      if (answer.value.status === 200 && typeof n === 'number') total = (total ?? 0) + n
      else fallback ??= answer.value
    }
    if (total !== null) return { status: 200, body: { total } }
    if (fallback) return fallback
    throw (answers[0] as PromiseRejectedResult).reason
  }

  /** Every source's tags, one per name, with the phone's ids. */
  private async listTags(): Promise<TunnelResponse> {
    const ready = this.readySources()
    if (ready.length === 0) throw new TunnelError('offline')
    await Promise.all(ready.map(([source]) => this.readTags(source)))
    const byName = new Map<string, Tag>()
    for (const source of this.sourcesById.values()) {
      for (const tag of source.tags.values()) if (!byName.has(tag.name)) byName.set(tag.name, tag)
    }
    const tags = [...byName.values()].map((t) => ({ ...t, id: this.localTagId(t.name) })).sort((a, b) => a.id - b.id)
    return { status: 200, body: { tags } }
  }

  /** A tag renamed or deleted on the phone is that tag on every member that has one of its name. */
  private async changeTag(method: 'PATCH' | 'DELETE', localId: number, body: unknown): Promise<TunnelResponse> {
    const ready = this.readySources()
    if (ready.length === 0) throw new TunnelError('offline')
    const name = this.tagNames.get(localId)
    if (name === undefined) return { status: 404, body: { error: 'not_found' } }
    await Promise.all(ready.map(([source]) => this.readTags(source)))
    const asks = ready.flatMap(([source, channel]) => {
      const theirs = [...source.tags.values()].find((t) => t.name === name)
      return theirs ? [channel.request(method, `/api/tags/${encodeURIComponent(String(theirs.id))}`, body)] : []
    })
    if (asks.length === 0) return { status: 404, body: { error: 'not_found' } }
    const answers = await Promise.allSettled(asks)
    const ok = answers.find((r): r is PromiseFulfilledResult<TunnelResponse> => r.status === 'fulfilled' && r.value.status < 300)
    const renamed = isObject(body) && typeof body.name === 'string' ? body.name : null
    // A rename onto a name the phone already has, or one that failed on some member, leaves the tag
    // split under two local ids until the names agree again; nothing is lost, it lists twice.
    if (ok && renamed !== null && !this.tagIds.has(renamed)) {
      this.tagIds.delete(name)
      this.tagIds.set(renamed, localId)
      this.tagNames.set(localId, renamed)
    }
    if (ok) return ok.value
    const answered = answers.find((r): r is PromiseFulfilledResult<TunnelResponse> => r.status === 'fulfilled')
    if (answered) return answered.value
    throw (answers[0] as PromiseRejectedResult).reason
  }

  private async readTags(source: Source): Promise<void> {
    const channel = this.channelOf(source.id)
    if (!channel) return
    try {
      const res = await channel.request('GET', '/api/tags')
      const tags = isObject(res.body) ? res.body.tags : null
      if (res.status !== 200 || !Array.isArray(tags)) return
      source.tags = new Map(tags.filter(isTag).map((t) => [t.id, t]))
      for (const t of source.tags.values()) this.localTagId(t.name)
    } catch (err) {
      // The tags it had stay.
      console.warn(`[mobile] could not read the tags of ${source.id.slice(0, 8)}`, err)
    }
  }

  private localTagId(name: string): number {
    let id = this.tagIds.get(name)
    if (id === undefined) {
      id = this.nextTagId++
      this.tagIds.set(name, id)
      this.tagNames.set(id, name)
    }
    return id
  }

  /** The phone's tag ids as the source's own, by name; one it lacks is left out. */
  private theirTagIds(source: Source, localIds: number[]): number[] {
    const byName = new Map([...source.tags.values()].map((t) => [t.name, t.id]))
    return localIds.flatMap((id) => {
      const theirs = byName.get(this.tagNames.get(id) ?? '')
      return theirs === undefined ? [] : [theirs]
    })
  }

  /** The phone's tag ids as the source's own, by name; one it lacks is made there first. */
  private async ensureTheirTags(source: Source, localIds: number[]): Promise<number[]> {
    await this.readTags(source)
    const channel = this.channelOf(source.id)
    const out: number[] = []
    for (const id of localIds) {
      const name = this.tagNames.get(id)
      if (name === undefined) continue
      const known = [...source.tags.values()].find((t) => t.name === name)
      if (known) {
        out.push(known.id)
        continue
      }
      if (!channel) continue
      const model = this.tagNamed(name)
      const body = { name, hue: typeof model?.hue === 'number' ? model.hue : 0 }
      try {
        const res = await channel.request('POST', '/api/tags', body)
        const made = isObject(res.body) ? res.body.id : undefined
        if (res.status < 300 && typeof made === 'number') {
          source.tags.set(made, { ...body, id: made })
          out.push(made)
        }
      } catch (err) {
        // Left out, as a tag the member could not make.
        console.warn(`[mobile] could not make the tag ${name} on ${source.id.slice(0, 8)}`, err)
      }
    }
    return out
  }

  /** A source's tag id as the phone's; null for one it has not named. */
  private fromTheirTag(source: Source, id: number): number | null {
    const tag = source.tags.get(id)
    return tag ? this.localTagId(tag.name) : null
  }

  private tagNamed(name: string): Tag | null {
    for (const source of this.sourcesById.values()) {
      for (const tag of source.tags.values()) if (tag.name === name) return tag
    }
    return null
  }

  /** A body about to go to `source`: the phone's tag ids made its own, a turn's images carried to it. */
  private async toTheirs(source: Source, method: HttpMethod, pathname: string, body: unknown): Promise<unknown> {
    if (!isObject(body)) return body
    let out = body
    if (method === 'PUT' && /^\/api\/sessions\/[^/]+\/tags$/.test(pathname) && Array.isArray(out.tagIds)) {
      out = { ...out, tagIds: await this.ensureTheirTags(source, out.tagIds.filter(isNumber)) }
    }
    if (method === 'POST' && pathname === '/api/sessions' && typeof out.tagId === 'number') {
      const [theirs] = await this.ensureTheirTags(source, [out.tagId])
      const { tagId: _tagId, ...rest } = out
      out = theirs === undefined ? rest : { ...rest, tagId: theirs }
    }
    if (method === 'POST' && pathname === '/api/tag-rules' && typeof out.tagId === 'number') {
      // A tag the member could not be given: an id it has none of, refused there, never another tag's.
      const [theirs] = await this.ensureTheirTags(source, [out.tagId])
      out = { ...out, tagId: theirs ?? -1 }
    }
    if (method === 'PATCH' && /^\/api\/tag-rules\/[^/]+$/.test(pathname) && typeof out.tag_id === 'number') {
      const [theirs] = await this.ensureTheirTags(source, [out.tag_id])
      out = { ...out, tag_id: theirs ?? -1 }
    }
    if (Array.isArray(out.attachments)) await this.carry(source, out.attachments.filter(isString))
    return out
  }

  /** Images put on another member (before the session's member was known): copied over, best effort. */
  private async carry(target: Source, refs: string[]): Promise<void> {
    const channel = this.channelOf(target.id)
    if (!channel) return
    for (const ref of refs) {
      const homes = this.blobHomes.get(ref)
      if (!homes || homes.has(target.id)) continue
      const from = [...homes].map((id) => this.channelOf(id)).find((c) => c !== null)
      if (!from) continue
      try {
        const blob = await from.getBlob(ref)
        if (blob.status !== 200) continue
        const put = await channel.putBlob(blob.bytes, blob.mediaType ?? mediaTypeOf(ref))
        if (put.kind === 'ok') this.addHome(put.entry.ref, target.id)
      } catch {
        /* the member answers for the ref it lacks */
      }
    }
  }

  private addHome(ref: string, source: string): void {
    const homes = this.blobHomes.get(ref) ?? new Set<string>()
    homes.add(source)
    this.blobHomes.set(ref, homes)
  }

  /**
   * Where a request goes: its session's owner; else its `machine`; else,
   * for a session no member has listed yet, the member that has it; else
   * (no session) the default member. A session's request never goes to the
   * default: another member would answer "not found" for it.
   */
  private async targetOf(url: URL, body: unknown): Promise<Lookup> {
    const session = sessionOfRequest(url.pathname + url.search)
    const known = session !== null ? this.knownOwner(session) : null
    if (known) return known
    const machine = url.searchParams.get('machine') ?? (isObject(body) && typeof body.machine === 'string' ? body.machine : null)
    if (machine !== null) {
      const named = this.sourcesById.get(machine)
      return named ? { source: named } : { missing: { status: 404, body: { error: 'unknown_device' } } }
    }
    if (session !== null) return this.ownerLookup(session)
    const fallback = this.defaultSource()
    return fallback ? { source: fallback } : { offline: true }
  }

  private knownOwner(sessionId: string): Lookup | null {
    const owner = this.owners.get(sessionId)
    if (owner === undefined) return null
    const source = this.sourcesById.get(owner)
    return source ? { source } : { offline: true }
  }

  private ownerLookup(sessionId: string): Promise<Lookup> {
    const known = this.knownOwner(sessionId)
    if (known) return Promise.resolve(known)
    const running = this.lookups.get(sessionId)
    if (running) return running
    const lookup = this.lookUp(sessionId).finally(() => this.lookups.delete(sessionId))
    this.lookups.set(sessionId, lookup)
    return lookup
  }

  /**
   * A session no member has listed yet (a push tap right after launch, one
   * past `RELIST_LIMITS`): the lists in flight first, for at most
   * `RELIST_WAIT_MS`, then every member that is up is asked for it. The one
   * that has it owns it. Nobody: a member's 404 when every member answered,
   * else offline — the one that is not up may hold it.
   */
  private async lookUp(sessionId: string): Promise<Lookup> {
    if (this.relisting.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled([...this.relisting]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, RELIST_WAIT_MS)
        }),
      ])
      clearTimeout(timer)
      const known = this.knownOwner(sessionId)
      if (known) return known
    }
    const ready = this.readySources()
    const path = `/api/sessions/${encodeURIComponent(sessionId)}`
    const answers = await Promise.allSettled(ready.map(([, channel]) => channel.request('GET', path)))
    let missing: TunnelResponse | null = null
    let unanswered = false
    for (const [i, answer] of answers.entries()) {
      if (answer.status === 'rejected') {
        unanswered = true
        continue
      }
      const body = isObject(answer.value.body) ? answer.value.body : null
      if (answer.value.status === 200 && body && isSession(body.session) && !carriesMachine(body.session)) {
        // A frame that named its owner while this asked wins.
        const known = this.knownOwner(sessionId)
        if (known) return known
        const [source] = ready[i]
        this.own(source, body.session)
        this.syncTopics()
        return { source }
      }
      // A 200 for a session passed on as a third device's is not this member's either.
      missing ??= answer.value.status === 200 ? NOT_FOUND : answer.value
    }
    const asleep = [...this.sourcesById.values()].some((s) => !this.channelOf(s.id))
    if (unanswered || asleep || !missing) return { offline: true }
    return { missing }
  }

  /** The member the last new session started on, while it is up; else the first that is. */
  private defaultSource(): Source | null {
    const last = this.lastSpawn !== null ? this.sourcesById.get(this.lastSpawn) : undefined
    if (last && this.channelOf(last.id)) return last
    for (const source of this.sourcesById.values()) if (this.channelOf(source.id)) return source
    return null
  }

  /** The channel to a source while it is up and serves. */
  private channelOf(id: string): PeerChannel | null {
    const channel: PeerChannel | null = this.group.channel(id)
    return channel && channel.ready && channel.serves ? channel : null
  }

  private readySources(): [Source, PeerChannel][] {
    return [...this.sourcesById.values()].flatMap((s) => {
      const channel = this.channelOf(s.id)
      return channel ? [[s, channel] as [Source, PeerChannel]] : []
    })
  }

  private helloOf(id: string): HelloMessage | null {
    return this.group.channel(id)?.peer ?? this.peerInfo.get(id)?.hello ?? null
  }

  /**
   * Whether `source` may hold the session: the first member that listed it
   * keeps it until it removes it or is not up any more. Ids do not collide
   * on their own; this keeps a member from taking over another's session,
   * and with it what the phone sends that session.
   */
  private mayOwn(source: Source, id: string): boolean {
    const owner = this.owners.get(id)
    return owner === undefined || owner === source.id || this.channelOf(owner) === null
  }

  /** Records `source` as the session's owner; true when that is news, so per-session topics move. */
  private own(source: Source, session: Session): boolean {
    if (!this.mayOwn(source, session.id)) return false
    source.sessions.set(session.id, session)
    if (this.owners.get(session.id) === source.id) return false
    this.owners.set(session.id, source.id)
    return true
  }

  private expect(source: Source, id: string): void {
    if (this.owners.get(id) === source.id) return
    this.owners.set(id, source.id)
    this.syncTopics()
  }

  private unexpect(source: Source, id: string): void {
    if (this.owners.get(id) !== source.id || source.sessions.has(id)) return
    this.owners.delete(id)
    this.syncTopics()
  }

  /**
   * What each source's channel is subscribed to: `sessions` and `errors`
   * everywhere, a session's own topics on its owner once it is known, any
   * other topic on the default member, and `presence` wherever it is served
   * (for the aggregate, whether or not the app asked).
   */
  private syncTopics(): void {
    const fallback = this.defaultSource()
    for (const source of this.sourcesById.values()) {
      const channel: PeerChannel | null = this.group.channel(source.id)
      if (channel !== source.channel) {
        source.channel = channel
        source.subscribed = new Set()
      }
      if (!channel) continue
      const want = new Set<string>()
      for (const topic of this.topics) {
        if (topic === PRESENCE_TOPIC) continue
        if (topic === 'sessions' || topic === 'errors') {
          want.add(topic)
          continue
        }
        const session = sessionOfTopic(topic)
        if (session !== null ? this.owners.get(session) === source.id : fallback === source) want.add(topic)
      }
      if (servesPresence(this.helloOf(source.id))) want.add(PRESENCE_TOPIC)
      for (const topic of want) {
        if (source.subscribed.has(topic)) continue
        channel.subscribe(topic)
        source.subscribed.add(topic)
      }
      for (const topic of [...source.subscribed]) {
        if (want.has(topic)) continue
        channel.unsubscribe(topic)
        source.subscribed.delete(topic)
      }
    }
  }

  /** One `presence` for the app: at a member while the user is at any member that is up (spec § 10). */
  private syncAtMac(): void {
    const atMac = [...this.sourcesById.values()].some((s) => s.atMac && s.ready)
    if (atMac === this.wasAtMac) return
    this.wasAtMac = atMac
    this.emitHub(presenceFrame(atMac))
  }

  /** The default member's hello, for what still reads one Mac's name and version. */
  private syncHello(): void {
    const source = this.defaultSource()
    const hello = source ? this.helloOf(source.id) : null
    if (!source || !hello) return
    const key = `${source.id} ${JSON.stringify(hello)}`
    if (key === this.lastHello) return
    this.lastHello = key
    this.emit({
      type: 'hello', server: hello.server ?? hello.version ?? '', macName: hello.macName ?? hello.name ?? '',
      ...(hello.kind !== undefined ? { kind: hello.kind } : {}),
      ...(hello.capabilities !== undefined ? { capabilities: hello.capabilities } : {}),
    })
  }

  /** A source's session as the phone shows it: its member named, its tags the phone's. */
  private localize(source: Source, session: Session): Session {
    const tagIds = Array.isArray(session.tagIds)
      ? session.tagIds.flatMap((id) => {
        const tag = typeof id === 'number' ? source.tags.get(id) : undefined
        return tag ? [this.localTagId(tag.name)] : []
      })
      : session.tagIds
    return { ...session, ...(tagIds !== undefined ? { tagIds } : {}), machine: this.machineOf(source) }
  }

  private machineOf(source: Source): MachineRef {
    const info = this.peerInfo.get(source.id)
    return {
      id: source.id, name: info?.name ?? '', kind: info?.kind ?? info?.hello?.kind ?? 'desktop', os: info?.os ?? '',
      online: source.ready, asOf: source.ready ? null : source.asOf,
    }
  }

  /** The source's state, online or not, in one `machine` frame rather than an upsert per session; none while it shows none. */
  private emitMachine(source: Source): void {
    if (![...source.sessions.keys()].some((id) => this.owners.get(id) === source.id)) return
    const event: MachineEvent = { event: 'machine', machine: this.machineOf(source) }
    this.emitHub({ topic: 'sessions', ...event })
  }

  private emitHub(frame: unknown): void {
    this.emit({ type: 'hub', frame })
  }

  private emit(event: TunnelEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (err) {
        console.warn('orbital: a client listener failed', err)
      }
    }
  }
}

/**
 * A peer whose sessions the phone shows: its hello says it serves them (a
 * shipped Mac by naming `server`, a member by `sessions`); before any hello,
 * anything but a phone.
 */
function servesSessions(peer: PeerInfo): boolean {
  return peer.hello ? peerServes(peer.hello) : peer.kind !== 'phone'
}

/** A member names `presence`; a shipped Mac names no capabilities and has always served it to its phone. */
function servesPresence(hello: HelloMessage | null): boolean {
  if (!hello) return false
  return hello.capabilities ? hello.capabilities.includes('presence') : hello.server !== undefined
}

function presenceFrame(atMac: boolean): unknown {
  return { topic: PRESENCE_TOPIC, event: 'state', atMac }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSession(value: unknown): value is Session {
  return isObject(value) && typeof value.id === 'string'
}

/** Passed on as a third device's: never shown second-hand. */
function carriesMachine(session: Session): boolean {
  return session.machine !== undefined && session.machine !== null
}

function ownSessions(list: unknown[]): Session[] {
  return list.filter(isSession).filter((s) => !carriesMachine(s))
}

function isTag(value: unknown): value is Tag {
  return isObject(value) && typeof value.id === 'number' && typeof value.name === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isEnded(value: unknown): value is Ended {
  return isObject(value) && typeof value.count === 'number' && (value.latestAt === null || typeof value.latestAt === 'number')
}

function addEnded(sum: Ended | null, more: Ended): Ended {
  if (!sum) return more
  const latest = Math.max(sum.latestAt ?? 0, more.latestAt ?? 0)
  return { count: sum.count + more.count, latestAt: latest > 0 ? latest : null }
}

function hasAnyTag(session: Session, tagIds: number[]): boolean {
  return Array.isArray(session.tagIds) && session.tagIds.some((id) => tagIds.includes(id as number))
}

/** The phone's ENDED fold, as a server's list draws it: unpinned ended sessions. */
function folded(session: Session): boolean {
  return session.status === 'ended' && session.pinnedAt == null
}

/** A kept session against a list's query, as the server's route filters its own (`docs/domains/device-federation.md`). */
function matchesList(session: Session, url: URL): boolean {
  if (session.purpose === 'harness_draft' && session.endedAt != null) return false
  const source = url.searchParams.get('source')
  if (source !== null && session.source !== source) return false
  const q = url.searchParams.get('q')
  if (q && !(typeof session.title === 'string' ? session.title : '').toLowerCase().includes(q.toLowerCase())) return false
  const ended = url.searchParams.get('ended')
  if (ended === 'only' && !folded(session)) return false
  if (ended === 'exclude' && folded(session)) return false
  return true
}
