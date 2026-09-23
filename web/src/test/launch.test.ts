import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

/**
 * One fake socket for the file, recording the order of subscribes and handing
 * back a release we can assert was called. Hoisted because `vi.mock`'s factory
 * runs before this file's imports.
 */
const { subscribeSpy, releaseSpy, handlers } = vi.hoisted(() => {
  const releaseSpy = vi.fn()
  const handlers = new Map<string, (msg: unknown) => void>()
  const subscribeSpy = vi.fn((topic: string, handler: (msg: unknown) => void) => {
    handlers.set(topic, handler)
    return () => {
      handlers.delete(topic)
      releaseSpy(topic)
    }
  })
  return { subscribeSpy, releaseSpy, handlers }
})
vi.mock('../lib/socket', () => ({ getSocket: () => ({ subscribe: subscribeSpy }) }))

import { api } from '../lib/api'
import { useOrbital } from '../store/store'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const LAUNCH = { cwd: '/w', prompt: 'go', permissionMode: 'acceptEdits' } as const

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  useOrbital.setState({ sessions: {}, order: [], transcripts: {}, historyLoaded: {} })
})

// ---------------------------------------------------------------------------
// launchSession — the browser mints the id so it can listen before it asks
// (docs/fixes/first-turn-can-outrun-the-ws-subscription.md)
// ---------------------------------------------------------------------------

describe('launchSession', () => {
  it('mints a v4 uuid and sends it with the request', async () => {
    vi.mocked(api.createSession).mockImplementation(async (body) => body.sessionId!)

    const id = await useOrbital.getState().launchSession({ ...LAUNCH })

    expect(id).toMatch(UUID_V4)
    expect(vi.mocked(api.createSession).mock.calls[0][0].sessionId).toBe(id)
  })

  /** The whole point. A subscribe after the response is the bug. */
  it('subscribes to the session topic before the request goes out', async () => {
    vi.mocked(api.createSession).mockImplementation(async (body) => body.sessionId!)

    const id = await useOrbital.getState().launchSession({ ...LAUNCH })

    expect(subscribeSpy).toHaveBeenCalledWith(`session:${id}`, expect.any(Function))
    expect(subscribeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.createSession).mock.invocationCallOrder[0]
    )
  })

  it('delivers a message published before anything selected the session', async () => {
    vi.mocked(api.createSession).mockImplementation(async (body) => body.sessionId!)

    const id = await useOrbital.getState().launchSession({ ...LAUNCH })
    // Nothing has called `select()` — this is the window that used to drop.
    handlers.get(`session:${id}`)!({
      event: 'message',
      message: { id: 'm1', role: 'assistant', text: 'first' },
    })

    expect(useOrbital.getState().transcripts[id].map((m) => m.text)).toEqual(['go', 'first'])
  })

  /**
   * The Runner publishes no user turn and the first REST read finds no file
   * yet, so the prompt the session was launched with is the store's to show —
   * the same optimistic turn `sendPrompt` appends for every later one.
   */
  it('shows the first prompt above whatever the session answers, even a reply that lands mid-request', async () => {
    vi.mocked(api.createSession).mockImplementation(async (body) => {
      handlers.get(`session:${body.sessionId}`)!({
        event: 'message',
        message: { id: 'm1', role: 'assistant', text: 'on it' },
      })
      return body.sessionId!
    })

    const id = await useOrbital.getState().launchSession({ ...LAUNCH })

    const transcript = useOrbital.getState().transcripts[id]
    expect(transcript.map((m) => [m.role, m.text])).toEqual([
      ['user', 'go'],
      ['assistant', 'on it'],
    ])
    expect(transcript[0].id).toMatch(/^local:/)
  })

  it('drops the first prompt again when the launch is refused', async () => {
    vi.mocked(api.createSession).mockRejectedValue(new Error('no such directory'))

    await expect(useOrbital.getState().launchSession({ ...LAUNCH })).rejects.toThrow()

    expect(useOrbital.getState().transcripts).toEqual({})
  })

  it('releases the subscription when the session ends', async () => {
    vi.mocked(api.createSession).mockImplementation(async (body) => body.sessionId!)
    const id = await useOrbital.getState().launchSession({ ...LAUNCH })
    useOrbital.setState({
      sessions: { [id]: { id, status: 'working' } as never },
    })

    useOrbital.getState().applySessionEvent(id, { event: 'status', status: 'ended' })

    expect(releaseSpy).toHaveBeenCalledWith(`session:${id}`)
  })

  it('releases the subscription when the request fails, and rethrows', async () => {
    vi.mocked(api.createSession).mockRejectedValue(new Error('no such directory'))

    await expect(useOrbital.getState().launchSession({ ...LAUNCH })).rejects.toThrow(
      'no such directory'
    )
    expect(releaseSpy).toHaveBeenCalledTimes(1)
  })

  /**
   * The server takes the id we send or refuses the request, so this should
   * never happen — but being subscribed to a topic nothing publishes on is the
   * exact failure this change exists to remove, so it must not be silent.
   */
  it('moves the subscription if the server somehow reports a different id', async () => {
    vi.mocked(api.createSession).mockResolvedValue('server-chose-this')

    const id = await useOrbital.getState().launchSession({ ...LAUNCH })

    expect(id).toBe('server-chose-this')
    expect(releaseSpy).toHaveBeenCalledTimes(1)
    expect(subscribeSpy).toHaveBeenLastCalledWith('session:server-chose-this', expect.any(Function))
  })
})
