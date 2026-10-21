import type { IncomingHttpHeaders } from 'node:http';
import type { InjectOptions } from 'fastify';
import { tokenMatches } from '../auth/token.js';

/**
 * Set on every request a channel injects, to the id of the member that
 * asked: how a route tells a request that came over a channel from one
 * made on this device.
 */
export const DEVICE_HEADER = 'x-orbital-device';

/**
 * Set on every request a session's orbital MCP tools make of Orbital's own
 * routes (`runner.control` in `index.ts`), to a key made fresh at every
 * start and never sent anywhere: how a route tells a session's request from
 * the user's on this Mac. Only the key counts — a caller from the network
 * cannot know it, so cannot pass for a session.
 */
export const CONTROL_HEADER = 'x-orbital-control';

/** Whether the request carries this start's control key (`CONTROL_HEADER`). */
export function isControlRequest(headers: IncomingHttpHeaders, controlKey: string | undefined): boolean {
  const value = headers[CONTROL_HEADER];
  return controlKey !== undefined && typeof value === 'string' && tokenMatches(value, controlKey);
}

/**
 * How a member's REST call enters Fastify: in-process, through the same host
 * guard as the browser (satisfied by the header) and the same token guard
 * (satisfied by the bearer; `undefined` only where `buildServer` runs without
 * a token, as in tests). `content-type` only rides along with a body —
 * Fastify refuses a JSON content type with an empty body
 * (`FST_ERR_CTP_EMPTY_JSON_BODY`), and body-less POSTs like `/interrupt` are
 * exactly what a phone sends. `device` is the asking member's id, carried as
 * `DEVICE_HEADER`; a request this device makes of itself has none. `control`
 * is the control key, on a session's own request (`CONTROL_HEADER`).
 */
export function remoteInjectOptions(
  req: { method: string; url: string; payload?: unknown; device?: string; control?: string },
  apiToken: string | undefined,
): InjectOptions {
  const headers: Record<string, string> = { host: '127.0.0.1' };
  if (apiToken !== undefined) headers.authorization = `Bearer ${apiToken}`;
  if (req.payload !== undefined) headers['content-type'] = 'application/json';
  if (req.device !== undefined) headers[DEVICE_HEADER] = req.device;
  if (req.control !== undefined) headers[CONTROL_HEADER] = req.control;
  return {
    method: req.method as InjectOptions['method'],
    url: req.url,
    payload: req.payload as InjectOptions['payload'],
    headers,
  };
}
