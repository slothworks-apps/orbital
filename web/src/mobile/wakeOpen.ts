import type { TunnelClient } from './transport/clientRef'

/** How long a tapped push waits for a device to come up and answer before the list stays. */
export const WAKE_OPEN_WAIT_MS = 10_000

const WAKE_TAG = /^[0-9a-f]{32}$/

/** The wake token a relay push carries in its data, or null for a push without one (an older relay). */
export function wakeTagOf(data: unknown): string | null {
  const tag = typeof data === 'object' && data !== null ? (data as { tag?: unknown }).tag : undefined
  return typeof tag === 'string' && WAKE_TAG.test(tag) ? tag : null
}

/**
 * The session a tapped relay push stands for (spec
 * 2026-11-26-push-tap-opens-the-session-design): once the tunnel is up, the
 * devices are asked which of them sent `tag`. Null when none says, or none
 * comes up within `waitMs`; the tap then leaves the list on screen.
 */
export async function sessionForWake(
  client: Pick<TunnelClient, 'ready' | 'on' | 'request'>,
  tag: string,
  supported: () => boolean,
  waitMs: number = WAKE_OPEN_WAIT_MS,
): Promise<string | null> {
  const deadline = Date.now() + waitMs
  if (!(await untilReady(client, waitMs))) return null
  if (!supported()) return null
  try {
    const answer = await withTimeout(client.request('GET', `/api/wake/${tag}`), Math.max(0, deadline - Date.now()))
    const body = answer?.body as { sessionId?: unknown } | undefined
    return answer?.status === 200 && typeof body?.sessionId === 'string' && body.sessionId ? body.sessionId : null
  } catch {
    return null
  }
}

function untilReady(client: Pick<TunnelClient, 'ready' | 'on'>, waitMs: number): Promise<boolean> {
  if (client.ready) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve(false)
    }, waitMs)
    const off = client.on((event) => {
      if (event.type !== 'ready' || !event.ready) return
      clearTimeout(timer)
      off()
      resolve(true)
    })
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
    }),
  ])
}
