import { configureApi } from '../../../web/src/lib/api'
import { configureSocket } from '../../../web/src/lib/socket'
import { FakeServer, type DemoWorld } from './fakeServer'

/**
 * Points the app's two transports at a fake server: `/api` through
 * `configureApi({ fetch })` and the WebSocket through `configureSocket` —
 * the same two seams the phone uses to carry them over the relay. Call it
 * before anything renders: `configureSocket` refuses once the app's socket
 * exists.
 */
export function installFakeServer(world: DemoWorld): FakeServer {
  const server = new FakeServer(world)
  configureApi({ fetch: server.fetch })
  configureSocket({ WebSocketImpl: server.hub.WebSocket })
  return server
}

/**
 * Caps the device pixel ratio the map's canvas renders at. The page is drawn
 * at its virtual viewport and scaled down by the website, so pixels past the
 * cap are thrown away by the downscale — and cost the frame rate. R3F reads
 * `window.devicePixelRatio` for its default `dpr`, so capping what it reads
 * caps the canvas without a prop on `SpaceMap`; CSS rendering does not read
 * this property and is unaffected.
 */
export function capDevicePixelRatio(max: number): void {
  const actual = window.devicePixelRatio
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => Math.min(actual, max) })
}

/** Tells the embedding page the demo has drawn, so it can drop the poster. */
export function announceReady(): void {
  window.parent.postMessage({ type: 'orbital-demo-ready' }, '*')
}
