/**
 * Harness routes (spec 2026-09-30-session-harness-design): template CRUD,
 * and putting a template into a session, approving its gates, pausing it.
 * The service decides; these routes deliver what it wants said into the
 * session, through the same path the composer uses.
 */

import type { FastifyInstance } from 'fastify';
import { INTERVIEW_PROMPT } from '../harness/service.js';
import type { ChatMessage } from '../types.js';
import type { RouteContext } from './routes.js';

type Deliver = (id: string, text: string) => Promise<{ outcome: 'sent' | 'revived' | 'not_found' | 'terminal'; uuid: string | null }>;

export function registerHarnessRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  deliver: Deliver,
  readTranscript: (id: string) => ChatMessage[] | null,
): void {
  const { harness } = ctx;
  // A review that ends minutes later may find the session asleep; this path revives it.
  harness.useDelivery(deliver);
  const enabled = () => ctx.settings.get('harness_enabled') === 'true';

  app.get('/api/harness/templates', () => ({ templates: harness.listTemplates() }));

  app.post('/api/harness/templates', (req, reply) => {
    const result = harness.createTemplate(req.body ?? {});
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send(result.value);
  });

  // A model's draft, not saved (spec 2026-09-30-assisted-harness-templates-design).
  app.post('/api/harness/templates/draft', async (req, reply) => {
    const body = (req.body ?? {}) as { description?: unknown; sessionId?: unknown };
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
    if (!description && !sessionId) return reply.code(400).send({ error: 'describe the work or pick a session' });
    let messages: ChatMessage[] | undefined;
    if (sessionId) {
      const read = readTranscript(sessionId);
      if (!read) return reply.code(404).send({ error: 'session not found' });
      messages = read;
    }
    let result;
    try {
      result = await harness.draft({ description, messages });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.errors.record({
        source: 'server', kind: 'api_request', sessionId, message,
        detail: err instanceof Error ? (err.stack ?? null) : null,
        context: { while: 'drafting a harness template' },
      });
      return reply.code(502).send({ error: message });
    }
    if (!result.ok) return reply.code(422).send({ error: `The draft was not a valid template: ${result.error}` });
    return { template: result.template };
  });

  app.get('/api/harness/interview', () => ({ prompt: INTERVIEW_PROMPT }));

  app.put('/api/harness/templates/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    const result = harness.updateTemplate(Number(id), req.body ?? {});
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.value;
  });

  app.delete('/api/harness/templates/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    harness.deleteTemplate(Number(id));
    return reply.code(204).send();
  });

  app.get('/api/sessions/:id/harness', (req) => {
    const { id } = req.params as { id: string };
    return { harness: harness.get(id), events: harness.events(id) };
  });

  app.post('/api/sessions/:id/harness', async (req, reply) => {
    if (!enabled()) return reply.code(403).send({ error: 'harness_disabled' });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { templateId?: unknown; inputs?: unknown };
    if (typeof body.templateId !== 'number') return reply.code(400).send({ error: 'templateId must be a number' });
    const inputs = body.inputs && typeof body.inputs === 'object' ? (body.inputs as Record<string, unknown>) : {};
    const values = Object.fromEntries(
      Object.entries(inputs).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
    const result = harness.attach(id, body.templateId, values);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    harness.noteSent(id, result.value.kickoff);
    const delivery = await deliver(id, result.value.kickoff);
    if (delivery.outcome === 'not_found' || delivery.outcome === 'terminal') {
      // A harness nobody can send to would only pretend to run.
      harness.remove(id);
      return reply.code(409).send({ error: delivery.outcome === 'terminal' ? 'session_is_terminal' : 'not found' });
    }
    await harness.stepStarted(id, 0, delivery.uuid);
    return reply.code(201).send({ harness: harness.get(id) });
  });

  app.delete('/api/sessions/:id/harness', (req, reply) => {
    const { id } = req.params as { id: string };
    harness.remove(id);
    return reply.code(204).send();
  });

  app.patch('/api/sessions/:id/harness', (req, reply) => {
    const { id } = req.params as { id: string };
    const { paused, options } = (req.body ?? {}) as { paused?: unknown; options?: unknown };
    if (paused === undefined && options === undefined) return reply.code(400).send({ error: 'send paused or options' });
    if (paused !== undefined && typeof paused !== 'boolean') return reply.code(400).send({ error: 'paused must be a boolean' });
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      return reply.code(400).send({ error: 'options must be an object' });
    }
    if (options !== undefined) {
      const result = harness.setOptions(id, options);
      if (!result.ok) return reply.code(result.status).send({ error: result.error });
    }
    if (typeof paused === 'boolean') {
      const result = harness.setPaused(id, paused);
      if (!result.ok) return reply.code(result.status).send({ error: result.error });
    }
    return { harness: harness.get(id) };
  });

  app.post('/api/sessions/:id/harness/steps/:index/approve', async (req, reply) => {
    const { id, index } = req.params as { id: string; index: string };
    const result = harness.approve(id, Number(index));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    const { message } = result.value;
    if (message && enabled() && !result.value.harness.paused) {
      harness.noteSent(id, message);
      const delivery = await deliver(id, message);
      await harness.stepStarted(id, Number(index) + 1, delivery.uuid);
    }
    return { harness: harness.get(id) };
  });

  app.get('/api/sessions/:id/harness/steps/:index/diff', async (req, reply) => {
    const { id, index } = req.params as { id: string; index: string };
    const result = await harness.diff(id, Number(index));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.value;
  });

  app.post('/api/sessions/:id/harness/steps/:index/reopen', (req, reply) => {
    const { id, index } = req.params as { id: string; index: string };
    const result = harness.reopen(id, Number(index));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { harness: result.value };
  });
}
