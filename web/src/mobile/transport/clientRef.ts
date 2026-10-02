import {
  TunnelError, type BlobResult, type HttpMethod, type RemoteClient, type RemoteClientEvent, type TunnelResponse,
} from '@orbital/shared/remote/client'
import type { NotificationSettings } from '@orbital/shared/remote/messages'

/** What the app calls on a client once it exists; `start`, `redeem` and `waitForPairing` stay with whoever made it. */
export type SwappableClient = Pick<
  RemoteClient,
  'ready' | 'on' | 'stop' | 'request' | 'getBlob' | 'subscribe' | 'unsubscribe' | 'getNotifications' | 'setNotifications' | 'seen' | 'recheck'
>

/** The part the three seams use. */
export type TunnelClient = Pick<SwappableClient, 'ready' | 'on' | 'request' | 'getBlob' | 'subscribe' | 'unsubscribe'>

/**
 * The one client the app talks to, swappable: pairing a different Mac
 * replaces the `RemoteClient` underneath, and the seams configured once at
 * boot (`tunnelFetch`, `TunnelSocket`, the image resolver) keep working
 * because they hold this, not the client.
 */
export class ClientRef implements SwappableClient {
  private current: SwappableClient | null = null
  private detach: (() => void) | null = null
  private readonly listeners = new Set<(event: RemoteClientEvent) => void>()

  get client(): SwappableClient | null {
    return this.current
  }

  get ready(): boolean {
    return this.current?.ready ?? false
  }

  /** Stops the previous client; a tunnel that was up reads as gone to every listener. */
  set(client: SwappableClient | null): void {
    const previous = this.current
    if (previous === client) return
    const wasReady = previous?.ready ?? false
    this.detach?.()
    this.detach = null
    this.current = client
    previous?.stop()
    if (wasReady) this.emit({ type: 'ready', ready: false })
    if (client) this.detach = client.on((event) => this.emit(event))
  }

  on(listener: (event: RemoteClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  stop(): void {
    this.current?.stop()
  }

  request(method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    return this.current ? this.current.request(method, path, body) : Promise.reject(new TunnelError('offline'))
  }

  getBlob(ref: string): Promise<BlobResult> {
    return this.current ? this.current.getBlob(ref) : Promise.reject(new TunnelError('offline'))
  }

  subscribe(topic: string): void {
    this.current?.subscribe(topic)
  }

  unsubscribe(topic: string): void {
    this.current?.unsubscribe(topic)
  }

  getNotifications(): Promise<NotificationSettings> {
    return this.current ? this.current.getNotifications() : Promise.reject(new TunnelError('offline'))
  }

  setNotifications(settings: NotificationSettings): Promise<NotificationSettings> {
    return this.current ? this.current.setNotifications(settings) : Promise.reject(new TunnelError('offline'))
  }

  seen(sessionId: string): void {
    this.current?.seen(sessionId)
  }

  recheck(windowMs: number): Promise<boolean> {
    return this.current ? this.current.recheck(windowMs) : Promise.resolve(false)
  }

  private emit(event: RemoteClientEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (err) {
        console.warn('orbital: a client listener failed', err)
      }
    }
  }
}

export const clientRef = new ClientRef()
