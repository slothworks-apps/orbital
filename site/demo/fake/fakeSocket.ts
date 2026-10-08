import { HEARTBEAT_TIMEOUT_MS } from '../../../web/src/lib/ws'

/**
 * The demo's stand-in for the server's WebSocket hub. The app's one
 * connection (`web/src/lib/socket.ts`) is built on whatever `configureSocket`
 * hands it — the phone hands it the relay tunnel, a demo hands it
 * `hub.WebSocket` — so every component that subscribes to a topic hears the
 * scenario exactly as it would hear the server.
 *
 * Frames are shaped as the server's hub sends them (`server/src/api/hub.ts`):
 * `{ topic, ...payload }`, to the sockets subscribed to that topic only.
 */
export class FakeHub {
  private sockets = new Set<FakeWebSocket>()

  /** What `configureSocket({ WebSocketImpl })` takes: a factory, not a class. */
  readonly WebSocket = (url: string): WebSocket => {
    const socket = new FakeWebSocket(url, this)
    this.sockets.add(socket)
    return socket as unknown as WebSocket
  }

  /** Delivers one event on `topic`, as `hub.publish` does on the server. */
  publish(topic: string, payload: Record<string, unknown>): void {
    const data = JSON.stringify({ topic, ...payload })
    for (const socket of this.sockets) {
      if (socket.topics.has(topic)) socket.deliver(data)
    }
  }

  /** Called by a socket the client closed. */
  forget(socket: FakeWebSocket): void {
    this.sockets.delete(socket)
  }
}

/**
 * How often the fake proves the connection alive. The client closes and
 * reconnects a socket that stays silent for `HEARTBEAT_TIMEOUT_MS`, and a demo
 * can be left alone far longer than that.
 */
const HEARTBEAT_EVERY_MS = HEARTBEAT_TIMEOUT_MS / 3

/**
 * Just enough of `WebSocket` for `OrbitalSocket`: the four handlers, `send`,
 * `close` and `readyState`. It opens on the next task, as a real one opens
 * asynchronously, and reads the client's `subscribe` / `unsubscribe` frames
 * to know which topics it carries.
 */
class FakeWebSocket {
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly topics = new Set<string>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  readonly url: string
  private readonly hub: FakeHub

  constructor(url: string, hub: FakeHub) {
    this.url = url
    this.hub = hub
    setTimeout(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.(new Event('open'))
      this.heartbeat = setInterval(
        () => this.deliver(JSON.stringify({ type: 'heartbeat', topics: [...this.topics] })),
        HEARTBEAT_EVERY_MS,
      )
    }, 0)
  }

  send(data: string): void {
    const frame = JSON.parse(data) as { type?: string; topic?: string }
    if (typeof frame.topic !== 'string') return
    if (frame.type === 'subscribe') this.topics.add(frame.topic)
    else if (frame.type === 'unsubscribe') this.topics.delete(frame.topic)
  }

  deliver(data: string): void {
    if (this.readyState !== 1) return
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  close(): void {
    if (this.readyState >= 2) return
    this.readyState = 3
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    this.hub.forget(this)
    // `OrbitalSocket` reads nothing off the event.
    this.onclose?.(new Event('close') as CloseEvent)
  }
}
