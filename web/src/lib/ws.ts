export type WsStatus = 'connecting' | 'open' | 'closed'

export interface OrbitalSocketOptions {
  WebSocketImpl?: typeof WebSocket | ((url: string) => WebSocket)
  reconnectDelayMs?: number
  heartbeatTimeoutMs?: number
}

/**
 * How long the socket tolerates silence before assuming the connection is
 * dead. Several times the server's heartbeat interval, so one lost frame
 * doesn't kill a healthy connection
 * (spec: 2026-09-22-ws-reconnect-resync-design).
 */
export const HEARTBEAT_TIMEOUT_MS = 45_000

/**
 * Resolves a WebSocket path to a full URL with correct scheme (ws: or wss:)
 * based on the current location protocol.
 */
export function resolveWsUrl(path: string, location: Pick<Location, 'protocol' | 'host'>): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}${path}`
}

/**
 * A refcounted WebSocket client with auto-reconnect and topic-based message routing.
 */
export class OrbitalSocket {
  private url: string
  private opts: {
    WebSocketImpl: typeof WebSocket | ((url: string) => WebSocket)
    reconnectDelayMs: number
    heartbeatTimeoutMs: number
  }
  private ws: WebSocket | null = null
  private _status: WsStatus = 'connecting'
  private statusCallbacks: ((status: WsStatus) => void)[] = []
  // Track subscription ref counts: topic -> handler -> count
  private subscriptions: Map<string, Map<(msg: any) => void, number>> = new Map()
  // Track which topics have active subscriptions
  private handlers: Map<string, Set<(msg: any) => void>> = new Map()
  private messageQueue: any[] = []
  private reconnectTimeout: number | null = null
  private watchdogTimeout: number | null = null
  private isClosed = false

  constructor(url: string = '/ws', opts?: OrbitalSocketOptions) {
    this.url = url
    this.opts = {
      WebSocketImpl: opts?.WebSocketImpl || WebSocket,
      reconnectDelayMs: opts?.reconnectDelayMs ?? 3000,
      heartbeatTimeoutMs: opts?.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS,
    }
    this.createSocket()
  }

  private createSocket(): void {
    if (this.isClosed) {
      return
    }

    this._status = 'connecting'
    this.notifyStatusChange('connecting')

    // Handle both class constructors and factory functions
    const impl = this.opts.WebSocketImpl
    this.ws = impl instanceof Function && impl.prototype
      ? new (impl as typeof WebSocket)(this.url)
      : (impl as (url: string) => WebSocket)(this.url)

    this.ws.onopen = () => {
      this._status = 'open'
      this.notifyStatusChange('open')
      this.armWatchdog()

      // Clear all queued control frames (subscribe/unsubscribe) to avoid stale frames
      this.messageQueue = this.messageQueue.filter(
        (msg) => msg.type !== 'subscribe' && msg.type !== 'unsubscribe'
      )

      // Resend subscribe for all currently active topics
      for (const topic of this.handlers.keys()) {
        this.sendMessage({ type: 'subscribe', topic })
      }

      this.flushQueue()
    }

    this.ws.onmessage = (event: MessageEvent) => {
      // Any frame proves the connection is alive, the server's topic-less
      // heartbeat included — it is dropped by the routing below and exists
      // only for this line.
      this.armWatchdog()
      try {
        const msg = JSON.parse(event.data)
        const topic = msg.topic
        if (topic) {
          const topicHandlers = this.handlers.get(topic)
          if (topicHandlers) {
            topicHandlers.forEach((handler) => {
              try {
                handler(msg)
              } catch (err) {
                console.warn(`Handler error for topic ${topic}:`, err)
              }
            })
          }
        }
      } catch {
        // Ignore malformed JSON
      }
    }

    this.ws.onclose = () => {
      this.clearWatchdog()
      this._status = 'closed'
      this.notifyStatusChange('closed')
      this.ws = null

      // Schedule reconnect if not explicitly closed
      if (!this.isClosed) {
        this.reconnectTimeout = window.setTimeout(() => {
          this.createSocket()
        }, this.opts.reconnectDelayMs)
      }
    }
  }

  /**
   * (Re)starts the silence countdown. A connection can die without ever
   * firing `onclose` — a slept laptop, a suspended renderer — and then
   * nothing reconnects and no banner appears. Closing the socket ourselves
   * puts that case back on the normal `onclose` -> reconnect path.
   */
  private armWatchdog(): void {
    this.clearWatchdog()
    this.watchdogTimeout = window.setTimeout(() => {
      this.watchdogTimeout = null
      this.ws?.close()
    }, this.opts.heartbeatTimeoutMs)
  }

  private clearWatchdog(): void {
    if (this.watchdogTimeout !== null) {
      clearTimeout(this.watchdogTimeout)
      this.watchdogTimeout = null
    }
  }

  private flushQueue(): void {
    while (this.messageQueue.length > 0 && this.ws && this.ws.readyState === 1) {
      const msg = this.messageQueue.shift()
      this.ws.send(JSON.stringify(msg))
    }
  }

  private sendMessage(msg: any): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg))
    } else {
      this.messageQueue.push(msg)
    }
  }

  private notifyStatusChange(status: WsStatus): void {
    this.statusCallbacks.forEach((cb) => cb(status))
  }

  /**
   * Subscribe to a topic with a handler. Returns an unsubscribe function.
   * Refcounted: first subscription to a topic triggers subscribe,
   * last subscription leaving triggers unsubscribe. Supports same handler
   * subscribed multiple times (each unsubscribe is idempotent).
   */
  subscribe(topic: string, handler: (msg: any) => void): () => void {
    // Initialize topic structures if needed
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, new Map())
      this.handlers.set(topic, new Set())
      // Send subscribe on first subscription to this topic
      this.sendMessage({ type: 'subscribe', topic })
    }

    // Track this subscription (increment ref count for this handler)
    const topicSubs = this.subscriptions.get(topic)!
    const currentCount = topicSubs.get(handler) ?? 0
    topicSubs.set(handler, currentCount + 1)

    // Add handler to active set (may already be there from previous subscription)
    const handlers = this.handlers.get(topic)!
    handlers.add(handler)

    // Return idempotent unsubscribe function
    let unsubCalled = false
    return () => {
      if (unsubCalled) {
        return
      }
      unsubCalled = true

      const topicSubs = this.subscriptions.get(topic)
      if (!topicSubs) return

      const count = topicSubs.get(handler) ?? 0
      if (count > 1) {
        // Decrement ref count, handler stays subscribed
        topicSubs.set(handler, count - 1)
      } else {
        // Remove this handler's subscription
        topicSubs.delete(handler)

        // Check if any subscriptions remain for this topic
        if (topicSubs.size === 0) {
          // No more subscriptions for this topic
          this.subscriptions.delete(topic)

          // Remove handler from active set and cleanup
          const handlers = this.handlers.get(topic)
          if (handlers) {
            handlers.delete(handler)
            if (handlers.size === 0) {
              this.handlers.delete(topic)
              this.sendMessage({ type: 'unsubscribe', topic })
            }
          }
        } else {
          // Other handlers still subscribed, just remove this handler
          const handlers = this.handlers.get(topic)
          if (handlers) {
            handlers.delete(handler)
          }
        }
      }
    }
  }

  /**
   * Register a callback to be called when status changes.
   * The callback is invoked immediately with the current status.
   * Returns an unsubscribe function — callers (e.g. a React effect) must
   * call it on cleanup, or repeated mount/unmount (StrictMode's dev-only
   * double-invoke, or any component that mounts more than once over the
   * page's lifetime) accumulates duplicate callbacks forever, each firing
   * on every future status change.
   */
  onStatusChange(cb: (status: WsStatus) => void): () => void {
    this.statusCallbacks.push(cb)
    // Invoke immediately with current status
    cb(this._status)

    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      const idx = this.statusCallbacks.indexOf(cb)
      if (idx !== -1) this.statusCallbacks.splice(idx, 1)
    }
  }

  /**
   * Get the current status.
   */
  get status(): WsStatus {
    return this._status
  }

  /**
   * Close the connection and cancel any pending reconnects.
   */
  close(): void {
    this.isClosed = true
    // Not left to `onclose`: a real socket fires it asynchronously, or never
    // once the page is going away, and the watchdog must not outlive us.
    this.clearWatchdog()
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}
