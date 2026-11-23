/**
 * The routes a client draws a generated view through (spec
 * 2026-11-18-generated-views-design): the payload of one call, its data copy,
 * and the domains the session allowed its views to fetch from.
 */

import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  VIEWS_CDN_HOSTS_KEY, VIEW_DOMAINS_EVENT, normaliseLiveDomain, readCdnHosts, type ViewDomainsEvent,
} from '@orbital/shared/views';
import type { Hub } from '../api/hub.js';
import type { OrbitalDb } from '../db/database.js';
import { sessions, viewDomainApprovals } from '../db/schema.js';
import type { ViewsService } from './service.js';

/** The most domains one request may allow. */
export const VIEW_DOMAINS_PER_REQUEST_MAX = 16;

/** Every domain the session allowed its views to fetch from, oldest first. */
export function approvedViewDomains(db: OrbitalDb, sessionId: string): string[] {
  return db
    .select({ domain: viewDomainApprovals.domain })
    .from(viewDomainApprovals)
    .where(eq(viewDomainApprovals.sessionId, sessionId))
    .orderBy(asc(viewDomainApprovals.approvedAt), asc(viewDomainApprovals.domain))
    .all()
    .map((row) => row.domain);
}

/** Allows these domains for the session; one allowed already keeps its first approval. */
export function approveViewDomains(db: OrbitalDb, sessionId: string, domains: readonly string[], now = Date.now()): void {
  if (domains.length === 0) return;
  db.insert(viewDomainApprovals)
    .values(domains.map((domain) => ({ sessionId, domain, approvedAt: now })))
    .onConflictDoNothing()
    .run();
}

export interface ViewRoutesContext {
  db: OrbitalDb;
  hub: Hub;
  views: ViewsService;
  settings: { get(key: string): string };
}

export function registerViewRoutes(app: FastifyInstance, ctx: ViewRoutesContext): void {
  const { db } = ctx;
  const sessionExists = (id: string) => db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get() !== undefined;

  /**
   * What a client draws the view at this call from (`ViewPayload`). 404 for an
   * unknown session, and for a tool_use id that is not a shown `show_view`
   * call of this session — another session's call among them.
   */
  app.get('/api/sessions/:id/views/:toolUseId', (req, reply) => {
    const { id, toolUseId } = req.params as { id: string; toolUseId: string };
    if (!sessionExists(id)) return reply.code(404).send({ error: 'not found' });
    const payload = ctx.views.payload(id, toolUseId, {
      approvedDomains: approvedViewDomains(db, id),
      cdnHosts: readCdnHosts(ctx.settings.get(VIEWS_CDN_HOSTS_KEY)).map((h) => h.host),
    });
    if (!payload) return reply.code(404).send({ error: 'not found' });
    return payload;
  });

  /** The data copy of a view whose payload does not carry it (`data.inline` false), as it was copied. */
  app.get('/api/sessions/:id/views/:toolUseId/data', (req, reply) => {
    const { id, toolUseId } = req.params as { id: string; toolUseId: string };
    if (!sessionExists(id)) return reply.code(404).send({ error: 'not found' });
    const data = ctx.views.data(id, toolUseId);
    if (!data) return reply.code(404).send({ error: 'not found' });
    return reply.type(data.mediaType).send(data.bytes);
  });

  /**
   * Allow on a view (spec § Isolation and network): the domains hold for the
   * session wherever the click was made, and every client is told.
   */
  app.post('/api/sessions/:id/view-domains', (req, reply) => {
    const { id } = req.params as { id: string };
    if (!sessionExists(id)) return reply.code(404).send({ error: 'not found' });
    const { domains } = (req.body ?? {}) as { domains?: unknown };
    if (!Array.isArray(domains) || domains.length === 0 || domains.length > VIEW_DOMAINS_PER_REQUEST_MAX) {
      return reply.code(400).send({ error: 'invalid_domain' });
    }
    const normalised = domains.map((d) => (typeof d === 'string' ? normaliseLiveDomain(d) : null));
    if (normalised.some((d) => d === null)) return reply.code(400).send({ error: 'invalid_domain' });
    approveViewDomains(db, id, [...new Set(normalised as string[])]);
    const all = approvedViewDomains(db, id);
    const event: ViewDomainsEvent = { event: VIEW_DOMAINS_EVENT, domains: all };
    ctx.hub.publish(`session:${id}`, { ...event });
    return { domains: all };
  });
}
