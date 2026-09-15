import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OrbitalSocket, resolveWsUrl } from '../lib/ws'

// FakeWebSocket implementation for testing
class FakeWebSocket {
  url: string
  sent: any[] = []
  readyState: number = 0 // 0 = CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3 // CLOSED
    // Trigger onclose
    if (this.onclose) {
      this.onclose()
    }
  }

  // Helper methods for testing
  simulateOpen() {
    this.readyState = 1 // OPEN
    if (this.onopen) {
      this.onopen()
    }
  }

  simulateMessage(data: any) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }))
    }
  }

  simulateClose() {
    this.readyState = 3 // CLOSED
    if (this.onclose) {
      this.onclose()
    }
  }

  simulateMalformedMessage(data: string) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data }))
    }
  }
}

// Factory to track created WebSocket instances
class FakeWebSocketFactory {
  instances: FakeWebSocket[] = []

  create(url: string): FakeWebSocket {
    const ws = new FakeWebSocket(url)
    this.instances.push(ws)
    return ws
  }

  reset() {
    this.instances = []
  }
}

describe('resolveWsUrl', () => {
  it('should resolve /ws to ws:// with http location', () => {
    const mockLocation = {
      protocol: 'http:',
      host: 'localhost:5173',
    } as any
    expect(resolveWsUrl('/ws', mockLocation)).toBe('ws://localhost:5173/ws')
  })

  it('should resolve /ws to wss:// with https location', () => {
    const mockLocation = {
      protocol: 'https:',
      host: 'example.com',
    } as any
    expect(resolveWsUrl('/ws', mockLocation)).toBe('wss://example.com/ws')
  })

  it('should handle custom paths', () => {
    const mockLocation = {
      protocol: 'http:',
      host: 'localhost:3000',
    } as any
    expect(resolveWsUrl('/api/ws', mockLocation)).toBe('ws://localhost:3000/api/ws')
  })
})

describe('OrbitalSocket', () => {
  let factory: FakeWebSocketFactory
  let socket: OrbitalSocket

  beforeEach(() => {
    factory = new FakeWebSocketFactory()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (socket) {
      socket.close()
    }
  })

  describe('basic subscribe/unsubscribe', () => {
    it('should send subscribe frame on first handler for a topic', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const handler = vi.fn()
      const unsub = socket.subscribe('test-topic', handler)

      // Wait for socket to open
      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      expect(factory.instances[0].sent).toContainEqual({
        type: 'subscribe',
        topic: 'test-topic',
      })
    })

    it('should not send duplicate subscribe frames for same topic', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const handler1 = vi.fn()
      const handler2 = vi.fn()

      socket.subscribe('test-topic', handler1)
      socket.subscribe('test-topic', handler2)

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      const subscribes = factory.instances[0].sent.filter(
        (msg) => msg.type === 'subscribe' && msg.topic === 'test-topic'
      )
      expect(subscribes).toHaveLength(1)
    })

    it('should send unsubscribe only when last handler leaves', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const handler1 = vi.fn()
      const handler2 = vi.fn()

      const unsub1 = socket.subscribe('test-topic', handler1)
      const unsub2 = socket.subscribe('test-topic', handler2)

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      const sent = [...factory.instances[0].sent]
      expect(sent).toContainEqual({
        type: 'subscribe',
        topic: 'test-topic',
      })

      // Unsubscribe first handler
      unsub1()
      expect(factory.instances[0].sent.length).toBe(1) // No unsubscribe yet

      // Unsubscribe second handler
      unsub2()
      expect(factory.instances[0].sent).toContainEqual({
        type: 'unsubscribe',
        topic: 'test-topic',
      })
    })
  })

  describe('message routing', () => {
    it('should route messages by topic to correct handler', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const handler1 = vi.fn()
      const handler2 = vi.fn()

      socket.subscribe('topic-1', handler1)
      socket.subscribe('topic-2', handler2)

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      factory.instances[0].simulateMessage({
        topic: 'topic-1',
        data: 'message1',
      })

      expect(handler1).toHaveBeenCalledWith({
        topic: 'topic-1',
        data: 'message1',
      })
      expect(handler2).not.toHaveBeenCalled()
    })

    it('should call all handlers for the same topic', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const handler1 = vi.fn()
      const handler2 = vi.fn()

      socket.subscribe('topic-1', handler1)
      socket.subscribe('topic-1', handler2)

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      factory.instances[0].simulateMessage({
        topic: 'topic-1',
        data: 'message1',
      })

      expect(handler1).toHaveBeenCalledWith({
        topic: 'topic-1',
        data: 'message1',
      })
      expect(handler2).toHaveBeenCalledWith({
        topic: 'topic-1',
        data: 'message1',
      })
    })
  })

  describe('malformed JSON handling', () => {
    it('should ignore malformed JSON without throwing', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const handler = vi.fn()
      socket.subscribe('test-topic', handler)

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      // Send malformed message
      expect(() => {
        factory.instances[0].simulateMalformedMessage('not valid json{')
      }).not.toThrow()

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('status tracking', () => {
    it('should start with connecting status', () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      expect(socket.status).toBe('connecting')
    })

    it('should transition to open when socket opens', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const statusChanges: string[] = []
      socket.onStatusChange((status) => {
        statusChanges.push(status)
      })

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      expect(socket.status).toBe('open')
      expect(statusChanges).toContain('open')
    })

    it('should transition to closed when socket closes', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const statusChanges: string[] = []
      socket.onStatusChange((status) => {
        statusChanges.push(status)
      })

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()
      factory.instances[0].simulateClose()

      expect(socket.status).toBe('closed')
      expect(statusChanges).toContain('closed')
    })

    it('should call onStatusChange callback', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const callback = vi.fn()
      socket.onStatusChange(callback)

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      expect(callback).toHaveBeenCalledWith('open')
    })
  })

  describe('reconnect behavior', () => {
    it('should create new socket after close with delay', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 5000,
      })

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()
      expect(factory.instances).toHaveLength(1)

      factory.instances[0].simulateClose()
      expect(socket.status).toBe('closed')

      // Should still be 1 socket until delay expires
      await vi.advanceTimersByTimeAsync(4000)
      expect(factory.instances).toHaveLength(1)

      // Now advance past the delay
      await vi.advanceTimersByTimeAsync(1000)
      expect(factory.instances).toHaveLength(2)
    })

    it('should resubscribe to all active topics on reconnect', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const handler1 = vi.fn()
      const handler2 = vi.fn()

      socket.subscribe('topic-1', handler1)
      socket.subscribe('topic-2', handler2)

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      const firstSent = [...factory.instances[0].sent]
      factory.instances[0].simulateClose()

      // Advance past reconnect delay
      await vi.advanceTimersByTimeAsync(1000)
      factory.instances[1].simulateOpen()

      expect(factory.instances[1].sent).toContainEqual({
        type: 'subscribe',
        topic: 'topic-1',
      })
      expect(factory.instances[1].sent).toContainEqual({
        type: 'subscribe',
        topic: 'topic-2',
      })
    })

    it('should not resubscribe to unsubscribed topics after reconnect', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const handler1 = vi.fn()
      const handler2 = vi.fn()

      const unsub1 = socket.subscribe('topic-1', handler1)
      const unsub2 = socket.subscribe('topic-2', handler2)

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      // Unsubscribe from topic-1
      unsub1()

      factory.instances[0].simulateClose()

      // Advance past reconnect delay
      await vi.advanceTimersByTimeAsync(1000)
      factory.instances[1].simulateOpen()

      // Should only resubscribe to topic-2
      expect(factory.instances[1].sent).not.toContainEqual({
        type: 'subscribe',
        topic: 'topic-1',
      })
      expect(factory.instances[1].sent).toContainEqual({
        type: 'subscribe',
        topic: 'topic-2',
      })
    })
  })

  describe('message queuing before open', () => {
    it('should queue subscribe messages before socket opens', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      // Subscribe before socket is created or opened
      const handler = vi.fn()
      socket.subscribe('test-topic', handler)

      // Don't open yet, advance timers to create socket
      await vi.advanceTimersByTimeAsync(0)

      // The subscribe should be queued
      expect(factory.instances[0].sent).toHaveLength(0)

      // Now open the socket
      factory.instances[0].simulateOpen()

      // Now the queued message should be sent
      expect(factory.instances[0].sent).toContainEqual({
        type: 'subscribe',
        topic: 'test-topic',
      })
    })

    it('should flush queued messages in order when socket opens', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const handler1 = vi.fn()
      const handler2 = vi.fn()
      const handler3 = vi.fn()

      socket.subscribe('topic-1', handler1)
      socket.subscribe('topic-2', handler2)
      socket.subscribe('topic-3', handler3)

      await vi.advanceTimersByTimeAsync(0)
      expect(factory.instances[0].sent).toHaveLength(0)

      factory.instances[0].simulateOpen()

      expect(factory.instances[0].sent).toHaveLength(3)
      expect(factory.instances[0].sent[0]).toEqual({
        type: 'subscribe',
        topic: 'topic-1',
      })
      expect(factory.instances[0].sent[1]).toEqual({
        type: 'subscribe',
        topic: 'topic-2',
      })
      expect(factory.instances[0].sent[2]).toEqual({
        type: 'subscribe',
        topic: 'topic-3',
      })
    })
  })

  describe('edge cases', () => {
    it('should handle unsubscribe before socket opens', () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      const handler = vi.fn()
      const unsub = socket.subscribe('test-topic', handler)

      // Unsubscribe before opening
      unsub()

      // Should not crash
      expect(factory.instances).toBeDefined()
    })

    it('should handle calling close()', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      socket.close()

      // Should not create a new socket on reconnect after close()
      await vi.advanceTimersByTimeAsync(2000)
      expect(factory.instances).toHaveLength(1)
    })

    it('should cancel pending reconnect when close() is called', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 5000,
      })

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      factory.instances[0].simulateClose()
      expect(factory.instances).toHaveLength(1)

      // Advance some but not all the way
      await vi.advanceTimersByTimeAsync(2000)
      socket.close()

      // Advance past where the reconnect would have happened
      await vi.advanceTimersByTimeAsync(5000)
      expect(factory.instances).toHaveLength(1)
    })

    it('should handle receiving message before any handlers are registered', async () => {
      socket = new OrbitalSocket('ws://localhost/ws', {
        WebSocketImpl: (url: string) => factory.create(url),
        reconnectDelayMs: 1000,
      })

      await vi.runAllTimersAsync()
      factory.instances[0].simulateOpen()

      // Send a message with no handlers
      expect(() => {
        factory.instances[0].simulateMessage({
          topic: 'no-handlers',
          data: 'test',
        })
      }).not.toThrow()
    })
  })
})
