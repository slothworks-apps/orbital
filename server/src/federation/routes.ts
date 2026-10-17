/**
 * Where a request for another member's session leaves this server (spec
 * 2026-10-16-device-group-design § 7): a session route, a route that names a
 * session in `?session=`, or one that names a member in `?machine=` (or a
 * spawn's `machine` in its body) is answered by that member through its
 * channel. The web app only ever talks to its own server. A request that
 * came over a channel (`DEVICE_HEADER`) is never forwarded and never gets
 * another member's sessions merged in: no chaining.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { HttpMethod } from '@orbital/shared/remote/channel';
import { IMAGE_CONTENT_TYPES, IMAGE_REF_RE } from '../api/routes.js';
import { RESERVED_SEGMENTS } from '../remote/allowlist.js';
import { DEVICE_HEADER } from '../remote/inject.js';
import type { FederationService, Session } from './service.js';

const IMAGE_PATH = /^\/api\/images\/([^/]+)$/;
const TAGS_PATH = /^\/api\/sessions\/[^/]+\/tags$/;

export function registerFederationRoutes(
  app: FastifyInstance, federation: FederationService, selfId: () => string | null, imagesDir: string,
): void {
  /** Requests the preHandler answered with a member's reply. */
  const forwarded = new WeakSet<FastifyRequest>();
  app.addHook('preHandler', async (req, reply) => {
    if (req.headers[DEVICE_HEADER] !== undefined) return;
    const [path, search = ''] = req.url.split('?', 2);
    const query = new URLSearchParams(search);

    // An image of a member's session: its store, not this one, holds the bytes.
    const image = IMAGE_PATH.exec(path);
    if (image && req.method === 'GET') {
      const ref = image[1];
      if (!IMAGE_REF_RE.test(ref) || existsSync(join(imagesDir, ref))) return;
      const blob = await federation.blob(ref);
      if (!blob) return;
      if (blob.mediaType) reply.header('content-type', blob.mediaType);
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.send(Buffer.from(blob.bytes));
    }

    const sessionId = sessionOf(path) ?? query.get('session');
    let link = sessionId ? federation.linkOf(sessionId) : null;
    if (!link) {
      const machine = query.get('machine') ?? machineOfBody(req);
      if (!machine) return;
      if (machine === selfId()) {
        // This device: the local route answers, as if no machine were named.
        delete (req.query as Record<string, unknown> | undefined)?.machine;
        if (isObject(req.body)) delete req.body.machine;
        return;
      }
      link = federation.link(machine);
      if (!link) return reply.code(404).send({ error: 'unknown_device' });
    }

    if (path === '/api/files/image') {
      // Without a session the local route answers what is missing.
      if (!sessionId) return;
      if (!link.channel?.ready) return reply.code(409).send({ error: 'member_offline' });
      const filePath = query.get('path') ?? '';
      const file = await federation.file(
        link, sessionId, filePath, /\.pdf$/i.test(filePath) ? 'pdf' : 'image', query.get('cwd') ?? undefined,
      );
      if (!file) return reply.code(502).send({ error: 'member_unreachable' });
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
    let body: unknown = req.body;
    if (isObject(body) && 'machine' in body) {
      const { machine: _machine, ...others } = body;
      body = others;
    }
    if (isObject(body) && Array.isArray(body.attachments) && body.attachments.length > 0) {
      const refs = body.attachments;
      if (!refs.every((r): r is string => typeof r === 'string' && IMAGE_REF_RE.test(r))) {
        return reply.code(400).send({ error: 'invalid_attachment' });
      }
      const sent = await federation.upload(link, refs, (ref) => readImage(imagesDir, ref));
      if (!sent) return reply.code(502).send({ error: 'attachment_not_sent' });
      body = { ...body, attachments: sent };
    }
    // A spawn's tag is this device's; the member gets its own of that name.
    if (isObject(body) && req.method === 'POST' && path === '/api/sessions' && typeof body.tagId === 'number') {
      const memberTag = await federation.peerTagId(link, body.tagId);
      const { tagId: _tagId, ...others } = body;
      body = memberTag === null ? others : { ...others, tagId: memberTag };
    }
    const tagIds = isObject(body) ? body.tagIds : undefined;
    const res = req.method === 'PUT' && sessionId && TAGS_PATH.test(path) && Array.isArray(tagIds)
      ? await federation.setTags(link, sessionId, tagIds.filter((id): id is number => typeof id === 'number'))
      : await federation.request(link, req.method as HttpMethod, url, body);
    forwarded.add(req);
    return send(reply, res.status, res.body);
  });

  // The list every client starts from carries every member's sessions too, on its first page.
  app.addHook('preSerialization', async (req, _reply, payload) => {
    // A list a member answered (`?machine=`) is that member's alone.
    if (req.method !== 'GET' || req.routeOptions.url !== '/api/sessions' || req.headers[DEVICE_HEADER] !== undefined
      || forwarded.has(req)) {
      return payload;
    }
    const q = req.query as Record<string, string>;
    if (Number(q.offset ?? 0) > 0) return payload;
    const page = payload as { sessions?: unknown[]; ended?: { count: number; latestAt: number | null } };
    if (!page || !Array.isArray(page.sessions)) return payload;
    // The route's filters, as they apply to a session rather than a row.
    let extra = federation.sessions().filter((s) => !(s.purpose === 'harness_draft' && s.endedAt != null));
    if (q.source) extra = extra.filter((s) => s.source === q.source);
    if (q.q) extra = extra.filter((s) => (typeof s.title === 'string' ? s.title : '').toLowerCase().includes(q.q.toLowerCase()));
    if (q.tag) {
      const tagIds = q.tag.split(',').map(Number);
      extra = extra.filter((s) => (s.tagIds ?? []).some((id) => tagIds.includes(id)));
    }
    // The phone's ENDED fold, as the route draws it: unpinned ended sessions.
    const folded = (s: Session) => s.status === 'ended' && s.pinnedAt == null;
    if (q.ended === 'only') extra = extra.filter(folded);
    if (q.ended === 'exclude') {
      const fold = extra.filter(folded);
      extra = extra.filter((s) => !folded(s));
      if (page.ended) {
        let { count, latestAt } = page.ended;
        for (const s of fold) {
          count += 1;
          if (typeof s.lastAt === 'number' && (latestAt === null || s.lastAt > latestAt)) latestAt = s.lastAt;
        }
        return { ...page, sessions: [...page.sessions, ...extra], ended: { count, latestAt } };
      }
    }
    return { ...page, sessions: [...page.sessions, ...extra] };
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readImage(imagesDir: string, ref: string): { bytes: Uint8Array; mediaType: string } | null {
  const m = IMAGE_REF_RE.exec(ref);
  if (!m) return null;
  try {
    return { bytes: new Uint8Array(readFileSync(join(imagesDir, ref))), mediaType: IMAGE_CONTENT_TYPES[m[1]] };
  } catch {
    return null;
  }
}

/** The session a path names; never one of the literal siblings of `:id`. */
function sessionOf(path: string): string | null {
  const m = /^\/api\/(?:stats\/)?sessions\/([^/]+)/.exec(path);
  if (!m || RESERVED_SEGMENTS.has(m[1])) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function machineOfBody(req: FastifyRequest): string | null {
  return isObject(req.body) && typeof req.body.machine === 'string' ? req.body.machine : null;
}

/** The member's answer as it came: a string body is plain text. */
function send(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  reply.code(status);
  return typeof body === 'string' ? reply.type('text/plain').send(body) : reply.send(body ?? null);
}
