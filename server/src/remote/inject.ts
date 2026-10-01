import type { InjectOptions } from 'fastify';

/**
 * How a phone's REST call enters Fastify: in-process, through the same host
 * guard as the browser (satisfied by the header). `content-type` only rides
 * along with a body — Fastify refuses a JSON content type with an empty body
 * (`FST_ERR_CTP_EMPTY_JSON_BODY`), and body-less POSTs like `/interrupt` are
 * exactly what a phone sends.
 */
export function remoteInjectOptions(req: { method: string; url: string; payload?: unknown }): InjectOptions {
  return {
    method: req.method as InjectOptions['method'],
    url: req.url,
    payload: req.payload as InjectOptions['payload'],
    headers: req.payload === undefined
      ? { host: '127.0.0.1' }
      : { host: '127.0.0.1', 'content-type': 'application/json' },
  };
}
