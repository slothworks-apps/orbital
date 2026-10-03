/**
 * Harness routes (spec 2026-09-30-session-harness-design, redesigned in
 * 2026-10-02-harness-redesign-design): templates and their scopes, the
 * drafting calls and conversation, and putting a template into a session,
 * approving its gates, pausing, removing and carrying it. The service
 * decides; these routes validate and deliver what it wants said into the
 * session, through the same path the composer uses.
 */

import { realpathSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_DRAFT_MODEL, DRAFT_MODELS, INTERVIEW_PROMPT, MAX_EVENTS_PAGE, type Deliver, type TemplateBody } from '../harness/service.js';
import { projectRootOf } from '../harness/project.js';
import { isScope } from '../harness/logic.js';
import type { ChatMessage, PermissionMode, SessionPurpose } from '../types.js';
import type { RouteContext } from './routes.js';

/**
 * Starts a session the way the new-session dialog does, a browser-minted
 * `sessionId` included. Handed over by `registerRoutes`.
 */
export type LaunchSession = (opts: {
  cwd: string; prompt: string; permissionMode: PermissionMode; model?: string; purpose?: SessionPurpose; sessionId?: string;
}) => Promise<{ ok: true; sessionId: string } | { ok: false; status: number; error: string }>;

/** Moves a session's harness into another and sends it the current step. */
export type CarryHarness = (fromId: string, toId: string) => Promise<{ ok: true } | { ok: false; status: number; error: string }>;

const isDraftModel = (v: unknown): v is string => typeof v === 'string' && (DRAFT_MODELS as readonly string[]).includes(v);

/** A request body's scope, or an error; absent is `undefined`. */
function parseScope(raw: unknown): { scope?: TemplateBody['scope'] } | { error: string } {
  if (raw === undefined) return {};
  if (!isScope(raw)) return { error: 'scope must be { kind: "global" } or { kind: "project", root: <absolute path> }' };
  return { scope: raw.kind === 'global' ? { kind: 'global' } : { kind: 'project', root: canonicalRoot(raw.root) } };
}

/**
 * The project a path names, as sessions are matched against it: through
 * symlinks (`/tmp` is `/private/tmp` on macOS, and a session's cwd arrives
 * resolved) and up to the repository root. A path that no longer exists is
 * kept as written, so a template outlives its checkout.
 */
function canonicalRoot(root: string): string {
  try {
    return projectRootOf(realpathSync(root));
  } catch {
    return root;
  }
}

/** A template body with its project root resolved; the service still validates the rest. */
function withCanonicalScope(body: unknown): Partial<TemplateBody> {
  const b = (body ?? {}) as Partial<TemplateBody>;
  return isScope(b.scope) && b.scope.kind === 'project' ? { ...b, scope: { kind: 'project', root: canonicalRoot(b.scope.root) } } : b;
}

export function registerHarnessRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  deliver: Deliver,
  readTranscript: (id: string) => ChatMessage[] | null,
  launch?: LaunchSession,
): { carryHarness: CarryHarness } {
  const { harness } = ctx;
  // A review that ends minutes later may find the session asleep; this path revives it.
  harness.useDelivery(deliver);
  const enabled = () => ctx.settings.get('harness_enabled') === 'true';

  /**
   * `?sessionId=` → what the start view offers that session: its project's
   * saved templates, then the global ones, and the project itself (30c).
   * `?scope=global` or `?project=<root>` → one scope, drafts included
   * (Settings' filter, 30j). Neither → every template.
   */
  app.get('/api/harness/templates', (req) => {
    const q = req.query as { sessionId?: string; scope?: string; project?: string };
    if (q.sessionId) return harness.templatesForSession(q.sessionId);
    if (q.scope === 'global') return { templates: harness.listTemplates({ scope: 'global' }) };
    if (q.project) return { templates: harness.listTemplates({ scope: { project: projectRootOf(q.project) } }) };
    return { templates: harness.listTemplates() };
  });

  /** The projects sessions ran in and templates belong to: the scope picker and the filter chips (30j, 30m). */
  app.get('/api/harness/projects', () => ({ projects: harness.knownProjects() }));

  app.post('/api/harness/templates', (req, reply) => {
    const result = harness.createTemplate(withCanonicalScope(req.body));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send(result.value);
  });

  app.post('/api/harness/templates/:id/duplicate', (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = parseScope(((req.body ?? {}) as { scope?: unknown }).scope);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const result = harness.duplicateTemplate(Number(id), parsed.scope);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send(result.value);
  });

  // A model's draft, not saved (spec 2026-09-30-assisted-harness-templates-design).
  app.post('/api/harness/templates/draft', async (req, reply) => {
    const body = (req.body ?? {}) as { description?: unknown; sessionId?: unknown; model?: unknown };
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
    if (body.model !== undefined && !isDraftModel(body.model)) return reply.code(400).send({ error: `model must be one of ${DRAFT_MODELS.join(', ')}` });
    if (!description && !sessionId) return reply.code(400).send({ error: 'describe the work or pick a session' });
    let messages: ChatMessage[] | undefined;
    if (sessionId) {
      const read = readTranscript(sessionId);
      if (!read) return reply.code(404).send({ error: 'session not found' });
      messages = read;
    }
    let result;
    try {
      result = await harness.draft({ description, messages, model: isDraftModel(body.model) ? body.model : DEFAULT_DRAFT_MODEL });
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

  /**
   * "Draft in a conversation" (30l): starts the interview session, marked
   * `harness_draft` so it is listed nowhere, and records where its template
   * is saved. `cwd` defaults to the scope's project.
   */
  app.post('/api/harness/interview', async (req, reply) => {
    if (!launch) return reply.code(501).send({ error: 'not available' });
    // Its save tool exists only while the feature is on.
    if (!enabled()) return reply.code(403).send({ error: 'harness_disabled' });
    const body = (req.body ?? {}) as {
      cwd?: unknown; permissionMode?: unknown; model?: unknown; scope?: unknown; sessionId?: unknown; description?: unknown;
    };
    if (body.sessionId !== undefined && typeof body.sessionId !== 'string') return reply.code(400).send({ error: 'sessionId must be a v4 UUID' });
    const parsed = parseScope(body.scope);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const scope = parsed.scope ?? { kind: 'global' as const };
    if (body.model !== undefined && !isDraftModel(body.model)) return reply.code(400).send({ error: `model must be one of ${DRAFT_MODELS.join(', ')}` });
    const model = isDraftModel(body.model) ? body.model : DEFAULT_DRAFT_MODEL;
    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : scope.kind === 'project' ? scope.root : null;
    if (!cwd) return reply.code(400).send({ error: 'cwd is required for a global template' });
    const permissionMode = (typeof body.permissionMode === 'string' ? body.permissionMode
      : ctx.settings.get('default_permission_mode') || 'default') as PermissionMode;
    // What the user already typed in the popover opens the interview, so it does not ask it again.
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const prompt = description ? `${INTERVIEW_PROMPT}\n\nWhat the user has said about the work so far:\n\n${description}` : INTERVIEW_PROMPT;
    const launched = await launch({
      cwd, prompt, permissionMode, model, purpose: 'harness_draft',
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    });
    if (!launched.ok) return reply.code(launched.status).send({ error: launched.error });
    harness.noteInterview(launched.sessionId, scope, model);
    return reply.code(201).send({ sessionId: launched.sessionId });
  });

  app.put('/api/harness/templates/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    const result = harness.updateTemplate(Number(id), withCanonicalScope(req.body));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.value;
  });

  app.delete('/api/harness/templates/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    harness.deleteTemplate(Number(id));
    return reply.code(204).send();
  });

  /**
   * The session's live harness, the one it removed (kept for its records,
   * session stats → Harness), and the log newest first: `?limit=` up to
   * `MAX_EVENTS_PAGE`, `?before=<event id>` for the page after.
   */
  app.get('/api/sessions/:id/harness', (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { limit?: string; before?: string };
    const limit = q.limit ? Math.min(Number(q.limit) || 50, MAX_EVENTS_PAGE) : undefined;
    const before = q.before ? Number(q.before) : undefined;
    return {
      harness: harness.get(id),
      removed: harness.removed(id),
      events: harness.events(id, { limit, before: Number.isFinite(before) ? before : undefined }),
    };
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
    // Every input is required unless its hint says it is optional (30c).
    const template = harness.getTemplate(body.templateId);
    const missing = template?.inputs.find((input) => !values[input.key]?.trim() && !/optional/i.test(input.hint ?? ''));
    if (missing) return reply.code(400).send({ error: `${missing.label} is required` });
    const result = harness.attach(id, body.templateId, values);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    const delivery = await harness.say(id, result.value.kickoff, 'kickoff', 0);
    if (delivery.outcome === 'not_found' || delivery.outcome === 'terminal') {
      // A harness nobody can send to would only pretend to run.
      harness.discard(id);
      return reply.code(409).send({ error: delivery.outcome === 'terminal' ? 'session_is_terminal' : 'not found' });
    }
    await harness.stepStarted(id, 0, delivery.uuid);
    return reply.code(201).send({ harness: harness.get(id) });
  });

  /** Remove: the harness leaves the session, its records stay (`removed` above). */
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
    // Paused: the next step is active but not sent; resuming sends it.
    if (message && enabled() && !result.value.harness.paused) {
      const next = Number(index) + 1;
      const delivery = await harness.say(id, message, 'advance', next);
      await harness.stepStarted(id, next, delivery.uuid);
    }
    return { harness: harness.get(id) };
  });

  app.get('/api/sessions/:id/harness/steps/:index/diff', async (req, reply) => {
    const { id, index } = req.params as { id: string; index: string };
    const result = await harness.diff(id, Number(index));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.value;
  });

  /** Reopen a waiting gate (nothing is sent); on a finished step, the same as go-back. */
  app.post('/api/sessions/:id/harness/steps/:index/reopen', (req, reply) => {
    const { id, index } = req.params as { id: string; index: string };
    const result = harness.reopen(id, Number(index));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { harness: result.value };
  });

  /** "Go back here": the checklist side; the client rewinds the conversation as before. */
  app.post('/api/sessions/:id/harness/steps/:index/go-back', (req, reply) => {
    const { id, index } = req.params as { id: string; index: string };
    const result = harness.goBack(id, Number(index));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { harness: result.value };
  });

  /** "Decide myself": stops a running review; the gate waits for the user. */
  app.post('/api/sessions/:id/harness/steps/:index/decide-myself', (req, reply) => {
    const { id, index } = req.params as { id: string; index: string };
    const result = harness.decideMyself(id, Number(index));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { harness: result.value };
  });

  /**
   * Carries another session's harness into this one and sends it the current
   * step (spec § 8). Clear does the same with `carryHarness: true`.
   */
  app.post('/api/sessions/:id/harness/carry', async (req, reply) => {
    if (!enabled()) return reply.code(403).send({ error: 'harness_disabled' });
    const { id } = req.params as { id: string };
    const { fromSessionId } = (req.body ?? {}) as { fromSessionId?: unknown };
    if (typeof fromSessionId !== 'string' || !fromSessionId) return reply.code(400).send({ error: 'fromSessionId is required' });
    const result = await carryHarness(fromSessionId, id);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { harness: harness.get(id) };
  });

  return { carryHarness };

  async function carryHarness(fromId: string, toId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const result = harness.carry(fromId, toId);
    if (!result.ok) return result;
    const { kickoff, index } = result.value;
    const delivery = await harness.say(toId, kickoff, 'kickoff', index);
    if (harness.get(toId)?.state[index]?.status === 'active') await harness.stepStarted(toId, index, delivery.uuid);
    return { ok: true };
  }
}
