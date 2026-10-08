import type { FetchLike, SessionListPage, api } from '../../../web/src/lib/api'
import type { ApiSession, ChatMessage, OrbitalModel, Tag } from '../../../web/src/lib/types'
import { FakeHub } from './fakeSocket'

/** Everything a demo's fake server answers from. */
export interface DemoWorld {
  sessions: ApiSession[]
  tags: Tag[]
  models: OrbitalModel[]
  settings: Record<string, string>
  messages: Record<string, ChatMessage[]>
}

export interface RouteContext {
  params: Record<string, string>
  url: URL
  body: unknown
  server: FakeServer
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** `/api/...` with `:name` for a path segment, matched whole. */
  path: string
  /** Who calls it, for the list below — a route nobody can name does not belong here. */
  calledBy: string
  /** The JSON body, or undefined for a 404. */
  answer(ctx: RouteContext): unknown
}

/**
 * What `api.<name>` resolves to — the answers below are checked against it, so
 * a change to the client's types fails the site's typecheck. Where the client
 * unwraps the body (`{ tags }` → `Tag[]`), the inner value is checked.
 */
type Answer<K extends keyof typeof api> = Awaited<ReturnType<(typeof api)[K]>>

/**
 * Every endpoint the demos call, and what the fake answers. A demo that needs
 * a different answer (the session demo's permission card, say) adds a route
 * of its own with `server.route(...)`, which is matched ahead of these.
 *
 * What is not listed gets an empty, successful answer — `{}` to a read,
 * `{ ok: true }` to a write — and a console warning in a dev build, so a
 * component that starts calling something new shows up while a demo is being
 * worked on rather than as a broken panel on the website.
 */
export const ROUTES: Route[] = [
  {
    method: 'GET',
    path: '/api/sessions',
    calledBy: 'store.loadInitial, the sidebar',
    answer: ({ server }) => ({ sessions: server.sessions() }) satisfies SessionListPage,
  },
  {
    method: 'GET',
    path: '/api/sessions/count',
    calledBy: 'store.loadInitial (the hole label)',
    answer: ({ server }) => ({ total: server.sessions().length }),
  },
  {
    method: 'GET',
    path: '/api/sessions/:id',
    calledBy: 'store.select (the detail panel)',
    answer: ({ server, params }) => {
      const session = server.session(params.id)
      return session && ({ session } satisfies Answer<'getSession'>)
    },
  },
  {
    method: 'GET',
    path: '/api/sessions/:id/messages',
    calledBy: 'store.select (the transcript)',
    answer: ({ server, params }) => ({
      messages: (server.world.messages[params.id] ?? []) satisfies Answer<'getMessages'>,
    }),
  },
  {
    method: 'GET',
    path: '/api/sessions/:id/subagents/:toolUseId/messages',
    calledBy: 'store.openSubagent (a moon clicked)',
    answer: () => ({ messages: [], droppedCount: 0 }) satisfies Answer<'subagentMessages'>,
  },
  {
    method: 'GET',
    path: '/api/sessions/:id/harness',
    calledBy: 'the detail panel (harness pill)',
    answer: () => ({ harness: null, removed: null, events: [] }) satisfies Answer<'getSessionHarness'>,
  },
  {
    method: 'POST',
    path: '/api/sessions/:id/decision/:decisionId',
    calledBy: 'the permission card (Approve / Deny)',
    answer: ({ server, params, body }) => {
      const approved = (body as { approved?: boolean } | undefined)?.approved !== false
      server.settleDecision(params.id, params.decisionId, approved)
      return { ok: true } satisfies Answer<'resolveDecision'>
    },
  },
  {
    method: 'GET',
    path: '/api/stats/sessions/:id',
    calledBy: 'the detail panel (stats row)',
    // What the server answers for a session its index never saw: the row
    // reads nothing and draws nothing.
    answer: () => undefined,
  },
  {
    method: 'GET',
    path: '/api/commands',
    calledBy: 'the composer (slash completions)',
    answer: () => ({ commands: [] satisfies Answer<'commands'> }),
  },
  {
    method: 'GET',
    path: '/api/tags',
    calledBy: 'store.loadInitial',
    answer: ({ server }) => ({ tags: server.world.tags satisfies Answer<'listTags'> }),
  },
  {
    method: 'GET',
    path: '/api/tag-rules',
    calledBy: 'store.loadInitial',
    answer: () => ({ rules: [] satisfies Answer<'listTagRules'> }),
  },
  {
    method: 'GET',
    path: '/api/settings',
    calledBy: 'store.loadInitial',
    answer: ({ server }) => server.world.settings satisfies Answer<'getSettings'>,
  },
  {
    method: 'GET',
    path: '/api/models',
    calledBy: 'store.loadInitial (model chips)',
    answer: ({ server }) => ({ models: server.world.models, contextWindows: {} }) satisfies Answer<'listModels'>,
  },
  {
    method: 'GET',
    path: '/api/errors',
    calledBy: 'store.loadInitial (the error log)',
    answer: () => ({ errors: [], unseen: 0 }) satisfies Answer<'listErrors'>,
  },
]

function compile(path: string): { regex: RegExp; names: string[] } {
  const names: string[] = []
  const source = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      names.push(segment.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { regex: new RegExp(`^${source}$`), names }
}

interface CompiledRoute extends Route {
  regex: RegExp
  names: string[]
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * The server a demo runs against: the demo world held in memory, answered
 * over `fetch` (`configureApi`) and published over the fake socket. A
 * scenario changes a session through `upsert`, which is what the real server
 * does when a session moves — the components see a `sessions` event, not a
 * store write.
 */
export class FakeServer {
  readonly hub = new FakeHub()
  readonly world: DemoWorld
  private byId = new Map<string, ApiSession>()
  private routes: CompiledRoute[] = []
  /** Set when a request found no route — what the tests look for. */
  unanswered: string[] = []

  constructor(world: DemoWorld) {
    // Its own copy of the transcripts, which a settled decision appends to.
    this.world = { ...world, messages: { ...world.messages } }
    for (const s of world.sessions) this.byId.set(s.id, s)
    for (const r of ROUTES) this.route(r, { last: true })
  }

  /** Adds a route, matched ahead of the ones already there unless `last`. */
  route(route: Route, opts: { last?: boolean } = {}): void {
    const compiled = { ...route, ...compile(route.path) }
    if (opts.last) this.routes.push(compiled)
    else this.routes.unshift(compiled)
  }

  sessions(): ApiSession[] {
    return [...this.byId.values()]
  }

  session(id: string): ApiSession | undefined {
    return this.byId.get(id)
  }

  /**
   * Stores a session and tells the subscribers, as the server's `sessions`
   * topic does. A question that appears or goes is also told on the
   * session's own topic, which is how an open panel hears it.
   */
  upsert(next: ApiSession): void {
    const previous = this.byId.get(next.id)
    this.byId.set(next.id, next)
    this.hub.publish('sessions', { event: 'upsert', session: next })
    const before = previous?.pendingDecision ?? null
    const after = next.pendingDecision ?? null
    if (before?.id === after?.id) return
    if (before) this.hub.publish(`session:${next.id}`, { event: 'decision_resolved', decisionId: before.id })
    if (after) this.hub.publish(`session:${next.id}`, { event: 'decision_pending', decision: after })
  }

  /**
   * A permission answered: the call it held gets its result, as the CLI
   * writes one, and the session goes back to work. Claude's reply after it
   * is not simulated (spec § What the visitor can do).
   */
  settleDecision(sessionId: string, decisionId: string, approved: boolean): void {
    const s = this.byId.get(sessionId)
    if (!s || s.pendingDecision?.id !== decisionId) return
    const result: ChatMessage = {
      id: `${decisionId}-result`,
      role: 'tool_result',
      toolUseId: decisionId,
      text: approved ? 'The file has been updated.' : 'The user declined this edit.',
      ...(approved ? {} : { isError: true }),
      timestamp: new Date().toISOString(),
    }
    this.world.messages[sessionId] = [...(this.world.messages[sessionId] ?? []), result]
    this.hub.publish(`session:${sessionId}`, { event: 'message', message: result })
    this.upsert({ ...s, pendingDecision: null, status: 'working', lastAt: Date.now() })
  }

  /** What `configureApi({ fetch })` takes. */
  readonly fetch: FetchLike = (input, init) => Promise.resolve(this.answer(input, init))

  private answer(input: string, init?: RequestInit): Response {
    const url = new URL(input, 'http://demo.invalid')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    for (const route of this.routes) {
      if (route.method !== method) continue
      const match = route.regex.exec(url.pathname)
      if (!match) continue
      const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]))
      const answer = route.answer({ params, url, body, server: this })
      return answer === undefined ? json({ error: 'not found' }, 404) : json(answer)
    }
    this.unanswered.push(`${method} ${url.pathname}`)
    if (import.meta.env.DEV) console.warn(`[demo] no fake answer for ${method} ${url.pathname}`)
    return json(method === 'GET' ? {} : { ok: true })
  }
}
