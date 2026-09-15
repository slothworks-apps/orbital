import type {
  ApiSession,
  ChatMessage,
  Tag,
  TagRule,
  Subagent,
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
  async listSessions(params: {
    limit?: number
    offset?: number
    source?: string
    status?: string
    tag?: number
  }): Promise<ApiSession[]> {
    const url = new URL('/api/sessions', window.location.origin)
    if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit))
    if (params.offset !== undefined) url.searchParams.set('offset', String(params.offset))
    if (params.source !== undefined) url.searchParams.set('source', params.source)
    if (params.status !== undefined) url.searchParams.set('status', params.status)
    if (params.tag !== undefined) url.searchParams.set('tag', String(params.tag))

    return request<ApiSession[]>('GET', url.pathname + url.search)
  },

  async getSession(id: string): Promise<ApiSession> {
    return request<ApiSession>('GET', `/api/sessions/${id}`)
  },

  async getMessages(
    id: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<ChatMessage[]> {
    const url = new URL(`/api/sessions/${id}/messages`, window.location.origin)
    if (opts?.limit !== undefined) url.searchParams.set('limit', String(opts.limit))
    if (opts?.offset !== undefined) url.searchParams.set('offset', String(opts.offset))

    return request<ChatMessage[]>('GET', url.pathname + url.search)
  },

  async createSession(body: { cwd: string; title: string }): Promise<ApiSession> {
    return request<ApiSession>('POST', '/api/sessions', body)
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

  async clearSession(id: string, startNew: boolean): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', `/api/sessions/${id}/clear`, { startNew })
  },

  async renameSession(id: string, title: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PATCH', `/api/sessions/${id}/rename`, { title })
  },

  async setSessionTags(id: string, tagIds: number[]): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', `/api/sessions/${id}/tags`, { tagIds })
  },

  // Tags API
  async listTags(): Promise<Tag[]> {
    return request<Tag[]>('GET', '/api/tags')
  },

  async createTag(body: { name: string; hue: number }): Promise<Tag> {
    return request<Tag>('POST', '/api/tags', body)
  },

  async updateTag(id: number, body: Partial<{ name: string; hue: number }>): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PATCH', `/api/tags/${id}`, body)
  },

  async deleteTag(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('DELETE', `/api/tags/${id}`)
  },

  // Tag Rules API
  async listTagRules(): Promise<TagRule[]> {
    return request<TagRule[]>('GET', '/api/tag-rules')
  },

  async createTagRule(body: {
    tag_id: number
    condition: 'path_matches' | 'title_contains' | 'permission_is'
    pattern: string
  }): Promise<TagRule> {
    return request<TagRule>('POST', '/api/tag-rules', body)
  },

  async updateTagRule(
    id: number,
    body: Partial<{
      tag_id: number
      position: number
      enabled: 0 | 1
      condition: 'path_matches' | 'title_contains' | 'permission_is'
      pattern: string
    }>
  ): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PATCH', `/api/tag-rules/${id}`, body)
  },

  async deleteTagRule(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('DELETE', `/api/tag-rules/${id}`)
  },

  async previewRule(body: {
    tag_id: number
    condition: 'path_matches' | 'title_contains' | 'permission_is'
    pattern: string
  }): Promise<{ matches: boolean }> {
    return request<{ matches: boolean }>('POST', '/api/tag-rules/preview', body)
  },

  // Projects API
  async listProjects(): Promise<unknown[]> {
    return request<unknown[]>('GET', '/api/projects')
  },

  // Settings API
  async getSettings(): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>('GET', '/api/settings')
  },

  async patchSettings(partial: Record<string, unknown>): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>('PATCH', '/api/settings', partial)
  },
}

// Export types for convenience
export type { ApiSession, ChatMessage, Tag, TagRule, Subagent } from './types'
