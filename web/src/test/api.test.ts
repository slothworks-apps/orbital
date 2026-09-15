import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  api,
  ApiError,
  type ApiSession,
  type ChatMessage,
  type Tag,
  type TagRule,
  type Subagent,
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

  it('should throw on non-2xx responses', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
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
      new Response(JSON.stringify({ error: 'Conflict' }), { status: 409 })
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
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'session1' }), { status: 200 })
    )

    await api.getSession('session1')

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session1', {
      method: 'GET',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
      }),
    })
  })

  it('should construct correct URL for POST requests with body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.sendMessage('session1', 'hello')

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session1/messages', {
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ text: 'hello' }),
    })
  })

  it('should include query params for list requests', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200 })
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
  it('listSessions should return array of sessions', async () => {
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
        parentId: null,
        tagIds: [],
        status: 'idle',
      },
    ]

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(sessions), { status: 200 })
    )

    const result = await api.listSessions({})
    expect(result).toEqual(sessions)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('getSession should return single session', async () => {
    const session: ApiSession = {
      id: 's1',
      cwd: '/home',
      title: 'Session 1',
      firstAt: 1000,
      lastAt: 2000,
      messageCount: 5,
      source: 'web',
      permissionMode: 'plan',
      parentId: null,
      tagIds: [1, 2],
      status: 'working',
    }

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(session), { status: 200 })
    )

    const result = await api.getSession('s1')
    expect(result).toEqual(session)
  })

  it('createSession should POST body and return session', async () => {
    const created: ApiSession = {
      id: 's1',
      cwd: '/home',
      title: 'New Session',
      firstAt: null,
      lastAt: null,
      messageCount: 0,
      source: 'web',
      permissionMode: null,
      parentId: null,
      tagIds: [],
      status: 'idle',
    }

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(created), { status: 201 })
    )

    const result = await api.createSession({ cwd: '/home', title: 'New Session' })
    expect(result).toEqual(created)
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', {
      method: 'POST',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ cwd: '/home', title: 'New Session' }),
    })
  })

  it('renameSession should PATCH with title', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.renameSession('s1', 'New Title')

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/rename', {
      method: 'PATCH',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
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

  it('clearSession should POST with startNew param', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.clearSession('s1', true)

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/clear', {
      method: 'POST',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ startNew: true }),
    })
  })

  it('setSessionTags should POST with tagIds', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.setSessionTags('s1', [1, 2, 3])

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/tags', {
      method: 'POST',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ tagIds: [1, 2, 3] }),
    })
  })
})

describe('Messages API', () => {
  it('getMessages should fetch with id and options', async () => {
    const messages: ChatMessage[] = [
      {
        id: 'm1',
        role: 'user',
        text: 'hello',
      },
    ]

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(messages), { status: 200 })
    )

    const result = await api.getMessages('s1', { limit: 20 })
    expect(result).toEqual(messages)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/sessions/s1/messages'),
      expect.any(Object)
    )
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

    await expect(api.sendMessage('s1', 'test')).rejects.toThrow(ApiError)
  })
})

describe('Tags API', () => {
  it('listTags should return array of tags', async () => {
    const tags: Tag[] = [
      { id: 1, name: 'important', hue: 0, is_default: 1 },
      { id: 2, name: 'archive', hue: 240, is_default: 0 },
    ]

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(tags), { status: 200 })
    )

    const result = await api.listTags()
    expect(result).toEqual(tags)
  })

  it('createTag should POST with body', async () => {
    const tag: Tag = { id: 1, name: 'new-tag', hue: 120, is_default: 0 }

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(tag), { status: 201 })
    )

    const result = await api.createTag({ name: 'new-tag', hue: 120 })
    expect(result).toEqual(tag)
  })

  it('updateTag should PATCH with id and body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.updateTag(1, { name: 'renamed' })

    expect(fetchMock).toHaveBeenCalledWith('/api/tags/1', {
      method: 'PATCH',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
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
  it('listTagRules should return array of rules', async () => {
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
      new Response(JSON.stringify(rules), { status: 200 })
    )

    const result = await api.listTagRules()
    expect(result).toEqual(rules)
  })

  it('createTagRule should POST with body', async () => {
    const rule: TagRule = {
      id: 1,
      tag_id: 1,
      position: 0,
      enabled: 1,
      condition: 'path_matches',
      pattern: '/home/*',
    }

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(rule), { status: 201 })
    )

    const result = await api.createTagRule({
      tag_id: 1,
      condition: 'path_matches',
      pattern: '/home/*',
    })
    expect(result).toEqual(rule)
  })

  it('updateTagRule should PATCH', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )

    await api.updateTagRule(1, { enabled: 0 })

    expect(fetchMock).toHaveBeenCalledWith('/api/tag-rules/1', {
      method: 'PATCH',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ enabled: 0 }),
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

  it('previewRule should POST rule and return matches', async () => {
    const matches = { matches: true }

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(matches), { status: 200 })
    )

    const result = await api.previewRule({
      tag_id: 1,
      condition: 'path_matches',
      pattern: '/home/*',
    })
    expect(result).toEqual(matches)
  })
})

describe('Projects API', () => {
  it('listProjects should return array', async () => {
    const projects = [
      { id: 'p1', name: 'project1' },
      { id: 'p2', name: 'project2' },
    ]

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(projects), { status: 200 })
    )

    const result = await api.listProjects()
    expect(result).toEqual(projects)
  })
})

describe('Settings API', () => {
  it('getSettings should return settings object', async () => {
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
    const settings = { theme: 'dark' }

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(settings), { status: 200 })
    )

    await api.patchSettings({ theme: 'dark' })

    expect(fetchMock).toHaveBeenCalledWith('/api/settings', {
      method: 'PATCH',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ theme: 'dark' }),
    })
  })
})
