import type {
  ApiSession,
  AttachmentUpload,
  ChatMessage,
  CompletionKey,
  ImageRefEntry,
  ErrorKind,
  ErrorRecord,
  FileCompletionEntry,
  FilePreview,
  SlashCommand,
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
  // which silently broke every body-less DELETE/POST here (interrupt,
  // deleteTag, deleteTagRule).
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

/** `?session=<id>` or `?cwd=<dir>` — never both (the server reads one). */
function applyCompletionKey(url: URL, key: CompletionKey): void {
  if ('session' in key) url.searchParams.set('session', key.session)
  else url.searchParams.set('cwd', key.cwd)
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
    /** Image refs the dialog's first turn carries (spec: 2026-09-20-composer-design). */
    attachments?: string[]
  }): Promise<string> {
    const data = await request<{ sessionId: string }>('POST', '/api/sessions', body)
    return data.sessionId
  },

  /**
   * `attachments` is omitted from the body when there is nothing to send —
   * absent and empty mean the same thing to the server, and an always-present
   * `[]` would make every existing body assertion in the suite wrong for no
   * gain.
   */
  async sendMessage(
    id: string,
    text: string,
    attachments?: readonly string[]
  ): Promise<{ ok: boolean; revived?: boolean }> {
    return request<{ ok: boolean; revived?: boolean }>(
      'POST',
      `/api/sessions/${id}/messages`,
      attachments && attachments.length > 0 ? { text, attachments } : { text }
    )
  },

  /**
   * One composer attachment (spec: 2026-09-20-composer-design § Image intake).
   *
   * Outside the shared `request` helper for two reasons, both the same ones
   * `filePreview` above is: the body is `multipart/form-data`, which a JSON
   * helper cannot carry (and whose boundary only the browser may write — hence
   * no `Content-Type` header here), and 413/415/400 are intake STATES carrying
   * a measured fact, not errors. Only a status outside the contract throws.
   *
   * `signal` is the chip's own `AbortController`: × cancels this upload and
   * nothing else.
   *
   * `sessionId` is `null` in the New Session dialog, which has no session until
   * Launch — and then the sessionless route takes the bytes. The two routes run
   * the same handler and answer the same contract (the image store is
   * content-addressed and global, so a session id never scoped the write); this
   * only picks the door.
   */
  async uploadAttachment(
    sessionId: string | null,
    file: File,
    opts?: { signal?: AbortSignal }
  ): Promise<AttachmentUpload> {
    const url = sessionId === null ? '/api/attachments' : `/api/sessions/${sessionId}/attachments`
    const body = new FormData()
    body.append('file', file, file.name)

    const response = await fetch(url, { method: 'POST', body, signal: opts?.signal })

    if (response.ok) {
      return { kind: 'ok', entry: (await response.json()) as ImageRefEntry }
    }

    const text = await response.text()
    let parsed: { error?: string; size?: number; truncated?: boolean; mediaType?: string } = {}
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch {
      // A refusal without a JSON body falls through to the ApiError below.
    }

    if (response.status === 413 && parsed.error === 'too_large') {
      return { kind: 'too_large', size: parsed.size ?? 0, truncated: parsed.truncated === true }
    }
    if (response.status === 415 && parsed.error === 'not_image') {
      return { kind: 'not_image', mediaType: parsed.mediaType ?? 'unknown' }
    }
    if (response.status === 400 && parsed.error === 'empty_file') return { kind: 'empty' }

    throw new ApiError(text || response.statusText, response.status, url)
  },

  /**
   * Answers the question the session is blocked on (spec:
   * 2026-09-20-interactive-decisions-design § Channel). REST rather than the
   * hub because answering has a real outcome: a 404 means the decision no
   * longer exists — already answered in another window, interrupted, or the
   * session ended — which the store treats as "resolved", not as an error.
   *
   * `answers` is COMPLETE: one entry per question, keyed by the exact
   * question text, as the SDK's `updatedInput.answers` expects.
   */
  async answerDecision(
    id: string,
    decisionId: string,
    answers: Record<string, string>
  ): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', `/api/sessions/${id}/decision/${decisionId}`, {
      answers,
    })
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

  /** The pin — exemption from the map's release timer; `false` unpins. */
  async setSessionPinned(id: string, pinned: boolean): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PUT', `/api/sessions/${id}/pinned`, { pinned })
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

  // Files API — the read-only file viewer's one route (spec:
  // 2026-09-19-file-viewer-design).
  //
  // Deliberately NOT through the shared `request` helper: 403/404/413/415
  // are expected states carrying `size`/`mediaType`, not errors, so this
  // reads non-2xx bodies itself and returns the `FilePreview` union.
  // Refusals are viewer states, never toasts; only a network-level failure
  // (or a status outside the contract) surfaces as an error.
  //
  // The `:line` suffix never travels to the server — callers strip it and
  // keep it for scrolling.
  async filePreview(sessionId: string, path: string): Promise<FilePreview> {
    const url = new URL('/api/files', window.location.origin)
    url.searchParams.set('session', sessionId)
    url.searchParams.set('path', path)
    const requestUrl = url.pathname + url.search

    const response = await fetch(requestUrl, { method: 'GET' })

    if (response.ok) {
      const data = (await response.json()) as {
        content: string
        size: number
        mtimeMs: number
        lines: number
      }
      return { kind: 'ok', ...data }
    }

    const text = await response.text()
    let body: { error?: string; size?: number; mediaType?: string } = {}
    try {
      body = JSON.parse(text) as typeof body
    } catch {
      // A refusal without a JSON body falls through to the ApiError below.
    }

    if (response.status === 403 && body.error === 'outside_cwd') return { kind: 'outside' }
    if (response.status === 404) return { kind: 'not_found' }
    if (response.status === 413 && body.error === 'too_large') {
      return { kind: 'too_large', size: body.size ?? 0 }
    }
    if (response.status === 415 && body.error === 'binary') {
      return { kind: 'binary', size: body.size ?? 0, mediaType: body.mediaType ?? 'binary' }
    }

    throw new ApiError(text || response.statusText, response.status, requestUrl)
  },

  // Completion API — the composer's two sources (spec:
  // 2026-09-20-composer-design § Server). Both take the same `CompletionKey`,
  // because the only difference between the panel's composer and the dialog's
  // is that one has a session and the other only a directory.
  async commands(key: CompletionKey): Promise<SlashCommand[]> {
    const url = new URL('/api/commands', window.location.origin)
    applyCompletionKey(url, key)
    const data = await request<{ commands: SlashCommand[] }>('GET', url.pathname + url.search)
    return data.commands
  },

  /** `prefix` is sent verbatim, empty included — an empty prefix lists the cwd. */
  async filesComplete(key: CompletionKey, prefix: string): Promise<FileCompletionEntry[]> {
    const url = new URL('/api/files/complete', window.location.origin)
    applyCompletionKey(url, key)
    url.searchParams.set('prefix', prefix)
    const data = await request<{ entries: FileCompletionEntry[] }>('GET', url.pathname + url.search)
    return data.entries
  },

  // Projects API
  async listProjects(): Promise<Array<{ cwd: string; lastModel: string | null }>> {
    const data = await request<{ projects: Array<{ cwd: string; lastModel: string | null }> }>('GET', '/api/projects')
    return data.projects
  },

  // Models API
  async listModels(): Promise<{ models: OrbitalModel[]; contextWindows: Record<string, number> }> {
    const data = await request<{ models: OrbitalModel[]; contextWindows?: Record<string, number> }>(
      'GET',
      '/api/models'
    )
    return { models: data.models, contextWindows: data.contextWindows ?? {} }
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
  AskUserQuestionInput,
  AttachmentSource,
  AttachmentUpload,
  ChatMessage,
  CommandSource,
  PendingDecision,
  QuestionOption,
  QuestionSpec,
  ImageProvenance,
  ImageRefEntry,
  CompletionKey,
  ErrorKind,
  FileCompletionEntry,
  SlashCommand,
  ErrorRecord,
  ErrorSource,
  FilePreview,
  Tag,
  TagRule,
  Subagent,
  OrbitalModel,
} from './types'
