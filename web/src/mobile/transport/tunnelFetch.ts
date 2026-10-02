import { TunnelError, type HttpMethod } from '@orbital/shared/remote/client'
import type { TunnelClient } from './clientRef'

const METHODS: ReadonlySet<string> = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * `/api/...` as the Mac's router sees it — path and query, nothing else —
 * or null for anything that is not this page's API. `api.ts` builds some
 * URLs on `window.location.origin` and passes others relative; both land here.
 */
export function tunnelPath(input: string, origin: string): string | null {
  let url: URL
  try {
    url = new URL(input, origin)
  } catch {
    return null
  }
  if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/api/')) return null
  return url.pathname + url.search
}

/**
 * The Mac's `http_res` as a `Response`: a 413 or 403 is an ordinary status
 * (spec § 3), JSON bodies travel as JSON, a non-JSON answer as the text the
 * Mac sent. A status `Response` cannot carry reads as a bad gateway.
 */
export function toResponse(status: number, body: unknown): Response {
  if (status === 204 || status === 205 || status === 304) return new Response(null, { status })
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null)
  const contentType = typeof body === 'string' ? 'text/plain' : 'application/json'
  return new Response(text, {
    status: status >= 200 && status <= 599 ? status : 502,
    headers: { 'content-type': contentType },
  })
}

/**
 * `api.ts`'s transport on the phone (`configureApi`). A failure to deliver
 * rejects with a `TypeError`, exactly as `fetch` does on a network error,
 * so every caller's existing handling applies unchanged. Multipart bodies
 * are refused: 2b sends photos as blobs (spec § 3).
 */
export function makeTunnelFetch(
  client: Pick<TunnelClient, 'request'>,
  origin: string = window.location.origin,
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const path = tunnelPath(input, origin)
    if (path === null) throw new TypeError(`not tunnelled: ${input}`)
    const method = (init.method ?? 'GET').toUpperCase()
    if (!METHODS.has(method)) throw new TypeError(`method not tunnelled: ${method}`)
    let body: unknown
    // An empty string is how a caller with nothing to send still sets a body; it carries no JSON.
    if (init.body !== undefined && init.body !== null && init.body !== '') {
      if (typeof init.body !== 'string') throw new TypeError('only JSON bodies are tunnelled')
      try {
        body = JSON.parse(init.body)
      } catch {
        throw new TypeError('only JSON bodies are tunnelled')
      }
    }
    let answer
    try {
      answer = await client.request(method as HttpMethod, path, body)
    } catch (err) {
      throw new TypeError(err instanceof TunnelError ? `tunnel ${err.reason}` : 'tunnel failed', { cause: err })
    }
    return toResponse(answer.status, answer.body)
  }
}
