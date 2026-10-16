import {
  TunnelError, type BlobResult, type FileResult, type GetFileOptions, type HttpMethod, type PutBlobResult,
  type RemoteClientEvent, type TunnelResponse,
} from '@orbital/shared/remote/client'
import type { FileAs, NotificationSettings } from '@orbital/shared/remote/messages'
import type { SwappableClient } from './clientRef'

/** Another Mac this phone is paired with, beside the main one (spec 2026-10-06-peer-macs-design § 4). */
export type OtherMac = { mac: string; name: string; client: SwappableClient }

type Session = { id: string; tagIds?: number[]; status?: string; machine?: { id?: unknown; name?: unknown; online?: unknown }; [key: string]: unknown }
type Tag = { id: number; name: string }
type ListPage = { sessions?: Session[]; ended?: { count: number; latestAt: number | null } }

type Other = OtherMac & {
  /** Its own sessions, as it last listed them, by id. */
  sessions: Map<string, Session>
  /** Its tags by id, for matching them to the main Mac's by name. */
  tags: Map<number, string>
  detach: () => void
}

/** Literal siblings of `:id` under `/api/sessions`: never a session. */
const NOT_A_SESSION = new Set(['count', 'defaults', 'retention-preview'])
/** A Mac that comes up is listed again with at most this many sessions: one relay frame has to carry them. */
const RELIST_LIMIT = 50

/** The session a per-session topic is about: `session:<id>`, `subagent:<id>:…`, `task-output:<id>:…`. */
export function sessionOfTopic(topic: string): string | null {
  const m = /^(?:session|subagent|task-output):([^:]+)/.exec(topic)
  return m ? m[1] : null
}

/** The session a request is about: its path, or its `?session=`. */
export function sessionOfPath(url: URL): string | null {
  const m = /^\/api\/(?:stats\/)?sessions\/([^/]+)/.exec(url.pathname)
  if (m && !NOT_A_SESSION.has(m[1])) return decodeURIComponent(m[1])
  return url.searchParams.get('session')
}

/**
 * The phone's one client over every Mac it is paired with (spec
 * 2026-10-06-peer-macs-design § 4). The main Mac's client passes through
 * as it always did — its presence, hello, bye and unpaired are what the
 * app's screens are about. Every other Mac is joined in: its sessions come
 * into the list marked with their `machine`, and whatever is asked about one
 * of them goes to that Mac. The tunnel reads as ready while any Mac is.
 */
export class MultiClient implements SwappableClient {
  private readonly others = new Map<string, Other>()
  /** Which other Mac listed a session; a session absent here is the main Mac's. */
  private readonly owners = new Map<string, string>()
  private readonly topics = new Set<string>()
  private readonly listeners = new Set<(event: RemoteClientEvent) => void>()
  /** The main Mac's tags by name, read off its own `GET /api/tags`. */
  private mainTags = new Map<string, number>()
  private wasReady: boolean
  private readonly detachMain: () => void

  readonly main: SwappableClient
  /** Another Mac revoked this phone: the caller forgets it. */
  private readonly onGone: (mac: string) => void

  // Plain fields, not parameter properties: `erasableSyntaxOnly`.
  constructor(main: SwappableClient, onGone: (mac: string) => void = () => {}) {
    this.main = main
    this.onGone = onGone
    this.wasReady = main.ready
    this.detachMain = main.on((event) => this.onMain(event))
  }

  get ready(): boolean {
    return this.main.ready || [...this.others.values()].some((o) => o.client.ready)
  }

  /** The other Macs, for Settings and the list's chips. */
  macs(): { mac: string; name: string; online: boolean }[] {
    return [...this.others.values()].map((o) => ({ mac: o.mac, name: o.name, online: o.client.ready }))
  }

  otherClient(mac: string): SwappableClient | null {
    return this.others.get(mac)?.client ?? null
  }

  add(mac: OtherMac): void {
    if (this.others.has(mac.mac)) return
    const other: Other = { ...mac, sessions: new Map(), tags: new Map(), detach: () => {} }
    other.detach = mac.client.on((event) => this.onOther(other, event))
    this.others.set(mac.mac, other)
    for (const topic of this.topics) if (topic === 'sessions' || topic === 'errors') mac.client.subscribe(topic)
    if (mac.client.ready) void this.relist(other)
    this.syncReady()
  }

  remove(mac: string): void {
    const other = this.others.get(mac)
    if (!other) return
    other.detach()
    other.client.stop()
    this.others.delete(mac)
    for (const id of other.sessions.keys()) {
      this.owners.delete(id)
      this.emitHub({ topic: 'sessions', event: 'remove', sessionId: id })
    }
    this.syncReady()
  }

  on(listener: (event: RemoteClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  stop(): void {
    this.detachMain()
    this.main.stop()
    for (const other of this.others.values()) {
      other.detach()
      other.client.stop()
    }
    this.others.clear()
  }

  async request(method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    const url = new URL(path, 'http://phone')
    if (method === 'GET' && url.pathname === '/api/sessions') return this.list(url)
    const other = this.otherFor(url, body)
    if (!other) {
      const res = await this.main.request(method, path, body)
      if (method === 'GET' && url.pathname === '/api/tags') this.readMainTags(res)
      return res
    }
    url.searchParams.delete('machine')
    let sent = body
    if (sent && typeof sent === 'object' && 'machine' in sent) {
      const { machine: _machine, ...rest } = sent as Record<string, unknown>
      sent = rest
    }
    sent = this.toOtherTags(other, url.pathname, sent)
    const res = await other.client.request(method, url.pathname + url.search, sent)
    const answer = res.body as { session?: Session } | null
    if (answer && typeof answer === 'object' && answer.session && typeof answer.session.id === 'string') {
      return { status: res.status, body: { ...answer, session: this.localize(other, answer.session) } }
    }
    return res
  }

  async getBlob(ref: string, opts?: { edge?: number }): Promise<BlobResult> {
    let last: BlobResult | null = null
    for (const client of this.readyClients()) {
      try {
        const res = await client.getBlob(ref, opts)
        if (res.status === 200) return res
        last = res
      } catch {
        /* the next Mac */
      }
    }
    if (last) return last
    throw new TunnelError('offline')
  }

  getFile(session: string, path: string, as: FileAs, opts?: GetFileOptions): Promise<FileResult> {
    return this.clientOf(session).getFile(session, path, as, opts)
  }

  /**
   * Into the store of the Mac the image is for: the session's, or — before
   * a session exists — every Mac that is up, since the one a new session
   * starts on is not known yet. A store names an image by its hash, so the
   * ref is the same everywhere.
   */
  async putBlob(bytes: Uint8Array, mediaType: string, sessionId?: string | null): Promise<PutBlobResult> {
    if (sessionId) return this.clientOf(sessionId).putBlob(bytes, mediaType)
    const clients = this.readyClients()
    if (clients.length === 0) return this.main.putBlob(bytes, mediaType)
    const results = await Promise.allSettled(clients.map((c) => c.putBlob(bytes, mediaType)))
    const first = results[0]
    if (first.status === 'fulfilled') return first.value
    const ok = results.find((r): r is PromiseFulfilledResult<PutBlobResult> => r.status === 'fulfilled')
    if (ok) return ok.value
    throw first.reason
  }

  subscribe(topic: string): void {
    this.topics.add(topic)
    for (const client of this.clientsFor(topic)) client.subscribe(topic)
  }

  unsubscribe(topic: string): void {
    this.topics.delete(topic)
    for (const client of this.clientsFor(topic)) client.unsubscribe(topic)
  }

  getNotifications(): Promise<NotificationSettings> {
    return this.main.getNotifications()
  }

  /** The phone's choice holds for every Mac: each pushes for itself. */
  async setNotifications(settings: NotificationSettings): Promise<NotificationSettings> {
    for (const other of this.others.values()) {
      if (other.client.ready) other.client.setNotifications(settings).catch(() => undefined)
    }
    return this.main.setNotifications(settings)
  }

  seen(sessionId: string): void {
    this.clientOf(sessionId).seen(sessionId)
  }

  pushToken(token: string): void {
    this.main.pushToken(token)
    for (const other of this.others.values()) other.client.pushToken(token)
  }

  async recheck(windowMs: number): Promise<boolean> {
    const [main] = await Promise.all([
      this.main.recheck(windowMs),
      ...[...this.others.values()].filter((o) => !o.client.ready).map((o) => o.client.recheck(windowMs)),
    ])
    return main
  }

  /**
   * Every Mac that is up, merged: the main Mac's page as it answers it, then
   * each other Mac's own sessions. A session the phone reaches directly is
   * not taken again from a Mac that passes it on. The tag filter is the main
   * Mac's ids, so another Mac is asked without it and filtered here.
   */
  private async list(url: URL): Promise<TunnelResponse> {
    const others = [...this.others.values()].filter((o) => o.client.ready)
    const otherUrl = new URL(url)
    otherUrl.searchParams.delete('tag')
    const tagFilter = url.searchParams.get('tag')?.split(',').map(Number) ?? null
    const [main, ...rest] = await Promise.allSettled([
      this.main.ready ? this.main.request('GET', url.pathname + url.search) : Promise.reject(new TunnelError('offline')),
      ...others.map(async (o) => {
        await this.readTags(o)
        return o.client.request('GET', otherUrl.pathname + otherUrl.search)
      }),
    ])
    const sessions: Session[] = []
    let ended: ListPage['ended'] | undefined
    let answered = false
    if (main.status === 'fulfilled' && main.value.status === 200) {
      answered = true
      const page = main.value.body as ListPage
      sessions.push(...(page.sessions ?? []).filter((s) => !this.reachedDirectly(s)))
      ended = page.ended
    }
    rest.forEach((result, i) => {
      if (result.status !== 'fulfilled' || result.value.status !== 200) return
      answered = true
      const other = others[i]
      const page = result.value.body as ListPage
      const own = (page.sessions ?? []).filter((s) => s.machine === undefined)
      for (const s of own) {
        other.sessions.set(s.id, s)
        this.owners.set(s.id, other.mac)
        this.followSession(other, s.id)
      }
      let shown = own.map((s) => this.localize(other, s))
      if (tagFilter) shown = shown.filter((s) => (s.tagIds ?? []).some((id) => tagFilter.includes(id)))
      sessions.push(...shown)
      if (page.ended) {
        ended = {
          count: (ended?.count ?? 0) + page.ended.count,
          latestAt: Math.max(ended?.latestAt ?? 0, page.ended.latestAt ?? 0) || null,
        }
      }
    })
    if (!answered) {
      if (main.status === 'fulfilled') return main.value
      throw main.reason
    }
    return { status: 200, body: ended ? { sessions, ended } : { sessions } }
  }

  private onMain(event: RemoteClientEvent): void {
    if (event.type === 'ready') {
      // The main Mac back while another kept the tunnel up: the list is read
      // again on an open, so the socket closes and opens once.
      if (event.ready && this.wasReady) {
        this.emit({ type: 'ready', ready: false })
        this.emit({ type: 'ready', ready: true })
        return
      }
      this.syncReady()
      return
    }
    if (event.type === 'hub') {
      const frame = event.frame as { topic?: unknown; session?: Session } | null
      // Passed on by the main Mac, but this phone reaches that Mac itself.
      if (frame?.topic === 'sessions' && frame.session && this.reachedDirectly(frame.session)) return
    }
    this.emit(event)
  }

  private onOther(other: Other, event: RemoteClientEvent): void {
    if (this.others.get(other.mac) !== other) return
    switch (event.type) {
      case 'ready':
        if (event.ready) void this.relist(other)
        else for (const s of other.sessions.values()) this.emitHub({ topic: 'sessions', event: 'upsert', session: this.localize(other, s) })
        this.syncReady()
        return
      case 'hub':
        this.onOtherHub(other, event.frame)
        return
      case 'unpaired':
        this.remove(other.mac)
        this.onGone(other.mac)
        return
      case 'bye':
        if (event.reason === 'revoked') {
          this.remove(other.mac)
          this.onGone(other.mac)
        }
        return
    }
  }

  private onOtherHub(other: Other, raw: unknown): void {
    const frame = raw as { topic?: unknown; event?: unknown; session?: Session; sessionId?: unknown; status?: unknown } | null
    if (!frame || typeof frame.topic !== 'string') return
    if (frame.topic !== 'sessions') {
      this.emitHub(frame)
      return
    }
    if (frame.event === 'upsert') {
      const session = frame.session
      // Another Mac's session, passed on by this one: the phone has it from its own Mac, or not at all.
      if (!session || typeof session.id !== 'string' || session.machine !== undefined) return
      other.sessions.set(session.id, session)
      this.owners.set(session.id, other.mac)
      this.followSession(other, session.id)
      this.emitHub({ ...frame, session: this.localize(other, session) })
      return
    }
    const id = typeof frame.sessionId === 'string' ? frame.sessionId : null
    if (!id || !other.sessions.has(id)) return
    if (frame.event === 'remove') {
      other.sessions.delete(id)
      this.owners.delete(id)
    } else if (frame.event === 'status') {
      other.sessions.get(id)!.status = frame.status as string
    }
    this.emitHub(frame)
  }

  /** A Mac whose tunnel came up: its sessions, read afresh. */
  private async relist(other: Other): Promise<void> {
    try {
      await this.readTags(other)
      const res = await other.client.request('GET', `/api/sessions?limit=${RELIST_LIMIT}&ended=exclude`)
      const list = (res.body as ListPage | null)?.sessions
      if (res.status !== 200 || !Array.isArray(list)) return
      const fresh = new Map(list.filter((s) => s.machine === undefined).map((s) => [s.id, s]))
      for (const id of other.sessions.keys()) {
        if (fresh.has(id)) continue
        other.sessions.delete(id)
        this.owners.delete(id)
        this.emitHub({ topic: 'sessions', event: 'remove', sessionId: id })
      }
      for (const [id, s] of fresh) {
        other.sessions.set(id, s)
        this.owners.set(id, other.mac)
        this.followSession(other, id)
        this.emitHub({ topic: 'sessions', event: 'upsert', session: this.localize(other, s) })
      }
    } catch {
      /* the next time it comes up */
    }
  }

  private async readTags(other: Other): Promise<void> {
    try {
      const res = await other.client.request('GET', '/api/tags')
      const tags = (res.body as { tags?: Tag[] } | null)?.tags
      if (res.status === 200 && Array.isArray(tags)) other.tags = new Map(tags.map((t) => [t.id, t.name]))
    } catch {
      /* the tags it had */
    }
  }

  private readMainTags(res: TunnelResponse): void {
    const tags = (res.body as { tags?: Tag[] } | null)?.tags
    if (res.status === 200 && Array.isArray(tags)) this.mainTags = new Map(tags.map((t) => [t.name, t.id]))
  }

  /** Another Mac's session as the phone shows it: its Mac named, its tags the main Mac's of the same name. */
  private localize(other: Other, session: Session): Session {
    const tagIds = (session.tagIds ?? [])
      .map((id) => this.mainTags.get(other.tags.get(id) ?? ''))
      .filter((id): id is number => id !== undefined)
    return { ...session, tagIds, machine: { id: other.mac, name: other.name, online: other.client.ready } }
  }

  /** Tagging another Mac's session: the main Mac's tag ids become that Mac's, by name; one it lacks is left out. */
  private toOtherTags(other: Other, pathname: string, body: unknown): unknown {
    if (!/^\/api\/sessions\/[^/]+\/tags$/.test(pathname)) return body
    const ids = (body as { tagIds?: unknown } | null)?.tagIds
    if (!Array.isArray(ids)) return body
    const names = new Map([...this.mainTags].map(([name, id]) => [id, name]))
    const theirs = new Map([...other.tags].map(([id, name]) => [name, id]))
    const tagIds = ids.map((id) => theirs.get(names.get(id as number) ?? '')).filter((id): id is number => id !== undefined)
    return { ...(body as object), tagIds }
  }

  private otherFor(url: URL, body: unknown): Other | null {
    const session = sessionOfPath(url)
    const owner = session ? this.owners.get(session) : undefined
    if (owner) return this.others.get(owner) ?? null
    const machine = url.searchParams.get('machine')
      ?? ((body as { machine?: unknown } | null)?.machine as string | undefined)
    return typeof machine === 'string' ? this.others.get(machine) ?? null : null
  }

  private clientOf(sessionId: string): SwappableClient {
    const owner = this.owners.get(sessionId)
    return (owner && this.others.get(owner)?.client) || this.main
  }

  /** `sessions` and `errors` from every Mac; a session's own topics from its Mac; the rest from the main Mac. */
  private clientsFor(topic: string): SwappableClient[] {
    if (topic === 'sessions' || topic === 'errors') return [this.main, ...[...this.others.values()].map((o) => o.client)]
    const session = sessionOfTopic(topic)
    return [session ? this.clientOf(session) : this.main]
  }

  /** A topic asked for before the phone knew which Mac the session is on. */
  private followSession(other: Other, id: string): void {
    for (const topic of this.topics) {
      if (sessionOfTopic(topic) !== id) continue
      this.main.unsubscribe(topic)
      other.client.subscribe(topic)
    }
  }

  /** A session the main Mac passes on from a Mac this phone is paired with itself. */
  private reachedDirectly(session: Session): boolean {
    const id = session.machine?.id
    return typeof id === 'string' && this.others.has(id)
  }

  private readyClients(): SwappableClient[] {
    return [this.main, ...[...this.others.values()].map((o) => o.client)].filter((c) => c.ready)
  }

  private syncReady(): void {
    const ready = this.ready
    if (ready === this.wasReady) return
    this.wasReady = ready
    this.emit({ type: 'ready', ready })
  }

  private emitHub(frame: unknown): void {
    this.emit({ type: 'hub', frame })
  }

  private emit(event: RemoteClientEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (err) {
        console.warn('orbital: a client listener failed', err)
      }
    }
  }
}
