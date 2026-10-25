import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SettingsStore } from '../models/catalog.js';
import type { Presence } from '../remote/presence.js';
import type { RemoteService, RemoveResult } from '../remote/service.js';
import { ALL_GRANT_GROUPS, getMemberGrants, parseGrants } from '../remote/grants.js';

const REMOTE_GRANTS_KEY = 'remote_grants';

/** Settings → Mobile and the desktop app talk to these; the phone never can (they are not allowlisted). */
export function registerRemoteRoutes(
  app: FastifyInstance,
  remote: RemoteService,
  presence?: Presence,
  settings?: SettingsStore,
  /** A member's grants changed here: the shared settings catch up with it afresh (`SharedSettingsSync.grantsChanged`). */
  grantsChanged?: (id: string) => void,
): void {
  app.get('/api/remote', () => remote.status());

  // The desktop app's heartbeat while the user is at the Mac (spec
  // 2026-10-15-the-phone-is-quiet-while-you-are-at-the-mac-design § 1).
  app.put('/api/presence', (req, reply) => {
    const body = (req.body ?? {}) as { atMac?: unknown };
    if (typeof body.atMac !== 'boolean') return reply.code(400).send({ error: 'atMac must be a boolean' });
    presence?.report(body.atMac);
    return reply.code(204).send();
  });

  // "Try again": a failed start does not retry on identical settings by itself.
  app.post('/api/remote/restart', () => {
    remote.settingsChanged();
    return remote.status();
  });

  // Only the primary shows a code that adds a device (ADR the-group-has-one-primary-device): 403 `not_primary` names it.
  app.post('/api/remote/pair', async (_req, reply) => {
    const res = await remote.startPairing();
    if ('error' in res) return reply.code(res.error === 'not_primary' ? 403 : 409).send(res);
    return res;
  });

  // This server joins another device by its code (spec 2026-10-16-device-group-design § 3).
  app.post('/api/remote/join', async (req, reply) => {
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== 'string') return reply.code(400).send({ error: 'code must be a string' });
    const res = await remote.join(code);
    if ('error' in res) return reply.code(res.error === 'bad_code' ? 400 : res.error === 'not_primary' ? 403 : 409).send(res);
    return res;
  });

  // Stops waiting for the device being joined; the relay's request expires with the code.
  app.delete('/api/remote/join', (_req, reply) => {
    if (!remote.cancelJoin()) return reply.code(404).send({ error: 'not_joining' });
    return { ok: true };
  });

  app.post('/api/remote/pair/confirm', async (req, reply) => {
    const body = (req.body ?? {}) as { accept?: unknown; phone?: unknown; code?: unknown };
    if (typeof body.accept !== 'boolean') return reply.code(400).send({ error: 'accept must be a boolean' });
    if (typeof body.phone !== 'string') return reply.code(400).send({ error: 'phone must be a string' });
    // An accept carries the code typed from the phone; a reject needs none.
    if (body.accept && typeof body.code !== 'string') return reply.code(400).send({ error: 'code must be a string' });
    // The two refusals are told apart for the dialog's sake: "nothing to
    // confirm" closes it, "a different phone" means it is showing stale data.
    const pending = remote.status().pendingPair;
    if (!pending) return reply.code(404).send({ error: 'no_pending' });
    if (pending.phone !== body.phone) return reply.code(409).send({ error: 'mismatch' });
    const res = await remote.confirmPairing(body.accept, body.phone, body.accept ? (body.code as string) : undefined);
    if ('ok' in res) return { ok: true };
    switch (res.error) {
      case 'no_pending': return reply.code(404).send(res);
      case 'code_mismatch': return reply.code(422).send(res);
      case 'code_rejected': return reply.code(409).send(res);
      case 'group_full': return reply.code(409).send(res);
      case 'relay_error': return reply.code(502).send(res);
    }
  });

  // The other group members, their kind and whether each is online (spec 2026-10-19-member-grants-design § 3).
  app.get('/api/remote/devices', () => {
    const status = remote.status();
    const devices = status.group.members
      .filter((m) => m.id !== status.macId) // exclude this device
      .map((m) => {
        const online = status.devices.some((d) => d.id === m.id && d.online);
        return {
          id: m.id,
          name: m.name,
          kind: m.kind,
          online,
        };
      });
    return { devices };
  });

  // Only the primary removes a member (403 `not_primary` names it); this device's own id is leaving the group,
  // refused as `leave` is.
  app.delete('/api/remote/devices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return removed(reply, await remote.remove(id));
  });

  // This device leaves its group (spec 2026-10-16-device-group-design § 4).
  app.post('/api/remote/leave', async (_req, reply) => removed(reply, await remote.leave()));

  // The notice that the primary dissolved the group or removed this device was read (canvas 50m OK).
  app.post('/api/remote/ended/acknowledge', () => {
    remote.acknowledgeEnded();
    return { ok: true };
  });

  // The card saying a join was dropped, its primary's group never come, was read (canvas 50p B).
  app.post('/api/remote/join/expired/acknowledge', () => {
    remote.acknowledgeExpiredJoin();
    return { ok: true };
  });

  // Member grants: read and update (spec 2026-10-19-member-grants-design § 1).
  // Every member of the group but this device.
  app.get('/api/remote/grants', () => {
    if (!settings) return { grants: {} };
    const grantsRaw = settings.get(REMOTE_GRANTS_KEY);
    const parsed = parseGrants(grantsRaw);
    const status = remote.status();
    const result: Record<string, Record<string, boolean>> = {};
    for (const device of status.group.members) {
      if (device.id === status.macId) continue; // not this device
      result[device.id] = getMemberGrants(parsed, device.id);
    }
    return { grants: result };
  });

  // Update a member's grants.
  app.put('/api/remote/grants/:id', (req, reply) => {
    if (!settings) return reply.code(404).send({ error: 'not_found' });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Validate the body: only known groups with boolean values.
    for (const [key, value] of Object.entries(body)) {
      if (!(ALL_GRANT_GROUPS as readonly string[]).includes(key)) {
        return reply.code(400).send({ error: 'unknown_group', group: key });
      }
      if (typeof value !== 'boolean') {
        return reply.code(400).send({ error: 'invalid_value', group: key });
      }
    }

    // Check if the device is in the group (but not this device).
    const status = remote.status();
    const device = status.group.members.find((m) => m.id === id);
    if (!device || id === status.macId) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // Update the grants.
    const grantsRaw = settings.get(REMOTE_GRANTS_KEY);
    const grants = parseGrants(grantsRaw);
    if (!grants[id]) grants[id] = {};
    Object.assign(grants[id], body);
    settings.set(REMOTE_GRANTS_KEY, JSON.stringify(grants));
    grantsChanged?.(id);
    return { grants: getMemberGrants(grants, id) };
  });
}

/**
 * A removal's answer: 404 for no such device, 403 from a member that is not
 * the primary, 409 for leaving while offline, 500 for a roster that could
 * not be written.
 */
function removed(reply: FastifyReply, res: RemoveResult) {
  if (!('error' in res)) return res;
  const code = { not_found: 404, not_primary: 403, offline: 409, failed: 500 }[res.error];
  return reply.code(code).send(res);
}
