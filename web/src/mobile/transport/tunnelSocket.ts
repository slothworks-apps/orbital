import type { RemoteClientEvent } from '@orbital/shared/remote/client'
import type { TunnelClient } from './clientRef'

/**
 * The WebSocket surface `OrbitalSocket` drives (`lib/ws.ts`), over the
 * tunnel (spec § 3): open exactly while the client has a cipher and the
 * Mac's hello; a subscribe or unsubscribe it is sent becomes the client's
 * own; every hub frame comes back as a message. `OrbitalSocket`'s reconnect
 * and heartbeat watchdog stay as they are — the tunnel's liveness reaches
 * them as open and close.
 */
export class TunnelSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readyState: number = TunnelSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private detach: (() => void) | null
  private readonly client: Pick<TunnelClient, 'ready' | 'on' | 'subscribe' | 'unsubscribe'>

  constructor(client: Pick<TunnelClient, 'ready' | 'on' | 'subscribe' | 'unsubscribe'>) {
    this.client = client
    this.detach = client.on((event) => this.onEvent(event))
    // Never inside the constructor: `OrbitalSocket` assigns its handlers after constructing.
    if (client.ready) queueMicrotask(() => this.open())
  }

  send(data: string): void {
    if (this.readyState !== TunnelSocket.OPEN) return
    let msg: { type?: unknown; topic?: unknown }
    try {
      msg = JSON.parse(data) as { type?: unknown; topic?: unknown }
    } catch {
      return
    }
    if (typeof msg.topic !== 'string') return
    if (msg.type === 'subscribe') this.client.subscribe(msg.topic)
    else if (msg.type === 'unsubscribe') this.client.unsubscribe(msg.topic)
  }

  /** As a real socket does, `onclose` follows asynchronously. */
  close(): void {
    if (this.readyState === TunnelSocket.CLOSED) return
    this.readyState = TunnelSocket.CLOSED
    this.detach?.()
    this.detach = null
    queueMicrotask(() => this.onclose?.())
  }

  private onEvent(event: RemoteClientEvent): void {
    if (event.type === 'ready') {
      if (event.ready) this.open()
      else this.shut()
      return
    }
    if (event.type === 'hub' && this.readyState === TunnelSocket.OPEN) {
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event.frame) }))
    }
  }

  private open(): void {
    if (this.readyState !== TunnelSocket.CONNECTING || !this.client.ready) return
    this.readyState = TunnelSocket.OPEN
    this.onopen?.()
  }

  private shut(): void {
    if (this.readyState === TunnelSocket.CLOSED) return
    this.readyState = TunnelSocket.CLOSED
    this.detach?.()
    this.detach = null
    this.onclose?.()
  }
}
