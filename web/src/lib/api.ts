import type {
  ApiSession,
  ChatMessage,
  ErrorKind,
  ErrorRecord,
  Tag,
  TagRule,
  PermissionMode,
  OrbitalModel,
} from './types'

export class ApiError extends Error {
  status: number

  /**
   * The request that failed. Carried because `request()` is the only place
   * that still knows it, and a status code without a URL next to it in the
   * error log names nothing — see `reportError` in `lib/errors`.
   */
  url?: string

  constructor(message: string, status: number, url?: string) {
    super(message)
    this.status = status
    this.url = url
  }
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {}

  const options: RequestInit = {
    method,
    headers,
  }

  // Only a request that carries a body declares a content type. Fastify
  // parses the body of ANY request that declares one, and answers a
  // declared-but-empty JSON body with 400 FST_ERR_CTP_EMPTY_JSON_BODY —
  // which silently broke every body-less DELETE/POST here (clearErrors,
  // interrupt, deleteTag, deleteTagRule).
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }

  const response = await fetch(url, options)

  if (!response.ok) {
    const text = await response.text()
    throw new ApiError(text || response.statusText, response.status, url)
  }

  const data = await response.json()
  return data as T
}

// Sessions API
export const api = {
  async listSessions(params?: {
    tag?: number
    q?: string
    source?: string
    limit?: number
    offset?: number
  }): Promise<ApiSession[]> {
    const url = new URL('/api/sessions', window.location.origin)
    if (params?.tag !== undefined) url.searchParams.set('tag', String(params.tag))
    if (params?.q !== undefined) url.searchParams.set('q', params.q)
    if (params?.source !== undefined) url.searchParams.set('source', params.source)
    if (params?.limit !== undefined) url.searchParams.set('limit', String(params.limit))
    if (params?.offset !== undefined) url.searchParams.set('offset', String(params.offset))

    const data = await request<{ sessions: ApiSession[] }>('GET', url.pathname + url.search)
    return data.sessions
  },

  async getSession(id: string): Promise<{ session: ApiSession; lineage: string[] }> {
    return request<{ session: ApiSession; lineage: string[] }>('GET', `/api/sessions/${id}`)
  },

  async getMessages(
    id: string,
    opts?: { before?: string; limit?: number }
  ): Promise<ChatMessage[]> {
    const url = new URL(`/api/sessions/${id}/messages`, window.location.origin)
    if (opts?.before !== undefined) url.searchParams.set('before', opts.before)
    if (opts?.limit !== undefined) url.searchParams.set('limit', String(opts.limit))

    const data = await request<{ messages: ChatMessage[] }>('GET', url.pathname + url.search)
    return data.messages
  },

  async createSession(body: {
    cwd: string
    prompt: string
    permissionMode: PermissionMode
    tagId?: number
    model?: string
    /** Minted by the browser so it can subscribe to the session's topic before
     * this request goes out. Omitted, the server mints one as it always did.
     * See `docs/fixes/first-turn-can-outrun-the-ws-subscription.md`. */
    sessionId?: string
  }): Promise<string> {
    const data = await request<{ sessionId: string }>('POST', '/api/sessions', body)
    return data.sessionId
  },

  async sendMessage(
    id: string,
    text: string
  ): Promise<{ ok: boolean; revived?: boolean }> {
    return request<{ ok: boolean; revived?: boolean }>(
      'POST',
      `/api/sessions/${id}/messages`,
      { text }
    )
  },

  async interrupt(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', `/api/sessions/${id}/interrupt`)
  },

  async clearSession(id: string, startNew: boolean): Promise<{ ok: boolean; sessionId?: string }> {
    return request<{ ok: boolean; sessionId?: string }>('POST', `/api/sessions/${id}/clear`, {
      startNew,
    })
  },

  async renameSession(id: string, title: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PATCH', `/api/sessions/${id}`, { title })
  },

  async setSessionTags(id: string, tagIds: number[]): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PUT', `/api/sessions/${id}/tags`, { tagIds })
  },

  /** Map-only dismissal (the hole's absorption); `false` is the undo. */
  async setSessionDismissed(id: string, dismissed: boolean): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PUT', `/api/sessions/${id}/dismissed`, { dismissed })
  },

  /** The whole index's session count — the hole's label; the list endpoint only ever returns a page. */
  async sessionCount(): Promise<number> {
    const data = await request<{ total: number }>('GET', '/api/sessions/count')
    return data.total
  },

  // Tags API
  async listTags(): Promise<Tag[]> {
    const data = await request<{ tags: Tag[] }>('GET', '/api/tags')
    return data.tags
  },

  async createTag(body: { name: string; hue: number }): Promise<number> {
    const data = await request<{ id: number }>('POST', '/api/tags', body)
    return data.id
  },

  async patchTag(
    id: number,
    // `anchor_*: null` clears the clump's stored home, so null and absent differ.
    body: Partial<{ name: string; hue: number; anchor_x: number | null; anchor_y: number | null }>
  ): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PATCH', `/api/tags/${id}`, body)
  },

  async deleteTag(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('DELETE', `/api/tags/${id}`)
  },

  // Tag Rules API
  async listTagRules(): Promise<TagRule[]> {
    const data = await request<{ rules: TagRule[] }>('GET', '/api/tag-rules')
    return data.rules
  },

  async createTagRule(body: {
    tagId: number
    condition: 'path_matches' | 'title_contains' | 'permission_is'
    pattern: string
  }): Promise<number> {
    const data = await request<{ id: number }>('POST', '/api/tag-rules', body)
    return data.id
  },

  async patchTagRule(
    id: number,
    body: Partial<{
      position: number
      enabled: 0 | 1
      condition: 'path_matches' | 'title_contains' | 'permission_is'
      pattern: string
      tag_id: number
    }>
  ): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PATCH', `/api/tag-rules/${id}`, body)
  },

  async deleteTagRule(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('DELETE', `/api/tag-rules/${id}`)
  },

  async previewRule(body: {
    cwd: string
    title: string
    permissionMode: string | null
  }): Promise<{ tagId: number | null; ruleId: number | null }> {
    return request<{ tagId: number | null; ruleId: number | null }>(
      'POST',
      '/api/tag-rules/preview',
      body
    )
  },

  // Projects API
  async listProjects(): Promise<Array<{ cwd: string; lastModel: string | null }>> {
    const data = await request<{ projects: Array<{ cwd: string; lastModel: string | null }> }>('GET', '/api/projects')
    return data.projects
  },

  // Models API
  async listModels(): Promise<OrbitalModel[]> {
    const data = await request<{ models: OrbitalModel[] }>('GET', '/api/models')
    return data.models
  },

  async setSessionModel(id: string, model: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', `/api/sessions/${id}/model`, { model })
  },

  // Errors API — the one shared error log, fed from both sides. See
  // `docs/superpowers/specs/2026-09-17-error-surface-design.md`.
  //
  // `unseen` is the server's count over the WHOLE table, never of the page
  // returned: a page of 50 can correctly report 200 unread, which is exactly
  // why the store takes the number from here instead of counting rows.
  async listErrors(params?: {
    limit?: number
    /** An error id — the page returned is the one just older than it. */
    before?: number
  }): Promise<{ errors: ErrorRecord[]; unseen: number }> {
    const url = new URL('/api/errors', window.location.origin)
    if (params?.limit !== undefined) url.searchParams.set('limit', String(params.limit))
    if (params?.before !== undefined) url.searchParams.set('before', String(params.before))

    return request<{ errors: ErrorRecord[]; unseen: number }>('GET', url.pathname + url.search)
  },

  /** Posts one of the browser's own failures. The server forces `source: 'web'`. */
  async reportErrorToServer(body: {
    kind: ErrorKind
    message: string
    detail?: string | null
    context?: Record<string, unknown> | null
    sessionId?: string | null
  }): Promise<{ error: ErrorRecord; unseen: number }> {
    // A dev build stamps every report it makes: HMR of a half-written file
    // throws errors no built app ever would, and the log has to keep them
    // tellable from real ones after the fact. Stamped here — the one door
    // every web report goes through — not at each call site.
    const context = import.meta.env.DEV ? { ...body.context, dev: true } : body.context
    return request<{ error: ErrorRecord; unseen: number }>('POST', '/api/errors', {
      ...body,
      context,
    })
  },

  async markErrorsSeen(target: number[] | 'all'): Promise<{ ok: true; unseen: number }> {
    return request<{ ok: true; unseen: number }>(
      'POST',
      '/api/errors/seen',
      target === 'all' ? { all: true } : { ids: target },
    )
  },

  async clearErrors(): Promise<{ ok: true; unseen: number }> {
    return request<{ ok: true; unseen: number }>('DELETE', '/api/errors')
  },

  // Settings API
  async getSettings(): Promise<Record<string, string>> {
    return request<Record<string, string>>('GET', '/api/settings')
  },

  async patchSettings(partial: Record<string, string>): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PATCH', '/api/settings', partial)
  },
}

// Export types for convenience
export type {
  ApiSession,
  ChatMessage,
  ErrorKind,
  ErrorRecord,
  ErrorSource,
  Tag,
  TagRule,
  Subagent,
  OrbitalModel,
} from './types'
