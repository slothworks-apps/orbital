import { OrbitalSocket, resolveWsUrl } from './ws'

let instance: OrbitalSocket | null = null

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
  if (!instance) instance = new OrbitalSocket(resolveWsUrl('/ws', window.location))
  return instance
}
