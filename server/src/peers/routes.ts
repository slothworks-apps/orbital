/**
 * Where a request for another Mac's session leaves this server (spec
 * 2026-10-06-peer-macs-design § 2): a session route, a route that names a
 * session in `?session=`, or one that names a machine in `?machine=` (or a
 * spawn's `machine` in its body) is answered by that Mac through the tunnel.
 * A call that came from a paired Mac is never forwarded (no chaining).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { HttpMethod } from '@orbital/shared/remote/client';
import { PEER_HEADER } from '../remote/inject.js';
import type { RemoteService } from '../remote/service.js';
import { encodePairingCode, type PeerService } from './service.js';

/** Literal siblings of `:id` under `/api/sessions`: never a session. */
const NOT_A_SESSION = new Set(['count', 'defaults', 'retention-preview']);
const IMAGE_REF = /^\/api\/images\/([a-f0-9]{64}\.(?:png|jpg|gif|webp))$/;
const MEDIA_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function registerPeerRoutes(
  app: FastifyInstance, peers: PeerService, remote: RemoteService, imagesDir: string,
): void {
  app.get('/api/peers', () => peers.status());

  // This Mac's pairing code for another Mac: the phone's QR, as one word to paste.
  app.post('/api/peers/code', async (_req, reply) => {
    const res = await remote.startPairing();
    if ('error' in res) return reply.code(409).send(res);
    return { code: encodePairingCode(res.qr), expiresAt: res.expiresAt };
  });

  app.post('/api/peers/pair', async (req, reply) => {
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== 'string') return reply.code(400).send({ error: 'code must be a string' });
    const res = await peers.pair(code);
    if ('error' in res) return reply.code(res.error === 'bad_code' ? 400 : 409).send(res);
    return res;
  });

  // The second half of a Mac pairing, sent by a Mac that just became this
  // one's client: this Mac redeems its code in turn (§ 1 step 4).
  app.post('/api/peers/offer', async (req, reply) => {
    // Only from a paired Mac's tunnel, and only right after it paired: no
    // one else may make this Mac a client of some other Mac.
    if (req.headers[PEER_HEADER] === undefined || !remote.expectsPeerOffer()) {
      return reply.code(403).send({ error: 'not_expected' });
    }
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== 'string') return reply.code(400).send({ error: 'code must be a string' });
    const res = await peers.pair(code, { auto: true });
    if ('error' in res) return reply.code(res.error === 'already_paired' ? 200 : 409).send(res);
    return { ok: true };
  });

  app.delete('/api/peers/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    if (!peers.remove(id)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.addHook('preHandler', async (req, reply) => {
    if (req.headers[PEER_HEADER] !== undefined) return;
    const [path, search = ''] = req.url.split('?', 2);
    const query = new URLSearchParams(search);

    const image = IMAGE_REF.exec(path);
    if (image && req.method === 'GET') {
      if (existsSync(join(imagesDir, image[1]))) return;
      const blob = await peers.blob(image[1]);
      if (!blob) return;
      if (blob.mediaType) reply.header('content-type', blob.mediaType);
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.send(Buffer.from(blob.bytes));
    }

    const sessionId = sessionOf(path) ?? query.get('session');
    const bySession = sessionId ? peers.linkOf(sessionId) : null;
    const machine = query.get('machine') ?? machineOfBody(req);
    const link = bySession ?? (machine ? peers.link(machine) : null);
    if (!link) return;

    if (path === '/api/files/image' && sessionId) {
      const file = await peers.file(
        link, sessionId, query.get('path') ?? '', /\.pdf$/i.test(query.get('path') ?? '') ? 'pdf' : 'image', query.get('cwd') ?? undefined,
      );
      if (!file) return reply.code(502).send({ error: 'peer_unreachable' });
      if (file.status !== 200) return reply.code(file.status).send({ error: 'not_found' });
      reply.header('content-type', file.mediaType ?? 'application/octet-stream');
      reply.header('cache-control', 'no-cache');
      reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      reply.header('x-content-type-options', 'nosniff');
      return reply.send(Buffer.from(file.bytes));
    }
    // A composer's upload is stored here; `upload` below sends it on with the message.
    if (req.isMultipart()) return;

    query.delete('machine');
    const rest = query.toString();
    const url = rest ? `${path}?${rest}` : path;
    let body = req.body as Record<string, unknown> | undefined;
    if (body && typeof body === 'object' && 'machine' in body) {
      const { machine: _machine, ...others } = body;
      body = others;
    }
    const attachments = (body as { attachments?: unknown } | undefined)?.attachments;
    if (body && Array.isArray(attachments) && attachments.length > 0) {
      const refs = await peers.upload(link, attachments as string[], (ref) => readImage(imagesDir, ref));
      if (!refs) return reply.code(502).send({ error: 'attachment_not_sent' });
      body = { ...body, attachments: refs };
    }
    // A spawn's tag is this Mac's; the peer gets its own of that name.
    const tagId = (body as { tagId?: unknown } | undefined)?.tagId;
    if (body && req.method === 'POST' && path === '/api/sessions' && typeof tagId === 'number') {
      const peerTag = await peers.peerTagId(link, tagId);
      const { tagId: _tagId, ...others } = body;
      body = peerTag === null ? others : { ...others, tagId: peerTag };
    }
    const tagIds = (body as { tagIds?: unknown } | undefined)?.tagIds;
    const res = req.method === 'PUT' && sessionId && path === `/api/sessions/${sessionId}/tags` && Array.isArray(tagIds)
      ? await peers.setTags(link, sessionId, tagIds as number[])
      : await peers.request(link, req.method as HttpMethod, url, body);
    return send(reply, res.status, res.body);
  });

  // The list every client starts from carries every peer's sessions too, on its first page.
  app.addHook('preSerialization', async (req, _reply, payload) => {
    if (req.method !== 'GET' || req.routeOptions.url !== '/api/sessions' || req.headers[PEER_HEADER] !== undefined) {
      return payload;
    }
    const q = req.query as Record<string, string>;
    if (Number(q.offset ?? 0) > 0 || q.source) return payload;
    const page = payload as { sessions?: unknown[] };
    if (!Array.isArray(page.sessions)) return payload;
    // The phone's ENDED fold, as the route draws it: unpinned ended sessions.
    const folded = (s: { status?: unknown; pinnedAt?: unknown }) => s.status === 'ended' && s.pinnedAt == null;
    let extra = peers.sessions();
    if (q.ended === 'only') extra = extra.filter(folded);
    if (q.ended === 'exclude') extra = extra.filter((s) => !folded(s));
    if (q.q) extra = extra.filter((s) => (typeof s.title === 'string' ? s.title : '').toLowerCase().includes(q.q.toLowerCase()));
    if (q.tag) {
      const tagIds = q.tag.split(',').map(Number);
      extra = extra.filter((s) => (s.tagIds ?? []).some((id) => tagIds.includes(id)));
    }
    return { ...page, sessions: [...page.sessions, ...extra] };
  });
}

function readImage(imagesDir: string, ref: string): { bytes: Uint8Array; mediaType: string } | null {
  const m = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.exec(ref);
  if (!m) return null;
  try {
    return { bytes: new Uint8Array(readFileSync(join(imagesDir, ref))), mediaType: MEDIA_TYPES[m[1]] };
  } catch {
    return null;
  }
}

function sessionOf(path: string): string | null {
  const m = /^\/api\/(?:stats\/)?sessions\/([^/]+)/.exec(path);
  return m && !NOT_A_SESSION.has(m[1]) ? decodeURIComponent(m[1]) : null;
}

function machineOfBody(req: FastifyRequest): string | null {
  const body = req.body as { machine?: unknown } | undefined;
  return body && typeof body === 'object' && typeof body.machine === 'string' ? body.machine : null;
}

function send(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  reply.code(status);
  return typeof body === 'string' ? reply.type('text/plain').send(body) : reply.send(body ?? null);
}
