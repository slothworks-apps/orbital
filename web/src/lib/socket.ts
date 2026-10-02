import { OrbitalSocket, resolveWsUrl, type OrbitalSocketOptions } from './ws'

export type SocketImpl = NonNullable<OrbitalSocketOptions['WebSocketImpl']>

let instance: OrbitalSocket | null = null
let socketImpl: SocketImpl | null = null

/**
 * The WebSocket the app's one connection is built on. The phone passes a
 * factory for `TunnelSocket`, which speaks the hub over the relay (spec
 * 2026-10-02-mobile-app-design § 3); the desktop never calls this. It has
 * to run before the first `getSocket()`: a connection already open would
 * keep the old transport for the page's lifetime.
 */
export function configureSocket(opts: { WebSocketImpl: SocketImpl }): void {
  if (instance) throw new Error('configureSocket must run before the first getSocket()')
  socketImpl = opts.WebSocketImpl
}

/**
 * The app's single WebSocket connection.
 *
 * It lives here rather than in `App.tsx` because the store needs it too:
 * launching a session has to subscribe to `session:<id>` *before* it sends
 * `POST /api/sessions`, and that subscribe cannot wait for an effect to run
 * (see `docs/fixes/first-turn-can-outrun-the-ws-subscription.md`). Two
 * modules needing one connection means the connection belongs to neither.
 *
 * Constructed on first use, not at import. Every test file that touches the
 * store imports it transitively, and a socket built at import time would have
 * each of them open a real WebSocket against jsdom. `App.tsx` calls this at
 * module scope, which keeps the one property that matters there: created once
 * per page load, so React 18 `StrictMode`'s dev-only mount→cleanup→mount
 * cannot open a second connection.
 */
export function getSocket(): OrbitalSocket {
  if (!instance) {
    instance = new OrbitalSocket(
      resolveWsUrl('/ws', window.location),
      socketImpl ? { WebSocketImpl: socketImpl } : undefined,
    )
  }
  return instance
}
