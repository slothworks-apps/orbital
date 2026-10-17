/**
 * Where a request for another member's session leaves this server (spec
 * 2026-10-16-device-group-design § 7): a session route, a route that names a
 * session in `?session=`, or one that names a member in `?machine=` (or a
 * spawn's `machine` in its body) is answered by that member through its
 * channel. The web app only ever talks to its own server. A request that
 * came over a channel (`DEVICE_HEADER`) is never forwarded and never gets
 * another member's sessions merged in: no chaining.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { HttpMethod } from '@orbital/shared/remote/channel';
import { IMAGE_CONTENT_TYPES, IMAGE_REF_RE } from '../api/routes.js';
import { RESERVED_SEGMENTS } from '../remote/allowlist.js';
import { DEVICE_HEADER } from '../remote/inject.js';
import type { FederationService, ReadResponse, Session } from './service.js';

/** On a member's answer that is a kept copy: when it was kept, in ms since the epoch. */
export const AS_OF_HEADER = 'x-orbital-as-of';

const IMAGE_PATH = /^\/api\/images\/([^/]+)$/;
const TAGS_PATH = /^\/api\/sessions\/[^/]+\/tags$/;
/** The routes that change this device's tags, as Fastify names them. */
const TAG_ROUTES: ReadonlySet<string> = new Set(['/api/tags', '/api/tags/:id']);

export function registerFederationRoutes(
  app: FastifyInstance, federation: FederationService, selfId: () => string | null, imagesDir: string,
): void {
  /** Requests answered with one device's list alone: a member's reply, or this device's own by name. */
  const unmerged = new WeakSet<FastifyRequest>();
  app.addHook('preHandler', async (req, reply) => {
    const [path, search = ''] = req.url.split('?', 2);
    const query = new URLSearchParams(search);
    if (req.headers[DEVICE_HEADER] !== undefined) {
      // Never forwarded (no chaining): a request that names another device is refused, not answered here.
      const machine = query.get('machine') ?? machineOfBody(req);
      if (machine !== null && machine !== selfId()) return reply.code(400).send({ error: 'not_forwarded' });
      return;
    }

    // An image of a member's session: its store, not this one, holds the bytes.
    const image = IMAGE_PATH.exec(path);
    if (image && req.method === 'GET') {
      const ref = image[1];
      const m = IMAGE_REF_RE.exec(ref);
      if (!m || existsSync(join(imagesDir, ref))) return;
      const blob = await federation.blob(ref);
      // Content-addressed: bytes that are not the ref's are not served, and never cached as it.
      if (!blob || createHash('sha256').update(blob.bytes).digest('hex') !== ref.slice(0, ref.indexOf('.'))) return;
      // The type is the ref's, never the member's word: a member's answer must not become a page on this origin.
      reply.header('content-type', IMAGE_CONTENT_TYPES[m[1]]);
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.send(Buffer.from(blob.bytes));
    }

    // `sessionId` is the harness start view's name for the same thing.
    const sessionId = sessionOf(path) ?? query.get('session') ?? query.get('sessionId');
    let link = sessionId ? federation.linkOf(sessionId) : null;
    if (!link) {
      const machine = query.get('machine') ?? machineOfBody(req);
      if (!machine) return;
      if (machine === selfId()) {
        // This device: the local route answers, as if no machine were named, and a list is its own alone.
        delete (req.query as Record<string, unknown> | undefined)?.machine;
        if (isObject(req.body)) delete req.body.machine;
        unmerged.add(req);
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
    // A spawn whose id the browser minted: its windows' topics are asked of the member before the spawn goes.
    const spawned = req.method === 'POST' && path === '/api/sessions' && isObject(body) && typeof body.sessionId === 'string'
      ? body.sessionId : null;
    if (spawned !== null) federation.expect(link, spawned);
    const tagIds = isObject(body) ? body.tagIds : undefined;
    // A read of a member's session is kept, and answered from what was kept while the member is offline.
    const res: ReadResponse = req.method === 'PUT' && sessionId && TAGS_PATH.test(path) && Array.isArray(tagIds)
      ? await federation.setTags(link, sessionId, tagIds.filter((id): id is number => typeof id === 'number'))
      : req.method === 'GET' && sessionId
        ? await federation.read(link, sessionId, url)
        : await federation.request(link, req.method as HttpMethod, url, body);
    if (spawned !== null && res.status >= 300) federation.unexpect(link, spawned);
    if (res.asOf !== undefined) reply.header(AS_OF_HEADER, String(res.asOf));
    unmerged.add(req);
    // A member's list, as this device shows its sessions.
    const list = isObject(res.body) ? res.body.sessions : undefined;
    if (req.method === 'GET' && path === '/api/sessions' && res.status === 200 && Array.isArray(list)) {
      return send(reply, res.status, { ...(res.body as object), sessions: federation.localizeList(link, list) });
    }
    return send(reply, res.status, res.body);
  });

  // A tag made, renamed or deleted here, by this device's window or a member's ask: names map anew.
  app.addHook('onResponse', (req, _reply, done) => {
    if (req.method !== 'GET' && TAG_ROUTES.has(req.routeOptions.url ?? '')) federation.tagsChanged();
    done();
  });

  // The list every client starts from carries every member's sessions too, on its first page.
  app.addHook('preSerialization', async (req, _reply, payload) => {
    // A list asked of one device (`?machine=`) is that device's alone.
    if (req.method !== 'GET' || req.routeOptions.url !== '/api/sessions' || req.headers[DEVICE_HEADER] !== undefined
      || unmerged.has(req)) {
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
