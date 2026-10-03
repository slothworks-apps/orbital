/**
 * The four signed endpoints of pairing (spec 2026-09-30-mobile-remote-design
 * § 2 Pairing endpoints). Every request is verified against the identity it
 * claims; the Mac's confirmation is the step that makes a pair exist.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PAIRING_TOKEN_TTL_MS, verifyRequest, type RelayAction } from '@orbital/shared/remote/relayApi';
import { log, short } from './log.js';
import { secretMatches } from './secret.js';
import type { WsContext } from './ws.js';

export const PAIR_RATE_LIMIT_PER_MIN = 20;
/** Past this many tracked IPs, the idle ones are forgotten. */
export const RATE_LIMIT_MAX_IPS = 4096;
const RATE_WINDOW_MS = 60_000;
/**
 * The phone redeems from a WebView whose page is https://localhost (and from
 * a desktop browser while its layout is worked on), so `/pair/redeem` is a
 * cross-origin JSON POST: the browser asks first, and reads the answer only
 * when it carries an allow-origin. Any origin may: the request is signed,
 * the token single-use, and no cookie is involved. Only redeem — the other
 * three routes are the Mac's, which is not a browser (ADR
 * the-relay-answers-cors-for-redeem).
 */
const REDEEM_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
};

const TokenPayload = z.object({ name: z.string().max(80) });
// `proof` is opaque here: only the Mac holds the QR secret it is checked against.
const RedeemPayload = z.object({
  token: z.string(), name: z.string().max(80), platform: z.string().max(20), proof: z.string().max(64),
});
const ConfirmPayload = z.object({ phone: z.string(), accept: z.boolean() });
const RevokePayload = z.object({ phone: z.string() });

export function registerPairingRoutes(app: FastifyInstance, ctx: WsContext): void {
  const hits = new Map<string, number[]>();
  const limited = (ip: string): boolean => {
    const now = ctx.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > RATE_LIMIT_MAX_IPS) {
      for (const [key, times] of hits) {
        if (now - times[times.length - 1] >= RATE_WINDOW_MS) hits.delete(key);
      }
    }
    return recent.length > PAIR_RATE_LIMIT_PER_MIN;
  };

  /**
   * Verifies, rate-limits, checks the relay secret, parses, and answers the error itself; returns
   * null then. The signature comes first so unsigned junk never counts
   * against an IP's limit — only a request someone signed can use it up.
   */
  function signed<T extends z.ZodTypeAny>(
    body: unknown, action: RelayAction, schema: T, ip: string, reply: FastifyReply,
  ): { id: string; payload: z.infer<T> } | null {
    const v = verifyRequest(body, action, ctx.now());
    if (!v.ok) {
      void reply.code(401).send({ error: v.reason });
      return null;
    }
    if (limited(ip)) {
      void reply.code(429).send({ error: 'rate_limited' });
      return null;
    }
    if (ctx.secret !== null && !secretMatches(ctx.secret, v.secret ?? undefined)) {
      log(`pairing ${action} refused for ${short(v.id)}: bad secret`);
      void reply.code(401).send({ error: 'bad_secret' });
      return null;
    }
    const parsed = schema.safeParse(v.payload);
    if (!parsed.success) {
      void reply.code(400).send({ error: 'bad_payload' });
      return null;
    }
    return { id: v.id, payload: parsed.data };
  }

  app.post('/pair/token', async (req, reply) => {
    const s = signed(req.body, 'pair.token', TokenPayload, req.ip, reply);
    if (!s) return;
    await ctx.store.upsertDevice({ id: s.id, kind: 'mac', name: s.payload.name });
    await ctx.store.pruneExpiredTokens(ctx.now());
    const expiresAt = ctx.now() + PAIRING_TOKEN_TTL_MS;
    const token = await ctx.store.createPairingToken(s.id, expiresAt);
    log(`pairing token minted for mac ${short(s.id)}`);
    return { token, expiresAt };
  });

  app.options('/pair/redeem', (_req, reply) => {
    void reply.code(204).headers(REDEEM_CORS).send();
  });

  app.post('/pair/redeem', async (req, reply) => {
    void reply.header('access-control-allow-origin', REDEEM_CORS['access-control-allow-origin']);
    const s = signed(req.body, 'pair.redeem', RedeemPayload, req.ip, reply);
    if (!s) return;
    const { token, name, platform, proof } = s.payload;
    const peek = await ctx.store.redeemPairingToken(token, s.id, name, platform, ctx.now());
    if (!peek) return reply.code(404).send({ error: 'token_invalid' });
    // The Mac has to be online to show its confirmation (9o). The token is
    // consumed either way: the 409 tells the phone to wake the Mac and scan a
    // fresh code, which is what 9e's "scan again" does.
    if (!ctx.connections.isOnline(peek.mac)) {
      await ctx.store.rejectPair(peek.mac, s.id);
      log(`pairing rejected: mac ${short(peek.mac)} offline for phone ${short(s.id)}`);
      return reply.code(409).send({ error: 'mac_offline' });
    }
    await ctx.store.upsertDevice({ id: s.id, kind: 'phone', name, platform });
    ctx.connections.sendControl(peek.mac, { type: 'pair_request', phone: s.id, name, platform, proof });
    log(`pairing token redeemed: mac ${short(peek.mac)}, phone ${short(s.id)}`);
    return { mac: peek.mac, name: (await ctx.store.device(peek.mac))?.name ?? '' };
  });

  app.post('/pair/confirm', async (req, reply) => {
    const s = signed(req.body, 'pair.confirm', ConfirmPayload, req.ip, reply);
    if (!s) return;
    const { phone, accept } = s.payload;
    if (!(await ctx.store.pending(s.id, phone))) return reply.code(404).send({ error: 'no_pending' });
    if (accept) {
      await ctx.store.confirmPair(s.id, phone, ctx.now());
      // The live connections learn about the pair now, not at their next attach.
      ctx.connections.get(s.id)?.peers.add(phone);
      ctx.connections.get(phone)?.peers.add(s.id);
      ctx.connections.sendControl(phone, { type: 'paired', mac: s.id, name: (await ctx.store.device(s.id))?.name ?? '' });
      // Both are online right now, and neither has heard about the other yet.
      ctx.connections.sendControl(s.id, { type: 'presence', peer: phone, online: ctx.connections.isOnline(phone) });
      ctx.connections.sendControl(phone, { type: 'presence', peer: s.id, online: true });
      log(`pairing confirmed: mac ${short(s.id)}, phone ${short(phone)}`);
    } else {
      await ctx.store.rejectPair(s.id, phone);
      ctx.connections.sendControl(phone, { type: 'rejected', mac: s.id });
      log(`pairing rejected: mac ${short(s.id)}, phone ${short(phone)}`);
    }
    return { ok: true };
  });

  app.post('/pair/revoke', async (req, reply) => {
    const s = signed(req.body, 'pair.revoke', RevokePayload, req.ip, reply);
    if (!s) return;
    // Only act if a pair actually existed: otherwise any signed caller could
    // name an arbitrary phone and drain its queue or push a fake `unpaired`.
    if (!(await ctx.store.revokePair(s.id, s.payload.phone))) {
      return reply.code(404).send({ error: 'not_paired' });
    }
    ctx.connections.get(s.id)?.peers.delete(s.payload.phone);
    ctx.connections.get(s.payload.phone)?.peers.delete(s.id);
    // A revoked phone must not receive queued state frames from the Mac on
    // its next connect.
    ctx.queue.drain(s.payload.phone);
    ctx.connections.sendControl(s.payload.phone, { type: 'unpaired', mac: s.id });
    log(`pair revoked: mac ${short(s.id)}, phone ${short(s.payload.phone)}`);
    return { ok: true };
  });
}
