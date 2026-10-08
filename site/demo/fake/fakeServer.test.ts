import { describe, expect, it } from 'vitest'
import { FakeServer, ROUTES } from './fakeServer'
import { BILLING, BILLING_DECISION, DOCS, MESSAGES, MODELS, SETTINGS, TAGS } from './fixtures'

function world() {
  return {
    sessions: [{ ...BILLING, pendingDecision: BILLING_DECISION, status: 'needs_input' as const }, DOCS],
    tags: TAGS,
    models: MODELS,
    settings: SETTINGS,
    messages: MESSAGES,
  }
}

/** A concrete URL for each route, its `:params` filled from the fixtures. */
function sample(path: string): string {
  return path
    .replace(':decisionId', BILLING_DECISION.id)
    .replace(':toolUseId', 'billing-agent-0-call')
    .replace(':id', BILLING.id)
}

describe('FakeServer', () => {
  it('answers every listed endpoint from its own route', async () => {
    for (const route of ROUTES) {
      const server = new FakeServer(world())
      const res = await server.fetch(sample(route.path), {
        method: route.method,
        ...(route.method === 'GET' ? {} : { body: '{}' }),
      })
      expect(server.unanswered, `${route.method} ${route.path}`).toEqual([])
      // A 404 is a deliberate answer (the stats row of a session the index never saw).
      expect([200, 404]).toContain(res.status)
    }
  })

  it('matches the literal route ahead of a parameter in the same place', async () => {
    const server = new FakeServer(world())
    const body = await (await server.fetch('/api/sessions/count')).json()
    expect(body).toEqual({ total: 2 })
  })

  it('answers an unknown endpoint with an empty success and records it', async () => {
    const server = new FakeServer(world())
    const read = await server.fetch('/api/nothing/here')
    expect(read.ok).toBe(true)
    expect(await read.json()).toEqual({})
    const write = await server.fetch('/api/nothing', { method: 'POST', body: '{}' })
    expect(await write.json()).toEqual({ ok: true })
    expect(server.unanswered).toEqual(['GET /api/nothing/here', 'POST /api/nothing'])
  })

  it('settling the permission puts the session back to work and tells its topic', async () => {
    const server = new FakeServer(world())
    const frames: unknown[] = []
    const socket = server.hub.WebSocket('ws://demo/ws')
    socket.onmessage = (e) => frames.push(JSON.parse(e.data as string))
    await new Promise((r) => setTimeout(r, 0))
    socket.send(JSON.stringify({ type: 'subscribe', topic: `session:${BILLING.id}` }))

    await server.fetch(`/api/sessions/${BILLING.id}/decision/${BILLING_DECISION.id}`, {
      method: 'POST',
      body: JSON.stringify({ approved: false }),
    })

    expect(server.session(BILLING.id)?.status).toBe('working')
    expect(server.session(BILLING.id)?.pendingDecision).toBeNull()
    expect(frames).toEqual([
      {
        topic: `session:${BILLING.id}`,
        event: 'message',
        message: expect.objectContaining({ role: 'tool_result', toolUseId: BILLING_DECISION.id, isError: true }),
      },
      { topic: `session:${BILLING.id}`, event: 'decision_resolved', decisionId: BILLING_DECISION.id },
    ])
    // The transcript a later read returns carries the result too; the fixtures do not.
    const read = await (await server.fetch(`/api/sessions/${BILLING.id}/messages`)).json()
    expect(read.messages.at(-1).toolUseId).toBe(BILLING_DECISION.id)
    expect(MESSAGES[BILLING.id].at(-1)?.role).toBe('tool_use')
    socket.close()
  })

  it('a launch adds a working session under the id the client minted and tells the sessions topic', async () => {
    const server = new FakeServer(world())
    const frames: unknown[] = []
    const socket = server.hub.WebSocket('ws://demo/ws')
    socket.onmessage = (e) => frames.push(JSON.parse(e.data as string))
    await new Promise((r) => setTimeout(r, 0))
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'sessions' }))

    const res = await server.fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd: DOCS.cwd, prompt: '', permissionMode: 'plan', model: 'sonnet', sessionId: 'minted' }),
    })

    expect(await res.json()).toEqual({ sessionId: 'minted' })
    expect(server.session('minted')).toMatchObject({
      cwd: DOCS.cwd,
      status: 'working',
      permissionMode: 'plan',
      model: 'sonnet',
      // No tag picked: the tag of the session already in that directory.
      tagIds: DOCS.tagIds,
    })
    expect(frames).toEqual([
      { topic: 'sessions', event: 'upsert', session: expect.objectContaining({ id: 'minted' }) },
    ])
    socket.close()
  })

  it('a route a demo adds is matched ahead of the defaults', async () => {
    const server = new FakeServer(world())
    server.route({ method: 'GET', path: '/api/tags', calledBy: 'test', answer: () => ({ tags: [] }) })
    expect(await (await server.fetch('/api/tags')).json()).toEqual({ tags: [] })
  })
})
