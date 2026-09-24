import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  api,
  ApiError,
  type ApiSession,
  type ChatMessage,
  type Tag,
  type TagRule,
} from '../lib/api'

// Mock fetch
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ApiError', () => {
  it('should have a status property', () => {
    const error = new ApiError('test', 404)
    expect(error.status).toBe(404)
    expect(error.message).toBe('test')
  })

  it('should throw on 404 responses', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    )

    try {
      await api.getSession('id1')
      expect.fail('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(404)
    }
  })

  it('should throw ApiError with 409 conflict', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'session is live in a terminal' }), {
        status: 409,
      })
    )

    try {
      await api.sendMessage('id1', 'test')
      expect.fail('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(409)
    }
  })
})

describe('request helper', () => {
  it('should construct correct URL for GET requests', async () => {
    const mockSession: ApiSession = {
      id: 'session1',
      cwd: '/home',
      title: 'Session 1',
      firstAt: 1000,
      lastAt: 2000,
      messageCount: 5,
      source: 'web',
      permissionMode: 'plan',
      model: null,
      resolvedModel: null,
      tagIds: [],
      status: 'idle',
      subagents: [],
    }

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ session: mockSession }),
        { status: 200 }
      )
    )

    await api.getSession('session1')

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session1', {
      method: 'GET',
      headers: expect.any(Object),
    })
  })

  it('should construct correct URL for POST requests with body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.sendMessage('session1', 'hello')

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session1/messages', {
      method: 'POST',
      headers: expect.any(Object),
      body: JSON.stringify({ text: 'hello' }),
    })
  })

  it('should include query params for list requests', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessions: [] }), { status: 200 })
    )

    await api.listSessions({ limit: 10, offset: 5 })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/sessions?'),
      expect.any(Object)
    )
    const call = fetchMock.mock.calls[0][0] as string
    expect(call).toContain('limit=10')
    expect(call).toContain('offset=5')
  })

  // dismissSubagent's route (POST .../dismiss) is the one endpoint that
  // answers 204 with no body at all — every other body-less route in this
  // app answers 200 { ok: true }. request() used to call response.json()
  // unconditionally, which throws SyntaxError on an empty 204 body; this
  // pins the guard that carves 204 out before that call.
  it('resolves a 204 response with no body, rather than throwing on an empty JSON parse', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(api.dismissSubagent('session1', 'agent1')).resolves.toBeUndefined()
  })
})

describe('Sessions API', () => {
  it('listSessions should unwrap and return sessions array', async () => {
    const sessions: ApiSession[] = [
      {
        id: 's1',
        cwd: '/home',
        title: 'Session 1',
        firstAt: 1000,
        lastAt: 2000,
        messageCount: 5,
        source: 'web',
        permissionMode: 'plan',
        model: null,
        resolvedModel: null,
        tagIds: [],
        status: 'idle',
        subagents: [],
      },
    ]

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessions }), { status: 200 })
    )

    const result = await api.listSessions({})
    expect(result).toEqual(sessions)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('listSessions should support q and tag params', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessions: [] }), { status: 200 })
    )

    await api.listSessions({ q: 'test', tag: 5 })

    const call = fetchMock.mock.calls[0][0] as string
    expect(call).toContain('q=test')
    expect(call).toContain('tag=5')
  })

  it('getSession should return object with session', async () => {
    const session: ApiSession = {
      id: 's1',
      cwd: '/home',
      title: 'Session 1',
      firstAt: 1000,
      lastAt: 2000,
      messageCount: 5,
      source: 'web',
      permissionMode: 'plan',
      model: null,
      resolvedModel: null,
      tagIds: [1, 2],
      status: 'working',
      subagents: [],
    }

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ session }), { status: 200 })
    )

    const result = await api.getSession('s1')
    expect(result).toEqual({ session })
  })

  it('createSession should POST body and return sessionId', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: 's1' }), { status: 201 })
    )

    const result = await api.createSession({
      cwd: '/home',
      prompt: 'hello world',
      permissionMode: 'plan',
    })
    expect(result).toBe('s1')
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', {
      method: 'POST',
      headers: expect.any(Object),
      body: JSON.stringify({
        cwd: '/home',
        prompt: 'hello world',
        permissionMode: 'plan',
      }),
    })
  })

  it('renameSession should PATCH without /rename suffix', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.renameSession('s1', 'New Title')

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1', {
      method: 'PATCH',
      headers: expect.any(Object),
      body: JSON.stringify({ title: 'New Title' }),
    })
  })

  it('interrupt should POST to interrupt endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.interrupt('s1')

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/interrupt', {
      method: 'POST',
      headers: expect.any(Object),
    })
  })

  it('clearSession should POST with startNew param and return ok and optional sessionId', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, sessionId: 's2' }), { status: 200 })
    )

    const result = await api.clearSession('s1', true)

    expect(result).toEqual({ ok: true, sessionId: 's2' })
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/clear', {
      method: 'POST',
      headers: expect.any(Object),
      body: JSON.stringify({ startNew: true }),
    })
  })

  it('setSessionTags should PUT with tagIds', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.setSessionTags('s1', [1, 2, 3])

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/tags', {
      method: 'PUT',
      headers: expect.any(Object),
      body: JSON.stringify({ tagIds: [1, 2, 3] }),
    })
  })
})

describe('Messages API', () => {
  it('getMessages should unwrap messages array and support before cursor', async () => {
    const messages: ChatMessage[] = [
      {
        id: 'm1',
        role: 'user',
        text: 'hello',
      },
    ]

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages }), { status: 200 })
    )

    const result = await api.getMessages('s1', { before: 'm5', limit: 20 })
    expect(result).toEqual(messages)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/sessions/s1/messages?'),
      expect.any(Object)
    )
    const call = fetchMock.mock.calls[0][0] as string
    expect(call).toContain('before=m5')
    expect(call).toContain('limit=20')
  })

  it('sendMessage should return {ok, revived?}', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, revived: false }), { status: 200 })
    )

    const result = await api.sendMessage('s1', 'test message')
    expect(result).toEqual({ ok: true, revived: false })
  })

  it('sendMessage should throw ApiError on error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'failed' }), { status: 500 })
    )

    try {
      await api.sendMessage('s1', 'test')
      expect.fail('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
    }
  })
})

describe('Tags API', () => {
  it('listTags should unwrap and return tags array', async () => {
    const tags: Tag[] = [
      { id: 1, name: 'important', hue: 0, is_default: 1 },
      { id: 2, name: 'archive', hue: 240, is_default: 0 },
    ]

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ tags }), { status: 200 })
    )

    const result = await api.listTags()
    expect(result).toEqual(tags)
  })

  it('createTag should POST with body and return id', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 1 }), { status: 201 })
    )

    const result = await api.createTag({ name: 'new-tag', hue: 120 })
    expect(result).toBe(1)
  })

  it('patchTag should PATCH with id and body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.patchTag(1, { name: 'renamed' })

    expect(fetchMock).toHaveBeenCalledWith('/api/tags/1', {
      method: 'PATCH',
      headers: expect.any(Object),
      body: JSON.stringify({ name: 'renamed' }),
    })
  })

  it('deleteTag should DELETE', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.deleteTag(1)

    expect(fetchMock).toHaveBeenCalledWith('/api/tags/1', {
      method: 'DELETE',
      headers: expect.any(Object),
    })
  })
})

describe('Tag Rules API', () => {
  it('listTagRules should unwrap and return rules array', async () => {
    const rules: TagRule[] = [
      {
        id: 1,
        tag_id: 1,
        position: 0,
        enabled: 1,
        condition: 'path_matches',
        pattern: '/home/*',
      },
    ]

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ rules }), { status: 200 })
    )

    const result = await api.listTagRules()
    expect(result).toEqual(rules)
  })

  it('createTagRule should POST with camelCase tagId and return id', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 1 }), { status: 201 })
    )

    const result = await api.createTagRule({
      tagId: 1,
      condition: 'path_matches',
      pattern: '/home/*',
    })
    expect(result).toBe(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/tag-rules', {
      method: 'POST',
      headers: expect.any(Object),
      body: JSON.stringify({
        tagId: 1,
        condition: 'path_matches',
        pattern: '/home/*',
      }),
    })
  })

  it('patchTagRule should PATCH with snake_case fields', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.patchTagRule(1, { enabled: 0, tag_id: 2 })

    expect(fetchMock).toHaveBeenCalledWith('/api/tag-rules/1', {
      method: 'PATCH',
      headers: expect.any(Object),
      body: JSON.stringify({ enabled: 0, tag_id: 2 }),
    })
  })

  it('deleteTagRule should DELETE', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.deleteTagRule(1)

    expect(fetchMock).toHaveBeenCalledWith('/api/tag-rules/1', {
      method: 'DELETE',
      headers: expect.any(Object),
    })
  })

  it('previewRule should POST and return tagId/ruleId or null', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ tagId: 1, ruleId: 5 }), { status: 200 })
    )

    const result = await api.previewRule({
      cwd: '/home/user',
      title: 'test session',
      permissionMode: 'plan',
    })
    expect(result).toEqual({ tagId: 1, ruleId: 5 })

    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ tagId: null, ruleId: null }), { status: 200 })
    )

    const result2 = await api.previewRule({
      cwd: '/other',
      title: 'no match',
      permissionMode: null,
    })
    expect(result2).toEqual({ tagId: null, ruleId: null })
  })
})

describe('Errors API', () => {
  it('omits Content-Type on body-less requests so Fastify does not reject the empty body', async () => {
    // Fastify parses the body of any request that declares a content type, and
    // answers a declared-but-empty JSON body with 400 FST_ERR_CTP_EMPTY_JSON_BODY
    // — which is exactly what once made body-less calls silently do nothing.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.deleteTag(1)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const options = fetchMock.mock.calls[0][1] as RequestInit
    expect(options.method).toBe('DELETE')
    expect(options.body).toBeUndefined()
    expect(options.headers).not.toHaveProperty('Content-Type')
  })

  it('still declares JSON on requests that do carry a body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, unseen: 0 }), { status: 200 })
    )

    await api.markErrorsSeen('all')

    const options = fetchMock.mock.calls[0][1] as RequestInit
    expect(options.headers).toHaveProperty('Content-Type', 'application/json')
    expect(options.body).toBe(JSON.stringify({ all: true }))
  })

  it('stamps web reports with a dev flag in dev builds, so HMR-era errors read apart from real ones', async () => {
    // Vitest runs with import.meta.env.DEV === true, which is the branch that
    // must stamp. A production build simply leaves the context untouched.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: {}, unseen: 1 }), { status: 200 })
    )

    await api.reportErrorToServer({
      kind: 'render_crash',
      message: 'boom',
      context: { label: 'Space map' },
    })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.context).toEqual({ label: 'Space map', dev: true })
  })

  it('creates a context for the dev flag when the report carries none', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: {}, unseen: 1 }), { status: 200 })
    )

    await api.reportErrorToServer({ kind: 'api_request', message: 'boom' })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.context).toEqual({ dev: true })
  })
})

describe('Files API', () => {
  it('filePreview builds the query URL with session and raw path', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: 'x', size: 1, mtimeMs: 2, lines: 1 }), { status: 200 })
    )

    await api.filePreview('s1', 'web/src/App.tsx')

    const call = fetchMock.mock.calls[0][0] as string
    expect(call).toContain('/api/files?')
    expect(call).toContain('session=s1')
    expect(call).toContain(`path=${encodeURIComponent('web/src/App.tsx')}`)
  })

  it('filePreview returns kind ok with the file body on 200', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ content: 'hello', size: 5, mtimeMs: 1000, lines: 1 }),
        { status: 200 }
      )
    )

    const result = await api.filePreview('s1', 'a/b.ts')
    expect(result).toEqual({ kind: 'ok', content: 'hello', size: 5, mtimeMs: 1000, lines: 1 })
  })

  it('filePreview maps 403 outside_cwd to kind outside instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'outside_cwd' }), { status: 403 })
    )

    await expect(api.filePreview('s1', '../../etc/passwd')).resolves.toEqual({ kind: 'outside' })
  })

  it('filePreview maps 404 to kind not_found instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
    )

    await expect(api.filePreview('s1', 'gone.ts')).resolves.toEqual({ kind: 'not_found' })
  })

  it('filePreview maps 413 to kind too_large, keeping the measured size', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'too_large', size: 12_000_000 }), { status: 413 })
    )

    await expect(api.filePreview('s1', 'big.log')).resolves.toEqual({
      kind: 'too_large',
      size: 12_000_000,
    })
  })

  it('filePreview maps 415 to kind binary, keeping size and mediaType', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'binary', size: 131_072, mediaType: 'font/woff2' }),
        { status: 415 }
      )
    )

    await expect(api.filePreview('s1', 'a/f.dat')).resolves.toEqual({
      kind: 'binary',
      size: 131_072,
      mediaType: 'font/woff2',
    })
  })

  it('filePreview still throws ApiError on an unexpected status', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'missing_params' }), { status: 400 })
    )

    await expect(api.filePreview('s1', 'a/b.ts')).rejects.toBeInstanceOf(ApiError)
  })

  it('filePreview lets a network-level failure propagate', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(api.filePreview('s1', 'a/b.ts')).rejects.toThrow('Failed to fetch')
  })
})

describe('Projects API', () => {
  it('listProjects should unwrap and return projects array of strings', async () => {
    const projects = ['/home/user/project1', '/home/user/project2']

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ projects }), { status: 200 })
    )

    const result = await api.listProjects()
    expect(result).toEqual(projects)
  })
})

describe('Settings API', () => {
  it('getSettings should return flat settings object', async () => {
    const settings = {
      theme: 'dark',
      language: 'en',
    }

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(settings), { status: 200 })
    )

    const result = await api.getSettings()
    expect(result).toEqual(settings)
  })

  it('patchSettings should PATCH partial settings', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.patchSettings({ theme: 'dark' })

    expect(fetchMock).toHaveBeenCalledWith('/api/settings', {
      method: 'PATCH',
      headers: expect.any(Object),
      body: JSON.stringify({ theme: 'dark' }),
    })
  })
})

// ---------------------------------------------------------------------------
// Completion API — the composer's two sources (spec: 2026-09-20-composer-design)
// ---------------------------------------------------------------------------

describe('Completion API', () => {
  it('commands takes a session key and unwraps the list', async () => {
    const commands = [{ name: '/commit', description: 'Commit', source: 'project' as const }]
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ commands }), { status: 200 }))

    await expect(api.commands({ session: 's1' })).resolves.toEqual(commands)

    const call = fetchMock.mock.calls[0][0] as string
    expect(call).toContain('/api/commands?')
    expect(call).toContain('session=s1')
    expect(call).not.toContain('cwd=')
  })

  it('commands takes a cwd key instead — the dialog has no session yet', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ commands: [] }), { status: 200 }))

    await api.commands({ cwd: '/work/platform/web' })

    const call = fetchMock.mock.calls[0][0] as string
    expect(call).toContain(`cwd=${encodeURIComponent('/work/platform/web')}`)
    expect(call).not.toContain('session=')
  })

  it('filesComplete sends the key and the raw prefix, unwrapping entries', async () => {
    const entries = [{ name: 'components', dir: true }, { name: 'a.ts', dir: false, size: 12 }]
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ entries }), { status: 200 }))

    await expect(api.filesComplete({ session: 's1' }, 'web/src/co')).resolves.toEqual(entries)

    const call = fetchMock.mock.calls[0][0] as string
    expect(call).toContain('/api/files/complete?')
    expect(call).toContain('session=s1')
    expect(call).toContain(`prefix=${encodeURIComponent('web/src/co')}`)
  })

  it('filesComplete sends an empty prefix rather than dropping the parameter', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ entries: [] }), { status: 200 }))

    await api.filesComplete({ cwd: '/w' }, '')

    expect(fetchMock.mock.calls[0][0] as string).toContain('prefix=')
  })
})

// ---------------------------------------------------------------------------
// Attachments — the composer's upload hop (spec: 2026-09-20-composer-design
// § Image intake / Store + wire). Deliberately NOT through `request`: the body
// is multipart and the refusals are states, not errors.
// ---------------------------------------------------------------------------

describe('Attachments API', () => {
  const png = () => new File([new Uint8Array([1, 2, 3])], 'capture.png', { type: 'image/png' })

  it('posts one file as multipart FormData and returns the stored entry', async () => {
    const entry = { ref: 'abc.png', w: 1512, h: 982, bytes: 3 }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(entry), { status: 201 }))

    await expect(api.uploadAttachment('s1', png())).resolves.toEqual({ kind: 'ok', entry })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/sessions/s1/attachments')
    expect(init.method).toBe('POST')
    // No Content-Type of our own — the boundary is the browser's to set.
    expect(init.headers).toBeUndefined()
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('file')).toBeInstanceOf(File)
  })

  it('posts to the sessionless route when there is no session yet (the dialog)', async () => {
    const entry = { ref: 'abc.png', w: 2048, h: 1152, bytes: 3 }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(entry), { status: 201 }))

    await expect(api.uploadAttachment(null, png())).resolves.toEqual({ kind: 'ok', entry })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/attachments')
  })

  it('reads a refusal from the sessionless route the same way', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'not_image', mediaType: 'application/pdf' }), {
        status: 415,
      })
    )
    await expect(api.uploadAttachment(null, png())).resolves.toEqual({
      kind: 'not_image',
      mediaType: 'application/pdf',
    })
  })

  it('reads a 413 as a too_large state carrying the measured size', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'too_large', size: 13_000_000 }), { status: 413 })
    )
    await expect(api.uploadAttachment('s1', png())).resolves.toEqual({
      kind: 'too_large',
      size: 13_000_000,
      truncated: false,
    })
  })

  it('carries the server`s truncated flag so a wall-stopped size is never read as exact', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'too_large', size: 10_485_760, truncated: true }), {
        status: 413,
      })
    )
    await expect(api.uploadAttachment('s1', png())).resolves.toMatchObject({ truncated: true })
  })

  it('reads a 415 as not_image, naming the media type the server saw', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'not_image', mediaType: 'application/pdf' }), {
        status: 415,
      })
    )
    await expect(api.uploadAttachment('s1', png())).resolves.toEqual({
      kind: 'not_image',
      mediaType: 'application/pdf',
    })
  })

  it('reads a 400 empty_file as its own state', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'empty_file' }), { status: 400 })
    )
    await expect(api.uploadAttachment('s1', png())).resolves.toEqual({ kind: 'empty' })
  })

  it('throws for a status outside the contract — that is a real failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))
    await expect(api.uploadAttachment('s1', png())).rejects.toBeInstanceOf(ApiError)
  })

  it('passes the abort signal through, so a chip`s × cancels its own upload', async () => {
    const controller = new AbortController()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ref: 'a.png', w: 1, h: 1, bytes: 1 }), { status: 201 }))
    await api.uploadAttachment('s1', png(), { signal: controller.signal })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBe(controller.signal)
  })

  it('sendMessage carries attachment refs only when there are any', async () => {
    // A fresh Response per call — a Response body may only be read once.
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.sendMessage('s1', 'look', ['a.png', 'b.png'])
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(
      JSON.stringify({ text: 'look', attachments: ['a.png', 'b.png'] })
    )

    fetchMock.mockClear()
    await api.sendMessage('s1', 'plain')
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ text: 'plain' }))

    // An empty list is the same as none — the server's `attachments` is optional.
    fetchMock.mockClear()
    await api.sendMessage('s1', 'plain', [])
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ text: 'plain' }))
  })

  it('createSession carries attachments for the dialog`s first turn', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 's9' }), { status: 201 }))

    await api.createSession({
      cwd: '/home',
      prompt: 'look',
      permissionMode: 'plan',
      attachments: ['a.png'],
    })

    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toContain('"attachments":["a.png"]')
  })
})
