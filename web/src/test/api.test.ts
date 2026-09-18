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
      parentId: null,
      mapDismissedAt: null,
      tagIds: [],
      status: 'idle',
      subagents: [],
    }

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ session: mockSession, lineage: [] }),
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
        parentId: null,
        mapDismissedAt: null,
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

  it('getSession should return object with session and lineage', async () => {
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
      parentId: 's0',
      mapDismissedAt: null,
      tagIds: [1, 2],
      status: 'working',
      subagents: [],
    }

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ session, lineage: ['s0'] }), { status: 200 })
    )

    const result = await api.getSession('s1')
    expect(result).toEqual({ session, lineage: ['s0'] })
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
    // — which is exactly what made "Clear all" silently do nothing.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, unseen: 0 }), { status: 200 })
    )

    await api.clearErrors()

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
