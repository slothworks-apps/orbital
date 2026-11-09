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
import { expandHome } from '../paths.js';
import { isScope } from '../harness/logic.js';
import { NAME_SESSIONS_KEY } from '../titler/titler.js';
import type { HarnessTemplate } from '../harness/types.js';
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

type Refusal = { ok: false; status: number; error: string };

/** A launch's harness, checked before anything spawns (spec 2026-11-09-harness-from-new-session-design § The server). */
export interface LaunchHarnessPlan {
  templateId: number;
  inputs: Record<string, string>;
  /** Present only where it differs from the template's default. */
  lucky?: boolean;
  /** What the session is named from, and its worktree's branch. */
  subject: string;
}

/**
 * `POST /api/sessions` with `harness`: the session starts on the checklist,
 * its kickoff the first turn. The launch route calls these in order —
 * `check` before anything is written, `attach` just before the spawn (so the
 * session never runs a moment without its harness, and is never named from
 * the kickoff's text), `started` once the session exists; `discard` undoes
 * an `attach` whose spawn failed.
 */
export interface LaunchHarness {
  check(raw: unknown, cwd: string): { ok: true; plan: LaunchHarnessPlan } | Refusal;
  /** Attaches the harness and answers the first prompt: the kickoff, and the user's `prompt` as a note after it. */
  attach(sessionId: string, plan: LaunchHarnessPlan, prompt: string): { ok: true; text: string } | Refusal;
  /**
   * The first prompt went out under `uuid` with the launch's `attachments`
   * (image refs); `named`: the session already has a name (its worktree's).
   */
  started(sessionId: string, plan: LaunchHarnessPlan, uuid: string, text: string, named: boolean, attachments?: string[]): Promise<void>;
  discard(sessionId: string): void;
}

/** The header the user's own words follow the kickoff under, in a launch's first prompt. */
export const LAUNCH_NOTE_HEADER = 'A note from the user for step 1:';

/** A launch's first prompt: the kickoff, then what the user typed, as one message (§ The first message). */
export function launchPrompt(kickoff: string, prompt: string): string {
  const note = prompt.trim();
  return note ? `${kickoff}\n\n${LAUNCH_NOTE_HEADER}\n\n${note}` : kickoff;
}

/** The inputs a body carries, strings only. */
function inputValues(raw: unknown): Record<string, string> {
  const inputs = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(inputs).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}

/** The first input left empty that is required: every input is, unless its hint says it is optional (30c). */
function missingInput(template: HarnessTemplate | undefined, values: Record<string, string>): HarnessTemplate['inputs'][number] | undefined {
  return template?.inputs.find((input) => !values[input.key]?.trim() && !/optional/i.test(input.hint ?? ''));
}

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
): { carryHarness: CarryHarness; launchHarness: LaunchHarness } {
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

  /**
   * What New session offers for a directory no session runs in yet: the
   * start view's list for it, and the template of the latest harness in the
   * same project while it is still offered (spec
   * 2026-11-09-harness-from-new-session-design). In the `spawn` group of
   * the allowlist with the launch it serves, unlike the route above: a phone
   * that may launch sessions sees what it can launch with.
   */
  app.get('/api/sessions/harness-templates', (req, reply) => {
    if (!enabled()) return reply.code(403).send({ error: 'harness_disabled' });
    const { cwd } = req.query as { cwd?: unknown };
    if (typeof cwd !== 'string' || !cwd.trim()) return reply.code(400).send({ error: 'cwd is required' });
    const offer = harness.templatesForCwd(launchRoot(cwd));
    const last = offer.project ? harness.lastTemplateIn(offer.project.root) : null;
    return { ...offer, lastUsedId: offer.templates.some((t) => t.id === last) ? last : null };
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
    const values = inputValues(body.inputs);
    const missing = missingInput(harness.getTemplate(body.templateId), values);
    if (missing) return reply.code(400).send({ error: `${missing.label} is required` });
    const started = startedByHarness(id);
    const result = harness.attach(id, body.templateId, values);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    const delivery = await harness.say(id, result.value.kickoff, 'kickoff', 0);
    if (delivery.outcome === 'not_found' || delivery.outcome === 'terminal') {
      // A harness nobody can send to would only pretend to run.
      harness.discard(id);
      return reply.code(409).send({ error: delivery.outcome === 'terminal' ? 'session_is_terminal' : 'not found' });
    }
    await harness.stepStarted(id, 0, delivery.uuid);
    if (started) nameFromHarness(id, result.value.subject);
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

  const launchHarness: LaunchHarness = {
    check(raw, cwd) {
      if (!enabled()) return { ok: false, status: 403, error: 'harness_disabled' };
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, status: 400, error: 'harness must be { templateId, inputs, lucky }' };
      }
      const body = raw as { templateId?: unknown; inputs?: unknown; lucky?: unknown };
      if (typeof body.templateId !== 'number') return { ok: false, status: 400, error: 'templateId must be a number' };
      if (body.lucky !== undefined && typeof body.lucky !== 'boolean') return { ok: false, status: 400, error: 'lucky must be a boolean' };
      const values = inputValues(body.inputs);
      // Only what the start view offers this directory: a draft or another
      // project's template is not there, so it is not found here either.
      const template = harness.getTemplate(body.templateId);
      const root = projectRootOf(launchRoot(cwd));
      const offered = template && !template.draft && (template.scope.kind === 'global' || template.scope.root === root);
      if (!offered) return { ok: false, status: 404, error: 'template not found' };
      const missing = missingInput(template, values);
      if (missing) return { ok: false, status: 400, error: `${missing.label} is required` };
      const preview = harness.preview(template.id, values);
      if (!preview.ok) return preview;
      return {
        ok: true,
        plan: {
          templateId: template.id, inputs: values, subject: preview.value.subject,
          ...(typeof body.lucky === 'boolean' && body.lucky !== template.options.lucky ? { lucky: body.lucky } : {}),
        },
      };
    },
    attach(sessionId, plan, prompt) {
      const result = harness.attach(sessionId, plan.templateId, plan.inputs);
      if (!result.ok) return result;
      if (plan.lucky !== undefined) {
        const tuned = harness.setOptions(sessionId, { lucky: plan.lucky });
        if (!tuned.ok) {
          harness.discard(sessionId);
          return tuned;
        }
      }
      const text = launchPrompt(result.value.kickoff, prompt);
      // Before the spawn, so the session's echo of it never reads as the user's.
      harness.noteSent(sessionId, text);
      return { ok: true, text };
    },
    async started(sessionId, plan, uuid, text, named, attachments) {
      // The kickoff's live row shows the images the launch sent with it, as a composer's turn does.
      const images = (attachments ?? []).flatMap((ref) => ctx.images.entry(ref) ?? []);
      harness.recordSent(sessionId, uuid, 'kickoff', 0, text, images);
      await harness.stepStarted(sessionId, 0, uuid);
      if (!named) nameFromHarness(sessionId, plan.subject);
    },
    discard(sessionId) {
      harness.discard(sessionId);
      harness.forget(sessionId);
    },
  };

  return { carryHarness, launchHarness };

  /**
   * The directory a launch's templates are read for, as a session's cwd is
   * matched against them: expanded, through symlinks; a worktree's resolves
   * to its repository through `projectRootOf` in the service.
   */
  function launchRoot(cwd: string): string {
    const expanded = expandHome(cwd);
    try {
      return realpathSync(expanded);
    } catch {
      return expanded;
    }
  }

  async function carryHarness(fromId: string, toId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const started = startedByHarness(toId);
    const result = harness.carry(fromId, toId);
    if (!result.ok) return result;
    const { kickoff, index, subject } = result.value;
    const delivery = await harness.say(toId, kickoff, 'kickoff', index);
    if (harness.get(toId)?.state[index]?.status === 'active') await harness.stepStarted(toId, index, delivery.uuid);
    if (started) nameFromHarness(toId, subject);
    return { ok: true };
  }

  /**
   * Whether the harness's kickoff will be the session's first message:
   * nobody has written in it yet. A session that has a conversation keeps
   * the name it has.
   */
  function startedByHarness(id: string): boolean {
    return !(readTranscript(id) ?? []).some((m) => m.role === 'user');
  }

  /** Names a session the harness started, in the background, as any other is named from its first message. */
  function nameFromHarness(id: string, subject: string): void {
    if (ctx.settings.get(NAME_SESSIONS_KEY) !== 'false') void ctx.titler.nameFromHarness(id, subject);
  }
}
