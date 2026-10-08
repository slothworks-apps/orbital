import type { FetchLike, SessionListPage, api } from '../../../web/src/lib/api'
import type { ApiSession, ChatMessage, OrbitalModel, PermissionMode, Tag } from '../../../web/src/lib/types'
import { FakeHub } from './fakeSocket'
import { SESSION_DEFAULTS, launchedSession, projects } from './fixtures'

/** Everything a demo's fake server answers from. */
export interface DemoWorld {
  sessions: ApiSession[]
  tags: Tag[]
  models: OrbitalModel[]
  settings: Record<string, string>
  messages: Record<string, ChatMessage[]>
  /**
   * What the call a permission holds prints once approved, by decision id.
   * Without one, an edit's result — what most permissions in the demos ask
   * about.
   */
  approvedOutputs?: Record<string, string>
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
    calledBy: 'store.loadInitial, the sidebar (its next page, its tag and search filters)',
    answer: ({ server, url }) => {
      const q = url.searchParams
      const tag = q.get('tag')
      const search = q.get('q')?.toLowerCase()
      const offset = Number(q.get('offset') ?? 0)
      const limit = q.has('limit') ? Number(q.get('limit')) : Infinity
      const sessions = server
        .sessions()
        .filter((s) => tag === null || s.tagIds.includes(Number(tag)))
        .filter((s) => !search || (s.title ?? '').toLowerCase().includes(search) || s.cwd.toLowerCase().includes(search))
        .slice(offset, offset + limit)
      return { sessions } satisfies SessionListPage
    },
  },
  {
    method: 'POST',
    path: '/api/sessions',
    calledBy: 'store.launchSession (the new-session dialog, the phone’s new-session screen)',
    answer: ({ server, body }) => {
      const launch = body as Parameters<typeof api.createSession>[0] | undefined
      if (!launch?.cwd) return undefined
      return { sessionId: server.launch(launch) }
    },
  },
  {
    method: 'GET',
    path: '/api/sessions/count',
    calledBy: 'store.loadInitial (the hole label)',
    answer: ({ server }) => ({ total: server.sessions().length }),
  },
  {
    method: 'GET',
    path: '/api/sessions/defaults',
    calledBy: 'the phone’s new-session screen (mode and model preselection)',
    answer: () => SESSION_DEFAULTS satisfies Answer<'sessionDefaults'>,
  },
  {
    method: 'GET',
    path: '/api/projects',
    calledBy: 'the new-session dialog and screen (recent directories, last model per directory)',
    answer: ({ server }) => ({ projects: projects(server.sessions()) satisfies Answer<'listProjects'> }),
  },
  {
    method: 'POST',
    path: '/api/sessions/:id/end',
    calledBy: 'a planet dropped on the map’s trash',
    answer: ({ server, params, body }) => {
      const s = server.session(params.id)
      if (!s) return undefined
      const unpin = (body as { unpin?: boolean } | undefined)?.unpin === true
      server.upsert({ ...s, status: 'ended', endedAt: Date.now(), ...(unpin ? { pinnedAt: null } : {}) })
      return { ok: true } satisfies Answer<'endSession'>
    },
  },
  {
    method: 'POST',
    path: '/api/sessions/:id/reopen',
    calledBy: 'the trash toast’s Undo',
    answer: ({ server, params }) => {
      const s = server.session(params.id)
      if (!s) return undefined
      server.upsert({ ...s, status: 'idle', endedAt: null })
      return { ok: true } satisfies Answer<'reopenSession'>
    },
  },
  {
    method: 'PATCH',
    path: '/api/sessions/:id',
    calledBy: 'the detail panel (rename)',
    answer: ({ server, params, body }) =>
      server.patch(params.id, { title: String((body as { title?: string } | undefined)?.title ?? '') }) satisfies
        | Answer<'renameSession'>
        | undefined,
  },
  {
    method: 'POST',
    path: '/api/sessions/:id/retitle',
    calledBy: 'the detail panel (regenerate name)',
    // Claude is not asked: the answer is the one it gives when the name the
    // session has still fits.
    answer: ({ server, params }) => {
      const s = server.session(params.id)
      return s && ({ title: s.title ?? '', changed: false } satisfies Answer<'retitleSession'>)
    },
  },
  {
    method: 'PUT',
    path: '/api/sessions/:id/tags',
    calledBy: 'the detail panel (the tag pill)',
    answer: ({ server, params, body }) =>
      server.patch(params.id, { tagIds: (body as { tagIds?: number[] } | undefined)?.tagIds ?? [] }) satisfies
        | Answer<'setSessionTags'>
        | undefined,
  },
  {
    method: 'POST',
    path: '/api/sessions/:id/model',
    calledBy: 'the detail panel (the model chip)',
    answer: ({ server, params, body }) => {
      const value = (body as { model?: string } | undefined)?.model ?? null
      const row = server.world.models.find((m) => m.value === value)
      return server.patch(params.id, { model: value, resolvedModel: row?.resolvedModel ?? value }) satisfies
        | Answer<'setSessionModel'>
        | undefined
    },
  },
  {
    method: 'POST',
    path: '/api/sessions/:id/permission-mode',
    calledBy: 'the detail panel (the mode chip)',
    answer: ({ server, params, body }) => {
      const mode = (body as { mode?: PermissionMode } | undefined)?.mode
      return mode && (server.patch(params.id, { permissionMode: mode }) satisfies Answer<'setSessionPermissionMode'> | undefined)
    },
  },
  {
    method: 'PUT',
    path: '/api/sessions/:id/pinned',
    calledBy: 'the sidebar’s and the detail panel’s pin',
    answer: ({ server, params, body }) => {
      const s = server.session(params.id)
      if (!s) return undefined
      const pinned = (body as { pinned?: boolean } | undefined)?.pinned === true
      server.upsert({ ...s, pinnedAt: pinned ? Date.now() : null })
      return { ok: true } satisfies Answer<'setSessionPinned'>
    },
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
    method: 'PATCH',
    path: '/api/tags/:id',
    calledBy: 'a tag cluster dragged to a new home on the map',
    answer: ({ server, params, body }) => {
      const id = Number(params.id)
      if (!server.world.tags.some((t) => t.id === id)) return undefined
      server.world.tags = server.world.tags.map((t) => (t.id === id ? { ...t, ...(body as Partial<Tag>) } : t))
      return { ok: true } satisfies Answer<'patchTag'>
    },
  },
  {
    method: 'POST',
    path: '/api/tag-rules/preview',
    calledBy: 'the new-session dialog (the tag a rule would pick)',
    // The demo has no rules: the dialog keeps the tag it opened with.
    answer: () => ({ tagId: null, ruleId: null }) satisfies Answer<'previewRule'>,
  },
  {
    method: 'GET',
    path: '/api/settings',
    calledBy: 'store.loadInitial',
    answer: ({ server }) => server.world.settings satisfies Answer<'getSettings'>,
  },
  {
    method: 'PATCH',
    path: '/api/settings',
    calledBy: 'the sidebar (collapse, width), the new-session dialog (the last launch)',
    answer: ({ server, body }) => {
      server.world.settings = { ...server.world.settings, ...(body as Record<string, string>) }
      return { ok: true } satisfies Answer<'patchSettings'>
    },
  },
  {
    method: 'GET',
    path: '/api/health',
    calledBy: 'Settings → General (billing, the watched directory)',
    // No paths: the demo has no Mac whose directories it could name.
    answer: () => ({ billing: 'subscription' }) satisfies Answer<'getHealth'>,
  },
  {
    method: 'GET',
    path: '/api/session-instructions/tips',
    calledBy: 'Settings → Sessions (the instruction tips)',
    answer: () => ({ tips: [] }) satisfies Answer<'getSessionInstructionTips'>,
  },
  {
    method: 'GET',
    path: '/api/gh-status',
    calledBy: 'Settings → Appearance (the pull-request line)',
    answer: () => ({ status: 'ready' }) satisfies Answer<'ghStatus'>,
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
  {
    method: 'POST',
    path: '/api/errors/seen',
    calledBy: 'the error log (mark all read)',
    answer: () => ({ ok: true, unseen: 0 }) satisfies Answer<'markErrorsSeen'>,
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
  private launched = 0

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
      text: approved
        ? (this.world.approvedOutputs?.[decisionId] ?? 'The file has been updated.')
        : "The user doesn't want to proceed with this tool use.",
      ...(approved ? {} : { isError: true }),
      timestamp: new Date().toISOString(),
    }
    this.world.messages[sessionId] = [...(this.world.messages[sessionId] ?? []), result]
    this.hub.publish(`session:${sessionId}`, { event: 'message', message: result })
    this.upsert({ ...s, pendingDecision: null, status: 'working', lastAt: Date.now() })
  }

  /**
   * Changes a session's fields and tells the subscribers. Answers as a write
   * route does: `{ ok: true }`, or undefined (a 404) for no such session.
   */
  patch(id: string, fields: Partial<ApiSession>): { ok: true } | undefined {
    const s = this.byId.get(id)
    if (!s) return undefined
    this.upsert({ ...s, ...fields })
    return { ok: true }
  }

  /**
   * A session started from a new-session dialog or screen, as `POST
   * /api/sessions` starts one: under the id the client minted (it subscribed
   * to that id's topic before asking), at work in the chosen directory.
   * Without a tag picked, it takes the tag of a session already in that
   * directory — where the real server's rules would most likely put it.
   * Returns the id, which the client then selects.
   */
  launch(body: Parameters<typeof api.createSession>[0]): string {
    this.launched += 1
    const id = body.sessionId ?? `launched-${this.launched}`
    const neighbour = this.sessions().find((s) => s.cwd === body.cwd)
    const model = this.world.models.find((m) => m.value === body.model) ?? this.world.models[0] ?? null
    this.upsert(
      launchedSession({
        id,
        cwd: body.cwd,
        permissionMode: body.permissionMode,
        model,
        tagIds: body.tagId != null ? [body.tagId] : (neighbour?.tagIds ?? []),
      }),
    )
    return id
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
