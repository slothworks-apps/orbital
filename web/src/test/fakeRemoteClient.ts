import { vi } from 'vitest'
import type { BlobResult, PutBlobResult, RemoteClientEvent, TunnelResponse } from '@orbital/shared/remote/client'
import type { NotificationSettings } from '@orbital/shared/remote/messages'
import type { SwappableClient } from '../mobile/transport/clientRef'

const RULES: NotificationSettings = {
  needsInput: true, sessionEnded: true, sessionFailed: true, onlyWhenBackground: true, sound: true,
}

/**
 * The client's surface with nothing behind it: tests drive it with `emit`
 * and stub its calls. The real client is covered against the real Mac
 * (server/test/remoteClient.test.ts); this layer only has to be wired right.
 */
export class FakeClient implements SwappableClient {
  ready = false
  private readonly listeners = new Set<(event: RemoteClientEvent) => void>()
  readonly stop = vi.fn(() => {})
  readonly request = vi.fn(
    async (_method: string, _path: string, _body?: unknown): Promise<TunnelResponse> => ({ status: 200, body: {} }),
  )
  readonly getBlob = vi.fn(
    async (_ref: string): Promise<BlobResult> => ({ status: 404, bytes: new Uint8Array(0), mediaType: null }),
  )
  readonly putBlob = vi.fn(
    async (_bytes: Uint8Array, _mediaType: string): Promise<PutBlobResult> => ({ kind: 'not_image' }),
  )
  readonly subscribe = vi.fn((_topic: string) => {})
  readonly unsubscribe = vi.fn((_topic: string) => {})
  readonly getNotifications = vi.fn(async (): Promise<NotificationSettings> => RULES)
  readonly setNotifications = vi.fn(async (settings: NotificationSettings): Promise<NotificationSettings> => settings)
  readonly seen = vi.fn((_sessionId: string) => {})
  readonly pushToken = vi.fn((_token: string) => {})
  readonly recheck = vi.fn(async (_windowMs: number): Promise<boolean> => true)

  on(listener: (event: RemoteClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: RemoteClientEvent): void {
    if (event.type === 'ready') this.ready = event.ready
    for (const listener of [...this.listeners]) listener(event)
  }
}
