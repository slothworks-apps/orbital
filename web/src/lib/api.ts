import type { McpjsonDecisions, McpjsonServer } from './mcpjson'
import type {
  ApiSession,
  AttachmentUpload,
  LimitsSnapshot,
  ClaudeDirInfo,
  ChatMessage,
  CommandContent,
  CompletionKey,
  DirListing,
  FileEntry,
  ImageRefEntry,
  MediaItem,
  ErrorKind,
  ErrorRecord,
  FileCompletionEntry,
  FilePreview,
  GhAvailability,
  IdeDiagnostic,
  SlashCommand,
  SubagentTranscript,
  TaskOutputTail,
  Tag,
  TagRule,
  PermissionMode,
  OrbitalModel,
  ModelValidation,
  McpMutationResult,
  McpServerDefinition,
  McpServerRow,
  SessionStatsDetail,
  StatsOverview,
  StatsWindow,
  Walkthrough,
  WalkthroughSummary,
  HarnessTemplate,
  HarnessTemplateBody,
  HarnessProject,
  KnownHarnessProject,
  DraftModel,
  SessionHarness,
  HarnessEvent,
  HarnessOptions,
  JoinAnswer,
  PairConfirmError,
  PairConfirmResult,
  RemoteStatus,
  NotPrimary,
  SessionDefaults,
} from './types'
import { markUnauthorized } from './unauthorized'
import {
  parseServerUpdateState,
  SERVER_UPDATE_REFUSALS,
  type ServerUpdateRefusal,
  type ServerUpdateState,
} from '@orbital/shared/remote/serverUpdate'
import type { TerminalInfo } from '../terminal/types'

/**
 * What a send answers. `uuid` is the transcript entry the turn is written
 * under — the client puts it on its optimistic copy, which is what makes a
 * just-sent turn pickable for a rewind; `rewind` says the send was a pending
 * rewind's (spec 2026-09-29-rewind-design § As built).
 */
export interface SendResult {
  ok: boolean
  revived?: boolean
  uuid?: string | null
  rewind?: true
}

/** What a typed project directory is on the Mac (`GET /api/directory`). */
export type DirectoryState = 'directory' | 'missing' | 'not_a_directory' | 'not_absolute'

export interface SessionListParams {
  tags?: number[]
  q?: string
  source?: string
  limit?: number
  offset?: number
  /** The ENDED fold (unpinned ended sessions): left out, or alone. Absent, everything. */
  ended?: 'exclude' | 'only'
}

/** The ENDED fold `ended: 'exclude'` left out: how many, capped by the page, and the newest one's `lastAt`. */
export interface EndedSummary {
  count: number
  latestAt: number | null
}

export interface SessionListPage {
  sessions: ApiSession[]
  /** Only with `ended: 'exclude'`, and only from a Mac that knows the parameter. */
  ended?: EndedSummary
}

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

/**
 * An `/api` path with every interpolated value encoded as one whole segment.
 * Ids reach the web app from other devices of the group (a member's session
 * ids, tag ids, refs), so none may add a segment, a query or a fragment. A
 * value that is empty or a dot segment would still move the path, and is
 * refused.
 */
export function apiPath(strings: TemplateStringsArray, ...values: (string | number)[]): string {
  let out = strings[0]
  values.forEach((value, i) => {
    const segment = String(value)
    if (segment === '' || segment === '.' || segment === '..') throw new ApiError(`invalid path segment: ${JSON.stringify(segment)}`, 400)
    out += encodeURIComponent(segment) + strings[i + 1]
  })
  return out
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** The browser's own `fetch`, read at call time so a test's stubbed global still applies. */
export const defaultApiFetch: FetchLike = (input, init) => fetch(input, init)

/** What `api.uploadAttachment` does — swappable because the phone has no multipart route. */
export type UploadLike = (
  sessionId: string | null,
  file: File,
  opts?: { signal?: AbortSignal }
) => Promise<AttachmentUpload>

let fetchImpl: FetchLike = defaultApiFetch
let uploadImpl: UploadLike | null = null
let subagentPageSize: number | null = null
let taskOutputMaxBytes: number | null = null

/**
 * Replaces the transport every call in this file goes through. The phone
 * passes `tunnelFetch`, which carries `/api/...` over the relay, and an
 * `upload` that carries an attachment's bytes as a blob instead of a
 * multipart POST (spec 2026-10-02-mobile-app-design §§ 3, 6.2); the desktop
 * never calls this. Each option is applied only when given; `upload: null`
 * restores the multipart POST. Call it before the first request.
 *
 * `subagentPageSize` and `taskOutputMaxBytes` bound two reads that can
 * outgrow one relay frame: `subagentMessages` then asks for the newest that
 * many messages (`?limit=`) and `taskOutput` for at most that many bytes
 * (`?maxBytes=`) (spec 2026-10-05-mobile-next-design § 3). Null takes the
 * bound off again.
 */
export function configureApi(opts: {
  fetch?: FetchLike
  upload?: UploadLike | null
  subagentPageSize?: number | null
  taskOutputMaxBytes?: number | null
}): void {
  if (opts.fetch) fetchImpl = opts.fetch
  if (opts.upload !== undefined) uploadImpl = opts.upload
  if (opts.subagentPageSize !== undefined) subagentPageSize = opts.subagentPageSize
  if (opts.taskOutputMaxBytes !== undefined) taskOutputMaxBytes = opts.taskOutputMaxBytes
}

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const transport = fetchImpl
  const response = await transport(input, init)
  // The page lacks the API token: the entry point swaps the app for the one
  // screen that says how to get it (spec
  // 2026-10-03-api-token-and-named-files-design). Only on the port's own
  // transport — the phone's tunnel carries the token in-process, and a 401
  // through it means something else.
  if (response.status === 401 && transport === defaultApiFetch) markUnauthorized()
  return response
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

  const response = await apiFetch(url, options)

  if (!response.ok) {
    const text = await response.text()
    throw new ApiError(text || response.statusText, response.status, url)
  }

  // No Content has no body to parse; the caller typed it `void`.
  if (response.status === 204) return undefined as T

  const data = await response.json()
  return data as T
}

/**
 * One file viewer read: the bytes, or the refusal the server answered with
 * as a value. Only a refusal it does not name throws.
 */
async function readPreview(requestUrl: string): Promise<FilePreview> {
  const response = await apiFetch(requestUrl, { method: 'GET' })

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
}

/** `?session=<id>` or `?cwd=<dir>` — never both (the server reads one). */
function applyCompletionKey(url: URL, key: CompletionKey): void {
  if ('session' in key) url.searchParams.set('session', key.session)
  else {
    url.searchParams.set('cwd', key.cwd)
    if (key.claudeDir !== undefined) url.searchParams.set('claudeDir', String(key.claudeDir))
    if (key.machine !== undefined) url.searchParams.set('machine', key.machine)
  }
}

// Sessions API
export const api = {
  async listSessions(params?: SessionListParams): Promise<ApiSession[]> {
    return (await api.listSessionPage(params)).sessions
  },

  /**
   * `listSessions` with the whole answer: with `ended: 'exclude'`, the Mac
   * leaves the unpinned ended sessions out and says what `ended: 'only'`
   * would return in `ended`. A Mac from before the parameter ignores it,
   * answers with every session and no `ended`.
   */
  async listSessionPage(params?: SessionListParams): Promise<SessionListPage> {
    const url = new URL('/api/sessions', window.location.origin)
    if (params?.tags !== undefined && params.tags.length > 0) url.searchParams.set('tag', params.tags.join(','))
    if (params?.q !== undefined) url.searchParams.set('q', params.q)
    if (params?.source !== undefined) url.searchParams.set('source', params.source)
    if (params?.limit !== undefined) url.searchParams.set('limit', String(params.limit))
    if (params?.offset !== undefined) url.searchParams.set('offset', String(params.offset))
    if (params?.ended !== undefined) url.searchParams.set('ended', params.ended)

    return request<SessionListPage>('GET', url.pathname + url.search)
  },

  async getSession(id: string): Promise<{ session: ApiSession }> {
    return request<{ session: ApiSession }>('GET', apiPath`/api/sessions/${id}`)
  },

  async getMessages(
    id: string,
    opts?: { before?: string; limit?: number }
  ): Promise<ChatMessage[]> {
    const url = new URL(apiPath`/api/sessions/${id}/messages`, window.location.origin)
    if (opts?.before !== undefined) url.searchParams.set('before', opts.before)
    if (opts?.limit !== undefined) url.searchParams.set('limit', String(opts.limit))

    const data = await request<{ messages: ChatMessage[] }>('GET', url.pathname + url.search)
    return data.messages
  },

  /**
   * Every image and PDF of the session, oldest first (spec
   * 2026-10-09-session-media-design § Data). References only — the bytes
   * come through the image store and `/api/files/image`.
   */
  async sessionMedia(id: string): Promise<MediaItem[]> {
    const data = await request<{ items: MediaItem[] }>('GET', apiPath`/api/sessions/${id}/media`)
    return data.items
  },

  async getWalkthrough(id: string): Promise<{ session: ApiSession; walkthrough: Walkthrough }> {
    return request('GET', apiPath`/api/sessions/${id}/walkthrough`)
  },

  async walkthroughSummary(id: string): Promise<WalkthroughSummary> {
    return request('GET', apiPath`/api/sessions/${id}/walkthrough/summary`)
  },

  /**
   * Starts the narrate query and returns before it runs (spec
   * 2026-09-30-narrate-out-of-band-design § The query); the page hears it
   * land as `walkthrough_narration` on the session's topic.
   */
  async narrateWalkthrough(id: string): Promise<{ ok: boolean }> {
    return request('POST', apiPath`/api/sessions/${id}/walkthrough/narrate`, {})
  },

  /**
   * A subagent's own transcript — the panel's read (spec:
   * 2026-09-22-subagent-transcript-panel-design.md § 9). 404s when
   * `toolUseId` names no agent the server's `SubagentStore` knows for this
   * session (STREAM LOST — a server restart, most likely); a known agent
   * with nothing buffered yet still 200s with an empty list, because it is
   * simply running with nothing to show yet, not lost.
   */
  async subagentMessages(id: string, toolUseId: string): Promise<SubagentTranscript> {
    const limit = subagentPageSize === null ? '' : `?limit=${subagentPageSize}`
    return request<SubagentTranscript>('GET', apiPath`/api/sessions/${id}/subagents/${toolUseId}/messages` + limit)
  },

  /**
   * Stops one background task or subagent by its SDK task id (spec
   * 2026-09-28-background-tasks-design § 2, Stop). 204 once the stop is
   * sent; the task ends when the SDK confirms, on the sessions topic. 409
   * for a task that already ended, 404 for one the session does not know.
   */
  async stopTask(id: string, taskId: string): Promise<void> {
    return request<void>('POST', apiPath`/api/sessions/${id}/tasks/${taskId}/stop`)
  },

  /**
   * The user's own shells of a session (spec 2026-10-05-embedded-terminal-design
   * § Routes), running and exited, in the order they were opened.
   */
  async listTerminals(sessionId: string): Promise<TerminalInfo[]> {
    const data = await request<{ terminals: TerminalInfo[] }>('GET', apiPath`/api/sessions/${sessionId}/terminals`)
    return data.terminals
  },

  /** A new shell in the session's folder. 409 `cwd_missing` when the folder is gone. */
  async openTerminal(sessionId: string, size?: { cols: number; rows: number }): Promise<TerminalInfo> {
    return request<TerminalInfo>('POST', apiPath`/api/sessions/${sessionId}/terminals`, size ?? {})
  },

  /** A new shell in an exited terminal's tab, its scrollback kept. 409 while the old one runs. */
  async restartTerminal(id: string, size?: { cols: number; rows: number }): Promise<TerminalInfo> {
    return request<TerminalInfo>('POST', apiPath`/api/terminals/${id}/restart`, size ?? {})
  },

  /** Ends the shell, and everything started in it, and forgets the tab. */
  async closeTerminal(id: string): Promise<void> {
    await request<{ ok: true }>('DELETE', apiPath`/api/terminals/${id}`)
  },

  /**
   * A shell's or monitor's output tail and the byte range it covers (spec
   * § 4). 410 when the file no longer exists.
   */
  async taskOutput(id: string, taskId: string): Promise<TaskOutputTail> {
    const bound = taskOutputMaxBytes === null ? '' : `?maxBytes=${taskOutputMaxBytes}`
    return request<TaskOutputTail>('GET', apiPath`/api/sessions/${id}/tasks/${taskId}/output` + bound)
  },

  /**
   * The three desktop settings the phone's New Session screen preselects
   * from (spec 2026-10-02-mobile-app-design § 6.4) — one narrow route, so the
   * phone never needs the whole settings surface.
   */
  /** `machine`: that member's defaults (the phone's New session on a chosen device); its Claude directory ids are its own. */
  async sessionDefaults(machine?: string): Promise<SessionDefaults> {
    return request<SessionDefaults>(
      'GET',
      machine === undefined ? '/api/sessions/defaults' : `/api/sessions/defaults?${new URLSearchParams({ machine })}`,
    )
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
    /** Ask the route to check `cwd` is an existing directory before launching.
     * The phone sends true and gets 400 `no_such_directory` back for a path
     * that is not one (spec 2026-10-02-mobile-app-design § 6.4). */
    requireDirectory?: boolean
    /** The Claude directory to run under (spec 2026-10-04-multiple-claude-directories-design § 3).
     * Omitted, the server uses its default; it remembers a sent one for the next prefill. */
    claudeDirId?: number
    /** The answer to the `.mcp.json` question, recorded before the launch. Omitted, the
     * Mac keeps every undecided server out (spec 2026-10-08-mcpjson-approval-design). */
    mcpjson?: McpjsonDecisions
    /** The member the session runs on (device federation); omitted, this device. */
    machine?: string
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
  ): Promise<SendResult> {
    return request<SendResult>(
      'POST',
      apiPath`/api/sessions/${id}/messages`,
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
   *
   * The phone has no multipart route — the tunnel carries JSON frames, not
   * `FormData` — so it configures an `upload` (`configureApi`) and every
   * upload goes there instead, answering the same contract (spec
   * 2026-10-02-mobile-app-design §§ 3, 6.2).
   */
  async uploadAttachment(
    sessionId: string | null,
    file: File,
    opts?: { signal?: AbortSignal }
  ): Promise<AttachmentUpload> {
    if (uploadImpl) return uploadImpl(sessionId, file, opts)
    const url = sessionId === null ? '/api/attachments' : apiPath`/api/sessions/${sessionId}/attachments`
    const body = new FormData()
    body.append('file', file, file.name)

    const response = await apiFetch(url, { method: 'POST', body, signal: opts?.signal })

    if (response.ok) {
      return { kind: 'ok', entry: (await response.json()) as ImageRefEntry | FileEntry }
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
    if (response.status === 422 && parsed.error === 'attachment_not_on_device') return { kind: 'not_on_device' }

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
    return request<{ ok: boolean }>('POST', apiPath`/api/sessions/${id}/decision/${decisionId}`, {
      answers,
    })
  },

  /**
   * Settles a parked permission prompt or plan approval — the same endpoint
   * as `answerDecision`, with the body the other two kinds take (spec
   * 2026-09-23-permission-and-plan-decisions-design § Channel). `message` is
   * what the model reads back from a refusal; a bare decline sends none.
   *
   * 404 means the same thing here as it does there: the decision is gone.
   */
  async resolveDecision(
    id: string,
    decisionId: string,
    verdict: { approved: boolean; message?: string }
  ): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      'POST',
      apiPath`/api/sessions/${id}/decision/${decisionId}`,
      verdict
    )
  },

  async interrupt(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', apiPath`/api/sessions/${id}/interrupt`)
  },

  /**
   * Picks a rewind target (spec 2026-09-29-rewind-design § API): the server
   * stops a live session itself, stores the pending rewind and answers with
   * the picked message's text for the composer. `draft` is what the composer
   * held before the pick, handed back by a Cancel.
   */
  async startRewind(
    id: string,
    body: { uuid: string; hiddenCount: number; draft: string },
  ): Promise<{ text: string }> {
    return request<{ text: string }>('POST', apiPath`/api/sessions/${id}/rewind`, body)
  },

  /** Cancels the pending rewind; answers with the draft the pick replaced. */
  async cancelRewind(id: string): Promise<{ draft: string }> {
    return request<{ draft: string }>('DELETE', apiPath`/api/sessions/${id}/rewind`)
  },

  /**
   * Ends the session — stamps `ended_at` and stops any process, the same call
   * `/clear` makes, without the follow-on. `unpin` clears the pin in the same
   * write: the trash's drop of a pinned session, which as two requests showed
   * the map an ended-but-pinned row in between.
   */
  async endSession(id: string, opts: { unpin?: boolean } = {}): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      'POST',
      apiPath`/api/sessions/${id}/end`,
      opts.unpin ? { unpin: true } : undefined,
    )
  },

  /**
   * Takes back an End — the trash's Undo (spec
   * 2026-09-24-sessions-end-only-by-hand-design § 3). The session comes back
   * `idle`; the server refuses a terminal session (409).
   */
  async reopenSession(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', apiPath`/api/sessions/${id}/reopen`)
  },

  /**
   * The running session's MCP servers (spec
   * 2026-10-01-mcp-servers-in-the-session-design § Routes). 409 when the
   * session has no process — the dialog's asleep note — and 504 when it does
   * not answer in time.
   */
  async mcpServers(id: string): Promise<{ servers: McpServerRow[] }> {
    return request('GET', apiPath`/api/sessions/${id}/mcp`)
  },

  /**
   * Starts a server's login and answers the page to open in the browser
   * (spec § Log in). 400 `not_loginable`, 502 `login_unsupported` with the
   * SDK's message.
   */
  async mcpLogin(id: string, name: string): Promise<{ authUrl: string }> {
    return request('POST', apiPath`/api/sessions/${id}/mcp/${name}/login`)
  },

  async reconnectMcpServer(id: string, name: string): Promise<{ servers: McpServerRow[] }> {
    return request('POST', apiPath`/api/sessions/${id}/mcp/${name}/reconnect`)
  },

  /** Holds for the whole project, terminal sessions included (adr the-mcp-toggle-is-project-wide). */
  async setMcpServerEnabled(id: string, name: string, enabled: boolean): Promise<{ servers: McpServerRow[] }> {
    return request('POST', apiPath`/api/sessions/${id}/mcp/${name}/enabled`, { enabled })
  },

  async mcpServerConfig(id: string, name: string): Promise<McpServerDefinition> {
    return request('GET', apiPath`/api/sessions/${id}/mcp/${name}/config`)
  },

  /**
   * Add, edit and remove go through the CLI: 503 when it is missing, 502 when
   * it refuses — the body then carries its output and the masked command.
   */
  async addMcpServer(id: string, server: McpServerDefinition): Promise<McpMutationResult> {
    return request('POST', apiPath`/api/sessions/${id}/mcp`, server)
  },

  /** `name` is the server's current name; a rename is `server.name`. */
  async updateMcpServer(id: string, name: string, server: McpServerDefinition): Promise<McpMutationResult> {
    return request('PUT', apiPath`/api/sessions/${id}/mcp/${name}`, server)
  },

  async removeMcpServer(id: string, name: string): Promise<McpMutationResult> {
    return request('DELETE', apiPath`/api/sessions/${id}/mcp/${name}`)
  },

  /** The restart banner's Restart: the transcript is kept. 409 while a turn runs or a decision is pending. */
  async restartMcpSession(id: string): Promise<{ servers: McpServerRow[] }> {
    return request('POST', apiPath`/api/sessions/${id}/mcp/restart`)
  },

  /**
   * `carryHarness` (with `startNew`): the new session takes the old one's
   * harness and is sent its current step; `harnessCarried` says whether it did.
   */
  async clearSession(
    id: string, startNew: boolean, opts: { carryHarness?: boolean } = {},
  ): Promise<{ ok: boolean; sessionId?: string; harnessCarried?: boolean }> {
    return request('POST', apiPath`/api/sessions/${id}/clear`, {
      startNew,
      ...(opts.carryHarness ? { carryHarness: true } : {}),
    })
  },

  async renameSession(id: string, title: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PATCH', apiPath`/api/sessions/${id}`, { title })
  },

  /**
   * Names the session from its own contents, now. `changed: false` is the
   * model answering that the name it already has still fits — a result, not
   * a failure, and the only reason this returns anything the caller reads.
   *
   * The new title arrives over the `sessions` topic like any other change, so
   * there is nothing here to write into the store.
   */
  async retitleSession(id: string): Promise<{ title: string; changed: boolean }> {
    return request<{ title: string; changed: boolean }>('POST', apiPath`/api/sessions/${id}/retitle`)
  },

  async setSessionTags(id: string, tagIds: number[]): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PUT', apiPath`/api/sessions/${id}/tags`, { tagIds })
  },

  /** The pin — keeps an ended session on the map; `false` unpins. */
  async setSessionPinned(id: string, pinned: boolean): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PUT', apiPath`/api/sessions/${id}/pinned`, { pinned })
  },

  /** The whole index's session count — the hole's label; the list endpoint only ever returns a page. */
  async sessionCount(): Promise<number> {
    const data = await request<{ total: number }>('GET', '/api/sessions/count')
    return data.total
  },

  // Tags API
  /** This device's tags, or `machine`'s — with that device's own ids. */
  async listTags(machine?: string): Promise<Tag[]> {
    const data = await request<{ tags: Tag[] }>(
      'GET',
      machine ? `/api/tags?machine=${encodeURIComponent(machine)}` : '/api/tags',
    )
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
    return request<{ ok: boolean }>('PATCH', apiPath`/api/tags/${id}`, body)
  },

  async deleteTag(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('DELETE', apiPath`/api/tags/${id}`)
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
    return request<{ ok: boolean }>('PATCH', apiPath`/api/tag-rules/${id}`, body)
  },

  async deleteTagRule(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('DELETE', apiPath`/api/tag-rules/${id}`)
  },

  async previewRule(body: {
    cwd: string
    title: string
    permissionMode: string | null
    /** Another device of the group, whose rules answer; its tag and rule ids are its own. */
    machine?: string
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
  //
  // `cwd` is the one the transcript entry the path came from was written in
  // (spec 2026-10-07-live-working-tree-design § 4); without it the server
  // tries the session's current tree, then its home.
  async filePreview(sessionId: string, path: string, cwd?: string): Promise<FilePreview> {
    const url = new URL('/api/files', window.location.origin)
    url.searchParams.set('session', sessionId)
    url.searchParams.set('path', path)
    if (cwd) url.searchParams.set('cwd', cwd)
    return readPreview(url.pathname + url.search)
  },

  /**
   * The undecided servers of a project's `.mcp.json`, for the New session
   * question (spec 2026-10-08-mcpjson-approval-design). Through the relay on
   * the phone.
   */
  async mcpjson(cwd: string, claudeDirId?: number, machine?: string): Promise<McpjsonServer[]> {
    const params = new URLSearchParams({ cwd })
    if (claudeDirId !== undefined) params.set('claudeDirId', String(claudeDirId))
    if (machine !== undefined) params.set('machine', machine)
    const data = await request<{ undecided: McpjsonServer[] }>('GET', `/api/mcpjson?${params}`)
    return data.undecided
  },

  /**
   * What a typed project directory is on the Mac, `~` expanded (spec
   * 2026-10-12-new-session-missing-directory-design § Server); on the member
   * `machine` names, when it names one.
   */
  async directoryState(path: string, machine?: string): Promise<{ path: string; state: DirectoryState }> {
    const params = new URLSearchParams({ path })
    if (machine !== undefined) params.set('machine', machine)
    return request<{ path: string; state: DirectoryState }>('GET', `/api/directory?${params}`)
  },

  /**
   * One level of a device's folders: no path is home. `machine` names the
   * member whose folders they are; absent, this device's.
   */
  async listDirs(path?: string, machine?: string): Promise<DirListing> {
    const params = new URLSearchParams()
    if (path !== undefined) params.set('path', path)
    if (machine !== undefined) params.set('machine', machine)
    const query = params.toString()
    return request<DirListing>('GET', query ? `/api/dirs?${query}` : '/api/dirs')
  },

  /** Creates a missing project directory and its parents; answers the expanded path. */
  async createDirectory(path: string, machine?: string): Promise<{ path: string }> {
    return request<{ path: string }>('POST', '/api/directory', machine === undefined ? { path } : { path, machine })
  },

  /**
   * The project file an undecided `.mcp.json` server runs, for the
   * question's *View file*: there is no session to read it through yet, so
   * the Mac reads the one file `.mcp.json` names for `server`.
   */
  async mcpjsonFile(cwd: string, server: string, machine?: string): Promise<FilePreview> {
    const params = new URLSearchParams({ cwd, server })
    if (machine !== undefined) params.set('machine', machine)
    return readPreview(`/api/mcpjson/file?${params}`)
  },

  // IDE bridge — the two calls that talk back to the editor (spec:
  // 2026-09-23-ide-bridge-design § Talking back to the editor). Both answer
  // `404` for every kind of "no editor", and both read that as a value
  // rather than an error: the whole feature is optional, and a missing
  // editor must never raise a toast.

  /**
   * Reveals a path in the editor covering this session's workspace. `false`
   * when there was no editor to reveal it in — which is the ordinary state
   * of a machine, not a failure worth reporting.
   */
  async ideOpenFile(sessionId: string, path: string, line: number | null): Promise<boolean> {
    const response = await apiFetch(apiPath`/api/sessions/${sessionId}/ide/open-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ...(line !== null ? { line } : {}) }),
    })
    if (response.status === 404) return false
    if (!response.ok) {
      throw new ApiError(await response.text(), response.status, '/ide/open-file')
    }
    return true
  },

  /**
   * The editor's own findings, for one file or for the whole workspace, or
   * null when no editor covers the session.
   */
  async ideDiagnostics(sessionId: string, path?: string): Promise<IdeDiagnostic[] | null> {
    const url = new URL(apiPath`/api/sessions/${sessionId}/ide/diagnostics`, window.location.origin)
    if (path) url.searchParams.set('path', path)
    const response = await apiFetch(url.pathname + url.search)
    if (response.status === 404) return null
    if (!response.ok) return null
    const data = (await response.json()) as { diagnostics: IdeDiagnostic[] }
    return data.diagnostics
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

  /** One command's file for the skill viewer (spec:
   * 2026-09-30-skill-preview-design). Null when the catalog has no file for
   * the name — a built-in, or a skill removed since the catalog was read. */
  async commandContent(key: CompletionKey, name: string): Promise<CommandContent | null> {
    const url = new URL('/api/commands/content', window.location.origin)
    applyCompletionKey(url, key)
    url.searchParams.set('name', name)
    try {
      return await request<CommandContent>('GET', url.pathname + url.search)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null
      throw err
    }
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
  /**
   * `lastAt` is the newest session's `lastAt` in that directory — the phone's
   * 9d rows read it as its last use. `machine` asks that member for its own.
   */
  async listProjects(machine?: string): Promise<Array<{ cwd: string; lastModel: string | null; lastAt: number | null }>> {
    const data = await request<{
      projects: Array<{ cwd: string; lastModel: string | null; lastAt: number | null }>
    }>('GET', machine === undefined ? '/api/projects' : `/api/projects?${new URLSearchParams({ machine })}`)
    return data.projects
  },

  // Models API
  /** One Claude directory's catalog (each account has its own models); the default directory's without one. */
  async listModels(
    claudeDir?: number,
    machine?: string,
  ): Promise<{ models: OrbitalModel[]; contextWindows: Record<string, number> }> {
    const params = new URLSearchParams()
    if (claudeDir !== undefined) params.set('claudeDir', String(claudeDir))
    if (machine !== undefined) params.set('machine', machine)
    const query = params.toString()
    const data = await request<{ models: OrbitalModel[]; contextWindows?: Record<string, number> }>(
      'GET',
      query ? `/api/models?${query}` : '/api/models',
    )
    return { models: data.models, contextWindows: data.contextWindows ?? {} }
  },

  async setSessionModel(id: string, model: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', apiPath`/api/sessions/${id}/model`, { model })
  },

  async setSessionPermissionMode(id: string, mode: PermissionMode): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', apiPath`/api/sessions/${id}/permission-mode`, { mode })
  },

  /** Probes a model id the catalog does not list. An id Claude Code rejects is `ok: false`, not a throw. */
  async validateModel(model: string, claudeDir?: number): Promise<ModelValidation> {
    // Checked under the account the session would run under; absent, the default directory's.
    return request<ModelValidation>('POST', '/api/models/validate', claudeDir === undefined ? { model } : { model, claudeDir })
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

  // Stats API — the dashboard's one read (spec:
  // 2026-09-20-session-stats-design § API). Every panel on `/stats` is fed by
  // this single response, because the filters apply to all of them and two
  // requests could answer from two different windows.
  //
  // `project` and `model` are omitted when they are null: the server reads an
  // empty string as "no filter" too, but sending one puts a parameter in the
  // request that names nothing.
  async statsOverview(params: {
    window: StatsWindow
    project?: string | null
    model?: string | null
  }): Promise<StatsOverview> {
    const url = new URL('/api/stats/overview', window.location.origin)
    url.searchParams.set('window', params.window)
    if (params.project) url.searchParams.set('project', params.project)
    if (params.model) url.searchParams.set('model', params.model)
    return request<StatsOverview>('GET', url.pathname + url.search)
  },

  /** The stored rollup, the cost split and the findings. The turn timeline is
   * a full-transcript reparse on the server, so only the surfaces that draw the
   * waterfall pass `{ timeline: true }`; without it `turns` comes back empty
   * (ADR `the-stats-row-reads-when-the-stats-are-written`). 404s for a session
   * the index never saw. */
  async sessionStats(
    id: string,
    opts: { timeline?: boolean } = {}
  ): Promise<SessionStatsDetail> {
    const query = opts.timeline ? '?timeline=1' : ''
    return request<SessionStatsDetail>('GET', apiPath`/api/stats/sessions/${id}` + query)
  },

  // Claude directories (spec 2026-10-04-multiple-claude-directories-design § 6).
  // Mac only: none of these is on the phone's allowlist. A refused change
  // comes back as `{ error }`, a state the Settings row words, not a throw.
  async listClaudeDirs(): Promise<ClaudeDirInfo[]> {
    const data = await request<{ claudeDirs: ClaudeDirInfo[] }>('GET', '/api/claude-dirs')
    return data.claudeDirs
  },

  async addClaudeDir(body: { name: string; path: string }): Promise<{ claudeDir: ClaudeDirInfo } | { error: ClaudeDirRefusal }> {
    return remoteCall('POST', '/api/claude-dirs', body, CLAUDE_DIR_REFUSALS)
  },

  async updateClaudeDir(
    id: number,
    body: { name?: string; path?: string },
  ): Promise<{ claudeDir: ClaudeDirInfo } | { error: ClaudeDirRefusal }> {
    return remoteCall('PATCH', apiPath`/api/claude-dirs/${id}`, body, CLAUDE_DIR_REFUSALS)
  },

  async removeClaudeDir(id: number): Promise<void | { error: ClaudeDirRefusal }> {
    return remoteCall('DELETE', apiPath`/api/claude-dirs/${id}`, undefined, CLAUDE_DIR_REFUSALS)
  },

  // Plan limits (spec 2026-10-03-usage-limits-design § 2 "Transport")
  /** The cached answer, its read time and the current waits. */
  async getLimits(): Promise<LimitsSnapshot> {
    return request<LimitsSnapshot>('GET', '/api/limits')
  },

  /** "Read again": a fresh read, answered with the snapshot it produced. */
  async refreshLimits(): Promise<LimitsSnapshot> {
    return request<LimitsSnapshot>('POST', '/api/limits/refresh')
  },

  /** Cancel this wait's auto-continue; the reset time stays. */
  async cancelLimitWait(id: string): Promise<void> {
    await request<unknown>('POST', apiPath`/api/sessions/${id}/limit-wait/cancel`)
  },

  /** Undo a Cancel, until the reset. */
  async undoLimitWait(id: string): Promise<void> {
    await request<unknown>('POST', apiPath`/api/sessions/${id}/limit-wait/undo`)
  },

  // Settings API
  async getSettings(): Promise<Record<string, string>> {
    return request<Record<string, string>>('GET', '/api/settings')
  },

  async patchSettings(partial: Record<string, string>): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('PATCH', '/api/settings', partial)
  },

  /**
   * Orbital's tips for Settings › Sessions › INSTRUCTIONS. Fetched from the
   * server rather than bundled, so the preview shows what the running
   * server appends (spec 2026-09-30-session-instructions-design § 4).
   */
  async getSessionInstructionTips(): Promise<{ tips: SessionTip[] }> {
    return request<{ tips: SessionTip[] }>('GET', '/api/session-instructions/tips')
  },

  /**
   * Facts about how the server was started, for Settings → General. Not
   * settings: nothing writes them, and they would be stale the moment the
   * server restarted with a different environment. Fetched when the section
   * is opened rather than held in the store, because that is the only place
   * that reads them.
   */
  async getHealth(): Promise<ServerHealth> {
    return request<ServerHealth>('GET', '/api/health')
  },

  /**
   * Whether `gh` can answer for the PR switch in Settings → Appearance, and
   * if not, why (spec 2026-09-30-branch-pr-and-line-changes-design §
   * Settings). Asked when Settings opens and when the app regains focus.
   */
  async ghStatus(): Promise<{ status: GhAvailability }> {
    return request<{ status: GhAvailability }>('GET', '/api/gh-status')
  },

  /**
   * The app regained focus: the server looks again at the PR and the lines of
   * every working tree a window has open. Answers at once; the readings arrive
   * as session upserts.
   */
  async refreshBranchStatus(): Promise<{ ok: true }> {
    return request<{ ok: true }>('POST', '/api/branch-status/refresh')
  },

  /**
   * How many sessions a retention policy would remove, asked before it is
   * saved. Runs the sweep's own predicate server-side, so the number the
   * confirmation names is the number the delete will take.
   */
  async previewRetention(days: string): Promise<{ count: number }> {
    return request<{ count: number }>(
      'GET',
      `/api/sessions/retention-preview?days=${encodeURIComponent(days)}`,
    )
  },

  // Harness API (spec 2026-10-02-harness-redesign-design § As built (server))
  /**
   * Every template, or one scope's (`{ scope: 'global' }`, `{ project: root }`),
   * drafts included and marked — Settings' list and filter.
   */
  async listHarnessTemplates(filter: { scope?: 'global'; project?: string } = {}): Promise<{ templates: HarnessTemplate[] }> {
    const q = filter.scope === 'global' ? '?scope=global'
      : filter.project ? `?project=${encodeURIComponent(filter.project)}` : ''
    return request('GET', `/api/harness/templates${q}`)
  },

  /** What the start view offers a session: its project's saved templates first, then global ones. */
  async listHarnessTemplatesForSession(sessionId: string): Promise<{
    project: HarnessProject | null
    templates: HarnessTemplate[]
  }> {
    return request('GET', `/api/harness/templates?sessionId=${encodeURIComponent(sessionId)}`)
  },

  /** Projects sessions ran in and templates belong to, newest first. */
  async listHarnessProjects(): Promise<{ projects: KnownHarnessProject[] }> {
    return request('GET', '/api/harness/projects')
  },

  async createHarnessTemplate(body: HarnessTemplateBody): Promise<HarnessTemplate> {
    return request('POST', '/api/harness/templates', body)
  },

  /** Save: clears the draft mark (unless `draft: true`); a `scope` moves it, absent keeps it. */
  async updateHarnessTemplate(id: number, body: HarnessTemplateBody): Promise<HarnessTemplate> {
    return request('PUT', apiPath`/api/harness/templates/${id}`, body)
  },

  /** A saved copy, "(copy)" after the name; into `scope` when given. */
  async duplicateHarnessTemplate(id: number, scope?: HarnessTemplateBody['scope']): Promise<HarnessTemplate> {
    return request('POST', apiPath`/api/harness/templates/${id}/duplicate`, scope ? { scope } : {})
  },

  async deleteHarnessTemplate(id: number): Promise<void> {
    return request('DELETE', apiPath`/api/harness/templates/${id}`)
  },

  /** A model's draft of a template, not saved (spec 2026-09-30-assisted-harness-templates-design). Opus by default. */
  async draftHarnessTemplate(body: { description?: string; sessionId?: string; model?: DraftModel }): Promise<{
    template: Pick<HarnessTemplate, 'name' | 'description' | 'tags' | 'inputs' | 'steps'> & { options?: Partial<HarnessOptions> }
  }> {
    return request('POST', '/api/harness/templates/draft', body)
  },

  async getHarnessInterviewPrompt(): Promise<{ prompt: string }> {
    return request('GET', '/api/harness/interview')
  },

  /**
   * "Draft in a conversation": the server starts the session (marked
   * `purpose: 'harness_draft'`) and saves its template as a draft into
   * `scope`. `cwd` defaults to the scope's project; a global scope needs one.
   */
  async startHarnessInterview(body: {
    cwd?: string
    permissionMode?: PermissionMode
    model?: DraftModel
    scope?: HarnessTemplateBody['scope']
    /** What the user typed about the work; the interview starts from it. */
    description?: string
    /** Browser-minted v4 UUID, so the caller can subscribe before the launch (as `createSession`). */
    sessionId?: string
  }): Promise<{ sessionId: string }> {
    return request('POST', '/api/harness/interview', body)
  },

  /**
   * The live harness, the removed one (kept for its records), and the log
   * newest first. `limit` up to 2000; `before` an event id, for the next page.
   */
  async getSessionHarness(sessionId: string, page: { limit?: number; before?: number } = {}): Promise<{
    harness: SessionHarness | null
    removed: SessionHarness | null
    events: HarnessEvent[]
  }> {
    const params = new URLSearchParams()
    if (page.limit !== undefined) params.set('limit', String(page.limit))
    if (page.before !== undefined) params.set('before', String(page.before))
    const q = params.toString() ? `?${params}` : ''
    return request('GET', apiPath`/api/sessions/${sessionId}/harness` + q)
  },

  /** "Go back here", the checklist side: the step and the later ones keep their records as previous runs. */
  async goBackHarnessStep(sessionId: string, index: number): Promise<{ harness: SessionHarness }> {
    return request('POST', apiPath`/api/sessions/${sessionId}/harness/steps/${index}/go-back`)
  },

  /** "Decide myself": stops a running review; the gate waits for the user. */
  async decideHarnessStepMyself(sessionId: string, index: number): Promise<{ harness: SessionHarness }> {
    return request('POST', apiPath`/api/sessions/${sessionId}/harness/steps/${index}/decide-myself`)
  },

  /** Carries another session's harness into this one and sends it the current step. */
  async carryHarness(sessionId: string, fromSessionId: string): Promise<{ harness: SessionHarness }> {
    return request('POST', apiPath`/api/sessions/${sessionId}/harness/carry`, { fromSessionId })
  },

  async attachHarness(
    sessionId: string,
    templateId: number,
    inputs: Record<string, string>,
  ): Promise<{ harness: SessionHarness }> {
    return request('POST', apiPath`/api/sessions/${sessionId}/harness`, { templateId, inputs })
  },

  async removeHarness(sessionId: string): Promise<void> {
    return request('DELETE', apiPath`/api/sessions/${sessionId}/harness`)
  },

  async setHarnessPaused(sessionId: string, paused: boolean): Promise<{ harness: SessionHarness }> {
    return request('PATCH', apiPath`/api/sessions/${sessionId}/harness`, { paused })
  },

  async setHarnessOptions(sessionId: string, options: Partial<HarnessOptions>): Promise<{ harness: SessionHarness }> {
    return request('PATCH', apiPath`/api/sessions/${sessionId}/harness`, { options })
  },

  async getHarnessStepDiff(
    sessionId: string,
    index: number,
  ): Promise<{ range: string; stat: string; patch: string; commits: number | null; pushed: boolean | null }> {
    return request('GET', apiPath`/api/sessions/${sessionId}/harness/steps/${index}/diff`)
  },

  async approveHarnessStep(sessionId: string, index: number): Promise<{ harness: SessionHarness }> {
    return request('POST', apiPath`/api/sessions/${sessionId}/harness/steps/${index}/approve`)
  },

  async reopenHarnessStep(sessionId: string, index: number): Promise<{ harness: SessionHarness }> {
    return request('POST', apiPath`/api/sessions/${sessionId}/harness/steps/${index}/reopen`)
  },

  // Mobile remote — Settings → Mobile and the pairing dialog (spec
  // 2026-10-01-settings-mobile-design § 1). The pairing calls read their
  // refusals as values, like `uploadAttachment`: each one is a state the UI
  // shows (or quietly waits out), not an error to toast.
  async getRemote(): Promise<RemoteStatus> {
    return request('GET', '/api/remote')
  },

  /**
   * A new code. 409 when the remote is off or the relay is not online right
   * now; 403 `not_primary`, naming the primary, from a member that is not
   * its group's primary — only the primary adds a device.
   */
  async startPairing(): Promise<
    { qr: string; expiresAt: number } | { error: 'disabled' | 'offline' | 'relay_error' | 'relay_too_old' | 'joining' } | NotPrimary
  > {
    return remoteCall<{ qr: string; expiresAt: number }, 'disabled' | 'offline' | 'relay_error' | 'relay_too_old' | 'joining' | 'not_primary'>(
      'POST', '/api/remote/pair', undefined, {
        403: ['not_primary'],
        409: ['disabled', 'offline', 'relay_error', 'relay_too_old', 'joining'],
      },
    ) as Promise<{ qr: string; expiresAt: number } | { error: 'disabled' | 'offline' | 'relay_error' | 'relay_too_old' | 'joining' } | NotPrimary>
  },

  /**
   * Redeems another device's code, as a phone does (spec
   * 2026-10-16-device-group-design § 3): the answer is the code the user
   * types on that device, `ok: false` carrying why not. Every HTTP answer
   * maps to a value — 200 to `ok: true`, 400/409's named refusals to their
   * `error`, and anything this route never names itself (a network failure,
   * a status outside its contract) to `relay_error`, like the rest of the
   * remote surface's refusals.
   */
  async joinGroup(code: string): Promise<JoinAnswer> {
    try {
      const res = await remoteCall<{ device: string; name: string; code: string }, JoinErrorCode>(
        'POST',
        '/api/remote/join',
        { code },
        JOIN_REFUSALS,
      )
      return ('error' in res ? { ok: false, ...res } : { ok: true, ...res }) as JoinAnswer
    } catch {
      return { ok: false, error: 'relay_error' }
    }
  },

  /**
   * Stops waiting for the device being joined; the relay's request expires
   * with the code regardless, so a 404 (nothing to cancel) is not an error
   * worth surfacing.
   */
  async cancelJoin(): Promise<void> {
    try {
      await request<{ ok: true }>('DELETE', '/api/remote/join')
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return
      throw err
    }
  },

  /**
   * The answer to the pending request. `phone` is the request the dialog
   * showed; the server refuses any other (409 `mismatch`). An accept carries
   * the `code` the user typed from the phone, which the server compares: a
   * wrong one is 422 `code_mismatch` with the attempts left, the last wrong
   * one 409 `code_rejected`. 404 means there is nothing left to answer, 502
   * that the relay did not take it.
   */
  /**
   * A member's update state (`GET /api/server/update`, spec
   * 2026-10-19-headless-server-design § Updating from the group). `machine`
   * names another member: on the desktop this server asks it through its
   * channel, on the phone the request goes to that member directly; left
   * out, this device's own. Ask only a member that serves the route
   * (`servesServerUpdate`). A malformed answer throws.
   */
  async serverUpdate(machine?: string): Promise<ServerUpdateState> {
    const url = machine === undefined ? '/api/server/update' : `/api/server/update?${new URLSearchParams({ machine })}`
    const state = parseServerUpdateState(await request<unknown>('GET', url))
    if (!state) throw new ApiError('malformed update state', 502, url)
    return state
  },

  /**
   * Starts that member's update: its state, now `updating`, or the refusal
   * (`no_update`, `updating`, `not_set_up`, `not_packaged`). The caller
   * confirms first when the state reported running sessions. Anything else
   * throws.
   */
  async startServerUpdate(machine?: string): Promise<{ ok: true; state: ServerUpdateState } | { ok: false; error: ServerUpdateRefusal }> {
    const url = machine === undefined ? '/api/server/update' : `/api/server/update?${new URLSearchParams({ machine })}`
    const res = await remoteCall<unknown, ServerUpdateRefusal>('POST', url, undefined, UPDATE_REFUSALS)
    if (typeof res === 'object' && res !== null && 'error' in res) return { ok: false, error: (res as { error: ServerUpdateRefusal }).error }
    const state = parseServerUpdateState(res)
    if (!state) throw new ApiError('malformed update state', 502, url)
    return { ok: true, state }
  },

  async confirmPairing(accept: boolean, phone: string, code?: string): Promise<PairConfirmResult> {
    return remoteCall<{ ok: true }, PairConfirmError>(
      'POST',
      '/api/remote/pair/confirm',
      accept ? { accept, phone, code } : { accept, phone },
      {
        404: ['no_pending'],
        409: ['mismatch', 'code_rejected', 'group_full'],
        422: ['code_mismatch'],
        502: ['relay_error'],
      },
    ) as Promise<PairConfirmResult>
  },

  /**
   * `false` when the device was already gone (404) — the next status drops
   * its row either way. `not_primary` (403), naming the primary, from a
   * member that is not its group's primary: only the primary removes a member.
   */
  async removeDevice(id: string): Promise<boolean | NotPrimary> {
    const res = await remoteCall<{ ok: true }, 'not_found' | 'not_primary'>(
      'DELETE', apiPath`/api/remote/devices/${id}`, undefined, { 403: ['not_primary'], 404: ['not_found'] },
    )
    if (!('error' in res)) return true
    return res.error === 'not_primary' ? (res as NotPrimary) : false
  },

  /**
   * This device leaves its group (spec 2026-10-16-device-group-design § 4).
   * `offline`: the relay must be online for the others to hear of it.
   */
  async leaveGroup(): Promise<{ ok: true } | { ok: false; error: 'offline' | 'failed' }> {
    const res = await remoteCall<{ ok: true }, 'offline' | 'failed'>(
      'POST',
      '/api/remote/leave',
      undefined,
      { 409: ['offline'], 500: ['failed'] },
    )
    return 'error' in res ? { ok: false, error: res.error } : res
  },

  /** The notice that the primary dissolved the group or removed this device was read (canvas 50m OK). */
  async acknowledgeEnded(): Promise<void> {
    await request<{ ok: true }>('POST', '/api/remote/ended/acknowledge')
  },

  /** The card saying a join was dropped, its primary's group never come, was read (canvas 50p B). */
  async acknowledgeExpiredJoin(): Promise<void> {
    await request<{ ok: true }>('POST', '/api/remote/join/expired/acknowledge')
  },

  /** "Try again": stops the remote and starts it with the same settings. */
  async restartRemote(): Promise<RemoteStatus> {
    return request('POST', '/api/remote/restart')
  },

  /**
   * Get member grants for all members except this device
   * (spec 2026-10-19-member-grants-design § 2).
   */
  async getRemoteGrants(): Promise<{ grants: Record<string, Record<string, boolean>> }> {
    return request('GET', '/api/remote/grants')
  },

  /**
   * Update grants for a member (spec 2026-10-19-member-grants-design § 2).
   * `memberId` is the member's id, `grants` is a partial object with group toggles.
   * Answers the member's full grants; a 404 when the member is not in the group.
   */
  async updateRemoteGrants(memberId: string, grants: Record<string, boolean>): Promise<{ grants: Record<string, boolean> }> {
    return request('PUT', apiPath`/api/remote/grants/${memberId}`, grants)
  },
}

/** The refusals `POST /api/remote/join` answers with instead of `{ device, name, code }`. */
type JoinErrorCode =
  | 'bad_code' | 'disabled' | 'offline' | 'already_paired' | 'in_group' | 'relay_error' | 'relay_too_old'
  | 'other_relay' | 'peer_offline' | 'group_full' | 'not_primary' | 'joining'

const JOIN_REFUSALS: Partial<Record<number, readonly JoinErrorCode[]>> = {
  400: ['bad_code'],
  403: ['not_primary'],
  409: [
    'disabled', 'offline', 'already_paired', 'in_group', 'relay_error', 'relay_too_old', 'other_relay', 'peer_offline',
    'group_full', 'joining',
  ],
}

/** What `/api/claude-dirs` refuses a change with. Mirrors `server/src/claudeDirs/service.ts`. */
export type ClaudeDirRefusal =
  | 'path_required'
  | 'not_absolute'
  | 'no_such_directory'
  | 'not_a_directory'
  | 'duplicate'
  | 'name_required'
  | 'not_found'
  | 'last_directory'

const CLAUDE_DIR_REFUSALS: Partial<Record<number, readonly ClaudeDirRefusal[]>> = {
  400: ['path_required', 'not_absolute', 'no_such_directory', 'not_a_directory', 'duplicate', 'name_required'],
  404: ['not_found'],
  409: ['last_directory'],
}

/**
 * A remote route whose listed statuses answer `{ error }` as part of its
 * contract: those come back as values, anything else throws `ApiError`.
 */
/**
 * A refusal comes back as its whole JSON body, so one that carries more than
 * its `error` (422 `code_mismatch` and its `attemptsLeft`) keeps it.
 */
/** `POST /api/server/update`'s refusals, by status, for `remoteCall`. */
const UPDATE_REFUSALS: Partial<Record<number, readonly ServerUpdateRefusal[]>> = (() => {
  const out: Partial<Record<number, ServerUpdateRefusal[]>> = {}
  for (const [error, status] of Object.entries(SERVER_UPDATE_REFUSALS) as [ServerUpdateRefusal, number][]) {
    ;(out[status] ??= []).push(error)
  }
  return out
})()

async function remoteCall<T, E extends string>(
  method: string,
  url: string,
  body: unknown,
  refusals: Partial<Record<number, readonly E[]>>,
): Promise<T | { error: E }> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const response = await apiFetch(url, init)
  if (response.status === 204) return undefined as T
  if (response.ok) return (await response.json()) as T

  const text = await response.text()
  let parsed: { error?: unknown } = {}
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    // A refusal without a JSON body falls through to the ApiError below.
  }
  const refusal = refusals[response.status]?.find((e) => e === parsed.error)
  if (refusal !== undefined) return { ...parsed, error: refusal }
  throw new ApiError(text || response.statusText, response.status, url)
}

export type ServerHealth = {
  app?: string
  billing?: 'subscription' | 'api-key'
  paths?: { claudeDirs?: Array<{ id: number; path: string }>; dataDir?: string; dbPath?: string }
}

/** One of Orbital's shipped tips, as `GET /api/session-instructions/tips` returns it. */
export interface SessionTip {
  id: string
  title: string
  text: string
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
  DirListing,
  ErrorKind,
  FileCompletionEntry,
  SlashCommand,
  ErrorRecord,
  ErrorSource,
  FilePreview,
  Tag,
  TagRule,
  Subagent,
  SubagentTranscript,
  OrbitalModel,
  FindingSeverity,
  SessionStatsDetail,
  StatsCacheRatioDay,
  StatsDayBusy,
  StatsFinding,
  StatsOverview,
  StatsToolLeaderboard,
  StatsToolRow,
  StatsTotals,
  StatsTurnSegment,
  StatsWindow,
  HarnessTemplate,
  HarnessStep,
  HarnessInput,
  SessionHarness,
  HarnessEvent,
  StepStatus,
  StepState,
  StepMode,
} from './types'
