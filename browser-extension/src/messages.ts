/** What the content script and the popup tell the service worker, and the state they read back. */

import type { ConnectionStatus } from './connection'

export type WorkerMessage =
  | { kind: 'selection'; text: string; url: string; title: string }
  | { kind: 'screenshot' }
  | { kind: 'pair'; code: string }
  | { kind: 'unpair' }
  /** The popup opened: connect now if the worker had given up or slept. */
  | { kind: 'wake' }

/** `chrome.storage.local`: survives restarts. */
export const LOCAL_KEYS = { token: 'token', port: 'port' } as const

/** `chrome.storage.session`, key `bridge`: what the popup shows. */
export const SESSION_KEY = 'bridge'

export interface BridgeState {
  status: ConnectionStatus
  /** The server's reason the last pairing code was refused. */
  pairError?: string
  /** When the last check found nothing on the port ("checked just now"). */
  checkedAt?: number
  /**
   * The last screenshot the user took and its fate. It stays until the
   * next one; selections leave no line (canvas 64g).
   */
  lastShot?: { delivered: boolean; text: string; at: number }
  /**
   * The agent's last `browser_screenshot` this extension served. The
   * server's `capture` frame names no session, so neither does the popup.
   */
  agentShot?: { at: number }
}

export function parsePort(value: unknown, fallback: number): number {
  const port = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback
}
