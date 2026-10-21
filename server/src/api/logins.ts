import type { FastifyInstance, FastifyReply } from 'fastify';
import { DEVICE_HEADER, isControlRequest } from '../remote/inject.js';
import { cleanLoginCode, isLoginKind } from '../login/parse.js';
import type { LoginAnswer, LoginRefusal, LoginService, LoginStarter } from '../login/service.js';

/** What the routes ask of the group to name the device that started a login. */
export interface StarterNames {
  /** The name every member sees for this device. */
  selfName(): string;
  /** The name a member goes by here; null for a device this one does not know. */
  nameOf(id: string): string | null;
}

/** What a login started by a session's orbital MCP tools goes by. */
export const SESSION_STARTER_NAME = 'a session';

/**
 * Who started a login: the member whose channel carried the request
 * (`DEVICE_HEADER`, set by the channel, never by the caller's body), a
 * session's orbital MCP tools (`control`, the request carried this start's
 * control key), or this Mac's web. A member this device has no name for
 * goes by the start of its id, as the roster names an undescribed member.
 */
export function loginStarter(device: string | string[] | undefined, names: StarterNames, control = false): LoginStarter {
  if (typeof device === 'string' && device !== '') return { deviceId: device, name: names.nameOf(device) ?? device.slice(0, 8) };
  if (control) return { deviceId: null, name: SESSION_STARTER_NAME };
  return { deviceId: null, name: names.selfName() };
}

const REFUSAL_STATUS: Record<LoginRefusal, number> = { not_found: 404, no_cli: 503, no_login: 409 };

/**
 * A profile's login and its Claude Design sign-in (spec
 * 2026-10-21-log-in-from-orbital-design § 2). Every route answers the
 * profile's `ProfileLogin`; errors are `{ error }` — `not_found` (404),
 * `no_cli` (503), `no_login` (409: a code or a cancel with nothing running),
 * `bad_kind` and `bad_code` (400). On the device group's allowlist in the
 * `manage` group: logging this Mac in from a paired device is what that
 * grant is for. `controlKey` tells a session's own request (`CONTROL_HEADER`).
 */
export function registerLoginRoutes(
  app: FastifyInstance, logins: LoginService, names: StarterNames, controlKey?: string,
): void {
  const answer = (reply: FastifyReply, result: LoginAnswer) =>
    result.ok ? reply.send(result.login) : reply.code(REFUSAL_STATUS[result.error]).send({ error: result.error });

  /** The account, the design state and any running login; the status is read when none is cached. */
  app.get('/api/claude-dirs/:id/login', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const login = await logins.state(id);
    if (!login) return reply.code(404).send({ error: 'not_found' });
    return login;
  });

  /**
   * Starts a login of `kind`, or answers the running one. One a session
   * started runs with `BROWSER` silenced, like another device's: nobody at
   * this Mac asked for a browser, and the session hands the user the page.
   */
  app.post('/api/claude-dirs/:id/login', (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { kind?: unknown };
    if (!logins.has(id)) return reply.code(404).send({ error: 'not_found' });
    if (!isLoginKind(body.kind)) return reply.code(400).send({ error: 'bad_kind' });
    const control = isControlRequest(req.headers, controlKey);
    const starter = loginStarter(req.headers[DEVICE_HEADER], names, control);
    return answer(reply, logins.start(id, body.kind, starter, starter.deviceId !== null || control));
  });

  /** Hands the pasted code to the running login. */
  app.post('/api/claude-dirs/:id/login/code', (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { kind?: unknown; code?: unknown };
    if (!logins.has(id)) return reply.code(404).send({ error: 'not_found' });
    if (!isLoginKind(body.kind)) return reply.code(400).send({ error: 'bad_kind' });
    const code = cleanLoginCode(body.code);
    if (code === null) return reply.code(400).send({ error: 'bad_code' });
    return answer(reply, logins.code(id, body.kind, code));
  });

  /** Cancels the running login. */
  app.delete('/api/claude-dirs/:id/login/:kind', (req, reply) => {
    const { id: rawId, kind } = req.params as { id: string; kind: string };
    const id = Number(rawId);
    if (!logins.has(id)) return reply.code(404).send({ error: 'not_found' });
    if (!isLoginKind(kind)) return reply.code(400).send({ error: 'bad_kind' });
    return answer(reply, logins.cancel(id, kind));
  });
}
