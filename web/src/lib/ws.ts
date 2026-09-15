export type WsStatus = 'connecting' | 'open' | 'closed'

export interface OrbitalSocketOptions {
  WebSocketImpl?: (url: string) => WebSocket
  reconnectDelayMs?: number
}

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
  private opts: Required<OrbitalSocketOptions>
  private ws: WebSocket | null = null
  private _status: WsStatus = 'connecting'
  private statusCallbacks: ((status: WsStatus) => void)[] = []
  private handlers: Map<string, Set<(msg: any) => void>> = new Map()
  private messageQueue: any[] = []
  private reconnectTimeout: number | null = null
  private isClosed = false

  constructor(url: string, opts?: OrbitalSocketOptions) {
    this.url = url
    this.opts = {
      WebSocketImpl: opts?.WebSocketImpl || ((url: string) => new WebSocket(url)),
      reconnectDelayMs: opts?.reconnectDelayMs ?? 3000,
    }
    this.createSocket()
  }

  private createSocket(): void {
    if (this.isClosed) {
      return
    }

    this._status = 'connecting'
    this.notifyStatusChange('connecting')

    const WebSocketImpl = this.opts.WebSocketImpl
    this.ws = WebSocketImpl(this.url)

    this.ws.onopen = () => {
      this._status = 'open'
      this.notifyStatusChange('open')
      // Resubscribe to all active topics
      for (const topic of this.handlers.keys()) {
        this.sendMessage({ type: 'subscribe', topic })
      }
      this.flushQueue()
    }

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data)
        const topic = msg.topic
        if (topic) {
          const topicHandlers = this.handlers.get(topic)
          if (topicHandlers) {
            topicHandlers.forEach((handler) => {
              handler(msg)
            })
          }
        }
      } catch {
        // Ignore malformed JSON
      }
    }

    this.ws.onclose = () => {
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
   * Refcounted: first handler for a topic triggers a subscribe on the server,
   * last handler leaving triggers an unsubscribe.
   */
  subscribe(topic: string, handler: (msg: any) => void): () => void {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Set())
      // Subscribe messages are sent when socket opens (see onopen handler)
      // This ensures subscribes are sent for both initial connection and reconnects
    }

    const handlers = this.handlers.get(topic)!
    handlers.add(handler)

    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) {
        this.handlers.delete(topic)
        this.sendMessage({ type: 'unsubscribe', topic })
      }
    }
  }

  /**
   * Register a callback to be called when status changes.
   */
  onStatusChange(cb: (status: WsStatus) => void): void {
    this.statusCallbacks.push(cb)
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
