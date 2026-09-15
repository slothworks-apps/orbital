import type {
  ApiSession,
  ChatMessage,
  Tag,
  TagRule,
  PermissionMode,
} from './types'

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  const options: RequestInit = {
    method,
    headers,
  }

  if (body !== undefined) {
    options.body = JSON.stringify(body)
  }

  const response = await fetch(url, options)

  if (!response.ok) {
    const text = await response.text()
    throw new ApiError(text || response.statusText, response.status)
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

  // Tags API
  async listTags(): Promise<Tag[]> {
    const data = await request<{ tags: Tag[] }>('GET', '/api/tags')
    return data.tags
  },

  async createTag(body: { name: string; hue: number }): Promise<number> {
    const data = await request<{ id: number }>('POST', '/api/tags', body)
    return data.id
  },

  async patchTag(id: number, body: Partial<{ name: string; hue: number }>): Promise<{ ok: boolean }> {
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
  async listProjects(): Promise<string[]> {
    const data = await request<{ projects: string[] }>('GET', '/api/projects')
    return data.projects
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
export type { ApiSession, ChatMessage, Tag, TagRule, Subagent } from './types'
