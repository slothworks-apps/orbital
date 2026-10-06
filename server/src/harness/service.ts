/**
 * Harness templates and the checklists they become in sessions (spec
 * 2026-09-30-session-harness-design, redesigned in 2026-10-02-harness-
 * redesign-design). Owns the harness tables, the agent's checklist tools, and
 * what happens when a harnessed session's turn ends. The decisions themselves
 * are in `logic.ts`; this file is the glue to the database, the Runner and
 * the model.
 */

import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { and, desc, eq, gte, isNull, lt, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { OrbitalDb } from '../db/database.js';
import {
  harnessEvents, harnessInterviews, harnessMessages, harnessTemplates, sessionHarnessProposals, sessionHarnesses, sessions,
} from '../db/schema.js';
import type { SessionTools } from '../runner/runner.js';
import { ORBITAL_MCP_SERVER as HARNESS_MCP_SERVER } from '../runner/spawnTool.js';
import type { ChatMessage } from '../types.js';
import {
  advanceMessage, applyChanges, approve, checklistLines, decideTurnEnd, descendantsOf, editedMessage, gateIndexes,
  goBack, initialState, isFinished, kickoffMessage, normalizeOptions, nudgeMessage, openIndexes, patchStep,
  reviewerReopen, reviewerReopenMessage, reviewerTakes, snapshotSteps, statusText, tick, userReopen, validateTemplate,
  withReview, type ChecklistDiff, type TickRecord,
} from './logic.js';
import type {
  HarnessChanges, HarnessEvent, HarnessEventKind, HarnessInput, HarnessMessageKind, HarnessOptions, HarnessProject,
  HarnessProposal, HarnessStep, HarnessTemplate, PauseKind, ProposedHarness, SessionHarness, StepReview, StepState,
  TemplateScope,
} from './types.js';
import { buildReviewPrompt, parseReviewReply } from './reviewer.js';
import { buildWatcherPrompt, parseWatcherReply } from './watcher.js';
import { TEMPLATE_GUIDE, buildDraftPrompt, digestTranscript, draftTemplate, type ParsedDraft } from './drafter.js';
import { projectName, projectOf, projectRootOf } from './project.js';

const TOOL_STATUS = 'harness_status';
const TOOL_COMPLETE = 'harness_complete_step';
const TOOL_SAVE_TEMPLATE = 'harness_save_template';
const TOOL_PROPOSE = 'harness_propose';

/** The model a drafting call or conversation runs on when none is named (spec 2026-10-02 § Drafting model). */
export const DEFAULT_DRAFT_MODEL = 'opus';

/** A step as the agent's tools take it. */
const STEP_SCHEMA = z.object({
  id: z.string(),
  title: z.string(),
  instructions: z.string(),
  mode: z.enum(['auto', 'gate']),
  doneWhen: z.string(),
  verify: z.string().optional(),
  dependsOn: z.array(z.string()).optional().describe('Ids of earlier steps this one needs. Absent: the step before it; []: none.'),
});
/** The models a drafting call or conversation may run on. */
export const DRAFT_MODELS = ['opus', 'sonnet'] as const;
export type DraftModel = (typeof DRAFT_MODELS)[number];

/** The reviewer's model when neither the harness nor the session names one. */
const FALLBACK_REVIEWER_MODEL = 'opus';

/**
 * The first prompt of a "Draft in a conversation" session (spec
 * 2026-09-30-assisted-harness-templates-design § Path 3).
 */
export const INTERVIEW_PROMPT = `Help me write an Orbital harness template: a checklist for one kind of work that I repeat, which an agent then follows step by step.

Interview me first, one question at a time: what the work is, what I give at the start (links, tickets, names), the phases it goes through in order, where I want to look and decide before it goes on, and how each phase is known to be done. Keep it short; stop asking once you can draft it.

Then show me the checklist as a numbered list (each step: title, auto or gate, done when). When I agree, save it with the \`mcp__orbital__${TOOL_SAVE_TEMPLATE}\` tool. It is saved as a draft that I open and save in Orbital's Settings; saving again from this conversation updates that draft. If the tool reports a problem, fix it and save again. Do not change any files.

${TEMPLATE_GUIDE}`;

/** A verify command that runs longer than this fails the tick. */
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
/** What of a failing verify's output goes back to the agent, from the end. */
const VERIFY_OUTPUT_CHARS = 4000;
/** How many of the newest sessions `knownProjects` reads its projects from. */
const PROJECTS_SCAN_ROWS = 2000;
/** The most events one read of the log returns. */
export const MAX_EVENTS_PAGE = 2000;

/** A step's commit range as the record shows it; `commits` and `pushed` are null when the repository could not say. */
export interface StepDiff {
  range: string;
  stat: string;
  patch: string;
  commits: number | null;
  pushed: boolean | null;
}

export interface VerifyResult {
  ok: boolean;
  output: string;
}

/** What a delivery into a session did, and the uuid of the user entry it became. */
export interface Delivery {
  outcome: 'sent' | 'revived' | 'not_found' | 'terminal';
  uuid: string | null;
}

/** How the routes deliver into a session — reviving it when it sleeps. Handed over at registration. */
export type Deliver = (sessionId: string, text: string) => Promise<Delivery>;

/** A step's patch is capped for the panel; `git` itself has the rest. */
const MAX_DIFF_CHARS = 200_000;

export interface HarnessDeps {
  db: OrbitalDb;
  /** The `harness_enabled` setting, read at the point of use. */
  isEnabled(): boolean;
  /** The session's working directory, for verify commands. */
  cwdOf(sessionId: string): string | undefined;
  /** The session's model — the one asked for, else the one that ran — or null. The reviewer's default. */
  modelOf?(sessionId: string): string | null;
  /** Facts about the live session, from the Runner. */
  decisionPending(sessionId: string): boolean;
  backgroundWork(sessionId: string): boolean;
  /**
   * Sends text into a live session — the turn just ended, so the Runner
   * holds it — and returns the user message's uuid. Throws when it does not.
   */
  send(sessionId: string, text: string): string | null;
  /** The session's turn has ended and nothing runs in it: `needs_input` in the Runner. */
  isWaiting(sessionId: string): boolean;
  /** The watcher's one-shot model call; returns the raw reply. */
  askWatcher(prompt: string): Promise<string>;
  /** The template drafter's one-shot model call on `model`; returns the raw reply. */
  askDrafter(prompt: string, model: string): Promise<string>;
  /**
   * The lucky reviewer: a read-only agent in the session's directory; returns
   * its final text. Aborting the controller stops it, and the call rejects.
   */
  askReviewer(prompt: string, cwd: string, opts: { model: string; abortController: AbortController }): Promise<string>;
  /** `git <args>` in a directory. Tests replace it. */
  git?(cwd: string, args: string[]): Promise<VerifyResult>;
  /** Pushes the session's harness (or its removal) to the panel. */
  publish(sessionId: string, harness: SessionHarness | null): void;
  /** Announces a message Orbital sent on the harness's account, for the live transcript. */
  publishMessage?(sessionId: string, message: { uuid: string; kind: HarnessMessageKind; step: number; text: string; at: number }): void;
  onError?(sessionId: string, err: unknown, during: string): void;
  runVerify?(cwd: string, command: string): Promise<VerifyResult>;
  now?(): number;
  /** Deferral for the turn-end work, so the Runner's frame handling finishes first. Tests pass a sync one. */
  defer?: (fn: () => void) => void;
}

/** What a template is saved from: the editor's document, the drafter's, or the save tool's. */
export interface TemplateBody {
  name: string;
  description: string;
  tags: string[];
  inputs: HarnessInput[];
  steps: HarnessStep[];
  options: Partial<HarnessOptions>;
  /** Absent: global for a new template, unchanged for an update. `name` is ignored. */
  scope: { kind: 'global' } | { kind: 'project'; root: string; name?: string };
  /** Only a drafting conversation writes true; the editor's Save writes false. */
  draft: boolean;
}

/** Which templates to list. */
export interface TemplateFilter {
  /** `global`: global ones only; a root: that project's only. */
  scope?: 'global' | { project: string };
  /** Leave drafts out — what the start view offers. */
  savedOnly?: boolean;
}

export interface KnownProject extends HarnessProject {
  /** The newest session in it (epoch ms), or null. */
  lastAt: number | null;
  /** Its templates, drafts included. */
  templates: number;
}

function runGit(cwd: string, args: string[]): Promise<VerifyResult> {
  return new Promise((resolveResult) => {
    execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolveResult({ ok: !err, output: err ? String(stderr || err.message) : String(stdout) }),
    );
  });
}

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function runShell(cwd: string, command: string): Promise<VerifyResult> {
  return new Promise((resolveResult) => {
    // A login shell, so the user's PATH (node, npm, yarn) is there even when
    // the server was started by the desktop app.
    const child = spawn('/bin/zsh', ['-lc', command], { cwd, env: process.env });
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-VERIFY_OUTPUT_CHARS);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      output += `\n(verify timed out after ${VERIFY_TIMEOUT_MS / 60000} minutes)`;
    }, VERIFY_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveResult({ ok: false, output: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({ ok: code === 0, output: output.trim() });
    });
  });
}

/** `git add …` / `git commit …`, alone or joined by `&&` — nothing else, nothing that rewrites history. */
export function isLocalCommit(command: string): boolean {
  const parts = command.trim().split(/\s*&&\s*/);
  return parts.length > 0 && parts.every((part) =>
    /^git (add|commit)\b/.test(part) &&
    !/[;|<>`]|\$\(/.test(part) &&
    !/\s--amend\b|\s--no-verify\b|\spush\b/.test(part),
  );
}

type HarnessRow = typeof sessionHarnesses.$inferSelect;

export function toHarness(row: HarnessRow): SessionHarness {
  return {
    sessionId: row.sessionId,
    templateId: row.templateId,
    name: row.name,
    steps: row.steps,
    inputs: row.inputs,
    state: row.state,
    options: normalizeOptions(row.options),
    paused: row.paused === 1,
    pauseReason: row.pauseReason,
    pauseKind: row.pauseKind ?? null,
    pausedAt: row.pausedAt ?? null,
    removedAt: row.removedAt ?? null,
    autoRounds: row.autoRounds,
    idleNudges: row.idleNudges,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function scopeOf(root: string | null): TemplateScope {
  return root === null ? { kind: 'global' } : { kind: 'project', root, name: projectName(root) };
}

function toTemplate(row: typeof harnessTemplates.$inferSelect): HarnessTemplate {
  const { scopeRoot, draft, ...rest } = row;
  return { ...rest, options: normalizeOptions(row.options), scope: scopeOf(scopeRoot), draft: draft === 1 };
}

/** The `scope_root` a body names, or undefined when it names none. */
function rootOf(scope: TemplateBody['scope'] | undefined): string | null | undefined {
  if (!scope) return undefined;
  return scope.kind === 'project' ? resolve(scope.root) : null;
}

function cleanBody(body: Partial<TemplateBody>) {
  return {
    options: normalizeOptions(body.options),
    name: (body.name ?? '').trim(),
    description: typeof body.description === 'string' ? body.description : '',
    tags: (body.tags ?? []).map((t) => t.trim()).filter(Boolean),
    inputs: (body.inputs ?? []).map((i: HarnessInput) => ({
      key: i.key, label: i.label, ...(i.hint ? { hint: i.hint } : {}),
    })),
    steps: (body.steps ?? []).map((s: HarnessStep) => ({
      id: s.id.trim(), title: s.title, instructions: s.instructions, mode: s.mode, doneWhen: s.doneWhen,
      ...(s.verify?.trim() ? { verify: s.verify.trim() } : {}),
      ...(s.dependsOn ? { dependsOn: s.dependsOn.map((d) => d.trim()) } : {}),
    })),
  };
}

/** The step's state without the review's live marks. */
function stripReviewing(state: StepState[], index: number): StepState[] {
  return state.map((s, j) => {
    if (j !== index || !s.reviewing) return s;
    const { reviewing: _r, ...rest } = s;
    return rest;
  });
}

export class HarnessService {
  /**
   * Sessions whose agent ticked a step during the turn now running, with what
   * it had last said at that tick — to tell whether it spoke after.
   */
  private tickedThisTurn = new Map<string, string>();
  /** The agent's newest prose, per session — what the watcher reads. */
  private lastAgentText = new Map<string, string>();
  /** Text Orbital sent and has not seen come back as a user entry yet. */
  private sentByUs = new Map<string, string[]>();
  /** The review running per session, to stop it with. */
  private reviews = new Map<string, AbortController>();
  private deliver: Deliver | null = null;
  /** Set once the server closes: work deferred past that point has no database. */
  private disposed = false;

  constructor(private deps: HarnessDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The routes hand over their delivery, which can revive a sleeping session. */
  useDelivery(deliver: Deliver): void {
    this.deliver = deliver;
  }

  private git(cwd: string, args: string[]): Promise<VerifyResult> {
    return (this.deps.git ?? runGit)(cwd, args);
  }

  /** HEAD in the session's directory, or undefined outside a repository. */
  private async head(sessionId: string): Promise<string | undefined> {
    const cwd = this.deps.cwdOf(sessionId);
    if (!cwd) return undefined;
    const r = await this.git(cwd, ['rev-parse', 'HEAD']);
    return r.ok ? r.output.trim() : undefined;
  }

  // ── Templates ─────────────────────────────────────────────────────────

  listTemplates(filter: TemplateFilter = {}): HarnessTemplate[] {
    const { scope, savedOnly } = filter;
    const where = and(
      scope === 'global' ? isNull(harnessTemplates.scopeRoot)
        : scope ? eq(harnessTemplates.scopeRoot, resolve(scope.project)) : undefined,
      savedOnly ? eq(harnessTemplates.draft, 0) : undefined,
    );
    return this.deps.db.select().from(harnessTemplates).where(where).orderBy(harnessTemplates.name).all().map(toTemplate);
  }

  /**
   * What the start view offers a session: its project's saved templates
   * first, then the global ones — never another project's, never a draft
   * (spec 2026-10-02-harness-redesign-design, 30c).
   */
  templatesForSession(sessionId: string): { project: HarnessProject | null; templates: HarnessTemplate[] } {
    const cwd = this.deps.cwdOf(sessionId);
    const project = cwd ? projectOf(cwd) : null;
    const own = project ? this.listTemplates({ scope: { project: project.root }, savedOnly: true }) : [];
    return { project, templates: [...own, ...this.listTemplates({ scope: 'global', savedOnly: true })] };
  }

  /**
   * Every project Orbital has seen a session in, plus every project a
   * template belongs to, newest first — the scope picker's ONE PROJECT list
   * and the Settings filter's chips (30j, 30m).
   */
  knownProjects(): KnownProject[] {
    const byRoot = new Map<string, KnownProject>();
    const cwds = this.deps.db
      .select({ cwd: sessions.cwd, lastAt: sessions.lastAt })
      .from(sessions)
      .where(ne(sessions.cwd, ''))
      .orderBy(desc(sessions.lastAt))
      .limit(PROJECTS_SCAN_ROWS)
      .all();
    const rootOfCwd = new Map<string, string>();
    for (const { cwd, lastAt } of cwds) {
      let root = rootOfCwd.get(cwd);
      if (root === undefined) {
        root = projectRootOf(cwd);
        rootOfCwd.set(cwd, root);
      }
      if (!byRoot.has(root)) byRoot.set(root, { root, name: projectName(root), lastAt: lastAt ?? null, templates: 0 });
    }
    for (const t of this.listTemplates()) {
      if (t.scope.kind !== 'project') continue;
      const known = byRoot.get(t.scope.root) ?? { root: t.scope.root, name: t.scope.name, lastAt: null, templates: 0 };
      known.templates += 1;
      byRoot.set(t.scope.root, known);
    }
    return [...byRoot.values()].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  }

  getTemplate(id: number): HarnessTemplate | undefined {
    const row = this.deps.db.select().from(harnessTemplates).where(eq(harnessTemplates.id, id)).get();
    return row && toTemplate(row);
  }

  createTemplate(body: Partial<TemplateBody>): Result<HarnessTemplate> {
    const error = validateTemplate(body);
    if (error) return { ok: false, status: 400, error };
    const now = this.now();
    const row = this.deps.db
      .insert(harnessTemplates)
      .values({
        ...cleanBody(body), scopeRoot: rootOf(body.scope) ?? null, draft: body.draft === true ? 1 : 0,
        createdAt: now, updatedAt: now,
      })
      .returning()
      .get();
    return { ok: true, value: toTemplate(row) };
  }

  /**
   * Saves the editor's document. A scope it does not name stays; saving
   * clears the draft mark unless the body keeps it (spec § 9: a draft is saved
   * only by Save).
   */
  updateTemplate(id: number, body: Partial<TemplateBody>): Result<HarnessTemplate> {
    if (!this.getTemplate(id)) return { ok: false, status: 404, error: 'not found' };
    const error = validateTemplate(body);
    if (error) return { ok: false, status: 400, error };
    const root = rootOf(body.scope);
    const row = this.deps.db
      .update(harnessTemplates)
      .set({
        ...cleanBody(body), ...(root !== undefined ? { scopeRoot: root } : {}),
        draft: body.draft === true ? 1 : 0, updatedAt: this.now(),
      })
      .where(eq(harnessTemplates.id, id))
      .returning()
      .get();
    return { ok: true, value: toTemplate(row) };
  }

  /** A copy of a template, saved, "(copy)" after its name; into `scope` when given. */
  duplicateTemplate(id: number, scope?: TemplateBody['scope']): Result<HarnessTemplate> {
    const t = this.getTemplate(id);
    if (!t) return { ok: false, status: 404, error: 'not found' };
    return this.createTemplate({ ...t, name: `${t.name} (copy)`, scope: scope ?? t.scope, draft: false });
  }

  /**
   * A model's draft of a template, not saved (spec 2026-09-30-assisted-
   * harness-templates-design § The drafter). Throws when the call fails.
   */
  async draft(input: { description?: string; messages?: ChatMessage[]; model?: string }): Promise<ParsedDraft> {
    const prompt = buildDraftPrompt({
      description: input.description,
      digest: input.messages?.length ? digestTranscript(input.messages) : undefined,
      existing: this.listTemplates().map((t) => t.name),
    });
    const model = input.model ?? DEFAULT_DRAFT_MODEL;
    return draftTemplate((p) => this.deps.askDrafter(p, model), prompt);
  }

  /** Sessions running it keep their snapshot. */
  deleteTemplate(id: number): void {
    this.deps.db.delete(harnessTemplates).where(eq(harnessTemplates.id, id)).run();
  }

  /**
   * Records a drafting conversation's brief as it launches: where its
   * template is saved (spec 2026-10-02-harness-redesign-design § 9).
   */
  noteInterview(sessionId: string, scope: TemplateBody['scope'], model: string): void {
    this.deps.db
      .insert(harnessInterviews)
      .values({ sessionId, scopeRoot: rootOf(scope) ?? null, model, createdAt: this.now() })
      .onConflictDoNothing()
      .run();
  }

  /**
   * `harness_save_template`: a session writes a template as a draft. A
   * drafting conversation saves into the scope it was launched with; any
   * other session into its own project. A second save from the same session
   * updates its draft, as long as the user has not saved that yet.
   */
  saveDraftFrom(sessionId: string, body: Partial<Omit<TemplateBody, 'scope' | 'draft'>>): Result<HarnessTemplate> {
    const { db } = this.deps;
    let brief = db.select().from(harnessInterviews).where(eq(harnessInterviews.sessionId, sessionId)).get();
    if (!brief) {
      const cwd = this.deps.cwdOf(sessionId);
      this.noteInterview(sessionId, cwd ? { kind: 'project', root: projectRootOf(cwd) } : { kind: 'global' }, '');
      brief = db.select().from(harnessInterviews).where(eq(harnessInterviews.sessionId, sessionId)).get()!;
    }
    const scope: TemplateBody['scope'] = brief.scopeRoot === null ? { kind: 'global' } : { kind: 'project', root: brief.scopeRoot };
    const earlier = brief.templateId !== null ? this.getTemplate(brief.templateId) : undefined;
    const result = earlier?.draft
      ? this.updateTemplate(earlier.id, { ...body, scope, draft: true })
      : this.createTemplate({ ...body, scope, draft: true });
    if (result.ok) {
      db.update(harnessInterviews).set({ templateId: result.value.id }).where(eq(harnessInterviews.sessionId, sessionId)).run();
    }
    return result;
  }

  // ── A session's harness ───────────────────────────────────────────────

  private row(sessionId: string): HarnessRow | undefined {
    return this.deps.db.select().from(sessionHarnesses).where(eq(sessionHarnesses.sessionId, sessionId)).get();
  }

  /** The session's live harness; a removed one is not. */
  get(sessionId: string): SessionHarness | null {
    const row = this.row(sessionId);
    return row && row.removedAt === null ? toHarness(row) : null;
  }

  /** The session's removed harness, kept for its records, or null. */
  removed(sessionId: string): SessionHarness | null {
    const row = this.row(sessionId);
    return row && row.removedAt !== null ? toHarness(row) : null;
  }

  /** The log, newest first; `before` pages back by event id. */
  events(sessionId: string, opts: { limit?: number; before?: number } = {}): HarnessEvent[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_EVENTS_PAGE);
    return this.deps.db
      .select()
      .from(harnessEvents)
      .where(and(
        eq(harnessEvents.sessionId, sessionId),
        opts.before !== undefined ? lt(harnessEvents.id, opts.before) : undefined,
      ))
      // By id, which is insertion order, so `before` pages without gaps.
      .orderBy(desc(harnessEvents.id))
      .limit(limit)
      .all();
  }

  /** The messages Orbital sent into the session on a harness's account, by entry uuid. */
  messagesOf(sessionId: string): Map<string, { kind: HarnessMessageKind; step: number }> {
    const rows = this.deps.db.select().from(harnessMessages).where(eq(harnessMessages.sessionId, sessionId)).all();
    return new Map(rows.map((r) => [r.uuid, { kind: r.kind, step: r.stepIndex }]));
  }

  // ── Proposals and edits ───────────────────────────────────────────────

  /** What the agent proposed and the user has not decided yet, or null. */
  proposal(sessionId: string): HarnessProposal | null {
    const row = this.deps.db.select().from(sessionHarnessProposals).where(eq(sessionHarnessProposals.sessionId, sessionId)).get();
    if (!row) return null;
    const rest = { note: row.note, createdAt: row.createdAt };
    return row.kind === 'harness'
      ? { kind: 'harness', harness: row.body as ProposedHarness, ...rest }
      : { kind: 'changes', changes: row.body as HarnessChanges, ...rest };
  }

  /**
   * `harness_propose`: the agent proposes a whole harness, when the session
   * has none, or a change to the one it runs. Checked as it would be applied;
   * a newer proposal replaces one the user has not decided yet.
   */
  propose(
    sessionId: string,
    proposed: { kind: 'harness'; harness: ProposedHarness } | { kind: 'changes'; changes: HarnessChanges } | null,
    note: string | null,
  ): Result<HarnessProposal> {
    const checked = this.checkProposal(sessionId, proposed);
    if (!checked.ok) return checked;
    const earlier = this.proposal(sessionId);
    if (earlier) this.log(sessionId, 'proposal_superseded', { kind: earlier.kind });
    this.storeProposal(sessionId, checked.value.kind, checked.value.body, note?.trim() || null);
    this.log(sessionId, 'proposed', { kind: checked.value.kind, note: note?.trim() || null });
    this.deps.publish(sessionId, this.get(sessionId));
    return { ok: true, value: this.proposal(sessionId)! };
  }

  /** A proposal as it would be stored, or why it cannot be: checked as it would be applied. */
  private checkProposal(
    sessionId: string,
    proposed: { kind: 'harness'; harness: ProposedHarness } | { kind: 'changes'; changes: HarnessChanges } | null,
  ): Result<{ kind: 'harness' | 'changes'; body: ProposedHarness | HarnessChanges }> {
    if (!proposed) return { ok: false, status: 400, error: 'send a harness or changes' };
    const h = this.get(sessionId);
    let body: ProposedHarness | HarnessChanges;
    if (proposed.kind === 'harness') {
      if (h) return { ok: false, status: 409, error: `this session already runs the harness "${h.name}"; propose changes to it instead` };
      const { name, steps } = cleanBody({ name: proposed.harness.name, steps: proposed.harness.steps });
      const error = validateTemplate({ name, tags: [], inputs: [], steps });
      if (error) return { ok: false, status: 400, error };
      body = { name, steps };
    } else {
      if (!h) return { ok: false, status: 409, error: 'this session runs no harness; propose a whole harness instead' };
      const tried = applyChanges(h.steps, h.state, proposed.changes, this.now());
      if (!tried.ok) return { ok: false, status: 400, error: tried.error };
      body = proposed.changes;
    }
    return { ok: true, value: { kind: proposed.kind, body } };
  }

  private storeProposal(sessionId: string, kind: 'harness' | 'changes', body: ProposedHarness | HarnessChanges, note: string | null): void {
    const row = { kind, body, note, createdAt: this.now() };
    this.deps.db.insert(sessionHarnessProposals).values({ sessionId, ...row })
      .onConflictDoUpdate({ target: sessionHarnessProposals.sessionId, set: row }).run();
  }

  discardProposal(sessionId: string): Result<null> {
    if (!this.proposal(sessionId)) return { ok: false, status: 409, error: 'nothing is proposed' };
    this.dropProposal(sessionId);
    this.log(sessionId, 'proposal_discarded');
    this.deps.publish(sessionId, this.get(sessionId));
    return { ok: true, value: null };
  }

  private dropProposal(sessionId: string): void {
    this.deps.db.delete(sessionHarnessProposals).where(eq(sessionHarnessProposals.sessionId, sessionId)).run();
  }

  /**
   * The user applies what the agent proposed. A whole harness is attached,
   * without a template, and its kickoff returned for the caller to deliver;
   * changes are applied as the user's edit would be. `edited` is the user's
   * version of it from Edit, of the same kind. 409 when nothing is proposed,
   * or when the harness moved on and the changes no longer apply.
   */
  applyProposal(
    sessionId: string,
    edited?: { kind: 'harness'; harness: ProposedHarness } | { kind: 'changes'; changes: HarnessChanges },
  ): Result<{ harness: SessionHarness; message: string | null; kind: 'kickoff' | 'edited' }> {
    const pending = this.proposal(sessionId);
    if (!pending) return { ok: false, status: 409, error: 'nothing is proposed' };
    if (edited) {
      if (edited.kind !== pending.kind) return { ok: false, status: 400, error: `the proposal is ${pending.kind === 'harness' ? 'a harness' : 'a change'}` };
      const checked = this.checkProposal(sessionId, edited);
      if (!checked.ok) return checked;
      this.storeProposal(sessionId, checked.value.kind, checked.value.body, pending.note);
    }
    const p = this.proposal(sessionId)!;
    if (p.kind === 'changes') {
      const result = this.edit(sessionId, p.changes, 'agent');
      if (!result.ok) return { ok: false, status: 409, error: result.error };
      this.dropProposal(sessionId);
      this.log(sessionId, 'proposal_applied', { kind: 'changes' });
      this.deps.publish(sessionId, result.value.harness);
      return { ok: true, value: { ...result.value, kind: 'edited' } };
    }
    if (this.get(sessionId)) return { ok: false, status: 409, error: 'this session already has a harness' };
    const now = this.now();
    const { name, steps } = p.harness;
    this.deps.db.delete(sessionHarnesses).where(eq(sessionHarnesses.sessionId, sessionId)).run();
    const row = this.deps.db
      .insert(sessionHarnesses)
      .values({
        sessionId, templateId: null, name, steps, inputs: {}, state: initialState(steps), options: normalizeOptions({}),
        createdAt: now, updatedAt: now,
      })
      .returning()
      .get();
    const harness = toHarness(row);
    this.dropProposal(sessionId);
    this.log(sessionId, 'proposal_applied', { kind: 'harness' });
    this.log(sessionId, 'attached', { templateId: null, name, inputs: {} });
    this.deps.publish(sessionId, harness);
    return { ok: true, value: { harness, message: kickoffMessage(harness, []), kind: 'kickoff' } };
  }

  /**
   * Changes the running harness (spec 2026-10-06-harness-graph-and-proposals-
   * design § Edits by the user). Returns the message that tells the agent,
   * for the caller to deliver; null while paused — resuming sends the open
   * steps — or when nothing is left to do.
   */
  edit(sessionId: string, changes: HarnessChanges, by: 'user' | 'agent'): Result<{ harness: SessionHarness; message: string | null }> {
    const h = this.get(sessionId);
    if (!h) return { ok: false, status: 409, error: 'no harness' };
    const result = applyChanges(h.steps, h.state, changes, this.now());
    if (!result.ok) return { ok: false, status: 400, error: result.error };
    const saved = this.save({ ...h, steps: result.steps, state: result.state });
    const diff: ChecklistDiff = result.diff;
    this.log(sessionId, 'edited', { by, ...diff });
    if (isFinished(saved.state)) {
      this.log(sessionId, 'finished');
      return { ok: true, value: { harness: saved, message: null } };
    }
    const message = saved.paused ? null : editedMessage(saved, diff, by);
    return { ok: true, value: { harness: saved, message } };
  }

  private log(sessionId: string, kind: HarnessEventKind, detail: Record<string, unknown> = {}): void {
    this.deps.db.insert(harnessEvents).values({ sessionId, at: this.now(), kind, detail }).run();
  }

  /** A step's event: its id and its index, so the panel can file it under the step. */
  private logStep(h: SessionHarness, index: number, kind: HarnessEventKind, detail: Record<string, unknown> = {}): void {
    this.log(h.sessionId, kind, { step: h.steps[index]?.id, index, ...detail });
  }

  private save(h: SessionHarness): SessionHarness {
    const updated = { ...h, updatedAt: this.now() };
    this.deps.db
      .update(sessionHarnesses)
      .set({
        steps: updated.steps,
        state: updated.state,
        options: updated.options,
        paused: updated.paused ? 1 : 0,
        pauseReason: updated.pauseReason,
        pauseKind: updated.pauseKind,
        pausedAt: updated.pausedAt,
        autoRounds: updated.autoRounds,
        idleNudges: updated.idleNudges,
        updatedAt: updated.updatedAt,
      })
      .where(eq(sessionHarnesses.sessionId, h.sessionId))
      .run();
    this.deps.publish(h.sessionId, updated);
    return updated;
  }

  private pause(h: SessionHarness, kind: PauseKind, reason: string | null): SessionHarness {
    return this.save({ ...h, paused: true, pauseKind: kind, pauseReason: reason, pausedAt: this.now() });
  }

  /**
   * Puts a template into a session. Returns the kickoff message; the caller
   * delivers it, because only the routes can revive a sleeping session. A
   * removed harness the session had is replaced; its events stay in the log.
   */
  attach(sessionId: string, templateId: number, inputs: Record<string, string>): Result<{ harness: SessionHarness; kickoff: string }> {
    if (this.get(sessionId)) return { ok: false, status: 409, error: 'this session already has a harness' };
    const template = this.getTemplate(templateId);
    if (!template) return { ok: false, status: 404, error: 'template not found' };
    const values: Record<string, string> = {};
    for (const input of template.inputs) values[input.key] = (inputs[input.key] ?? '').trim();
    const steps = snapshotSteps(template.steps, values);
    const now = this.now();
    this.deps.db.delete(sessionHarnesses).where(eq(sessionHarnesses.sessionId, sessionId)).run();
    const row = this.deps.db
      .insert(sessionHarnesses)
      .values({
        sessionId, templateId, name: template.name, steps, inputs: values,
        state: initialState(steps), options: template.options, createdAt: now, updatedAt: now,
      })
      .returning()
      .get();
    const harness = toHarness(row);
    this.log(sessionId, 'attached', { templateId, name: template.name, inputs: values, scope: template.scope });
    this.deps.publish(sessionId, harness);
    const kickoff = kickoffMessage(harness, template.inputs);
    return { ok: true, value: { harness, kickoff } };
  }

  /** Undoes an attach that never reached the session: no record is kept of a harness that never ran. */
  discard(sessionId: string): void {
    this.deps.db.delete(sessionHarnesses).where(eq(sessionHarnesses.sessionId, sessionId)).run();
    this.tickedThisTurn.delete(sessionId);
    this.deps.publish(sessionId, null);
  }

  /**
   * What Orbital learns as a step begins: when, git HEAD, and the message that
   * began it — the rewind target of "go back here". Called by whoever sent
   * that message.
   */
  async stepStarted(sessionId: string, index: number, messageUuid: string | null): Promise<void> {
    const head = await this.head(sessionId);
    const h = this.get(sessionId);
    if (!h || !h.state[index]) return;
    this.save({
      ...h,
      state: patchStep(h.state, index, {
        startedAt: this.now(),
        ...(head ? { startHead: head } : {}),
        ...(messageUuid ? { startMessageUuid: messageUuid } : {}),
      }),
    });
  }

  /**
   * `stepStarted` for every open step that has not begun yet: the ones a
   * message just sent the agent to.
   */
  async openStepsStarted(sessionId: string, messageUuid: string | null): Promise<void> {
    const h = this.get(sessionId);
    if (!h) return;
    for (const i of openIndexes(h.state)) {
      if (h.state[i].startedAt === undefined) await this.stepStarted(sessionId, i, messageUuid);
    }
  }

  /**
   * The harness leaves the session; automation stops. The row stays, marked
   * removed, so the step records stay readable (spec § 6).
   */
  remove(sessionId: string): Result<SessionHarness> {
    const h = this.get(sessionId);
    if (!h) return { ok: false, status: 404, error: 'no harness' };
    this.abortReview(sessionId);
    const now = this.now();
    const state = h.state.map((s, i) => (s.reviewing ? stripReviewing(h.state, i)[i] : s));
    this.deps.db
      .update(sessionHarnesses)
      .set({ removedAt: now, state, updatedAt: now })
      .where(eq(sessionHarnesses.sessionId, sessionId))
      .run();
    this.log(sessionId, 'removed', { done: h.state.filter((s) => s.status === 'done').length });
    this.tickedThisTurn.delete(sessionId);
    this.deps.publish(sessionId, null);
    return { ok: true, value: { ...h, state, removedAt: now, updatedAt: now } };
  }

  /**
   * The user approves a gate. Returns the message that sends the agent to the
   * steps the approval opened, for the caller to deliver, or null when it
   * opened none — the last step, or the agent is still on other branches.
   */
  approve(sessionId: string, index: number): Result<{ harness: SessionHarness; message: string | null }> {
    const h = this.get(sessionId);
    if (!h) return { ok: false, status: 404, error: 'no harness' };
    const state = approve(h.steps, h.state, index);
    if (!state) return { ok: false, status: 409, error: 'that step does not wait for approval' };
    this.abortReview(sessionId);
    const saved = this.save({ ...h, state, idleNudges: 0 });
    this.logStep(h, index, 'approved', { by: 'user' });
    if (isFinished(state)) {
      this.log(sessionId, 'finished');
      return { ok: true, value: { harness: saved, message: null } };
    }
    const opened = openIndexes(state).some((i) => h.state[i].status !== 'active');
    return { ok: true, value: { harness: saved, message: opened ? advanceMessage(saved) : null } };
  }

  /**
   * The user's Reopen on a waiting gate: the step is active again and nothing
   * is sent. On a finished step it is "Go back here" (`goBack`), which is what
   * this route meant before the two were told apart.
   */
  reopen(sessionId: string, index: number): Result<SessionHarness> {
    const h = this.get(sessionId);
    if (!h) return { ok: false, status: 404, error: 'no harness' };
    if (h.state[index]?.status === 'done') return this.goBack(sessionId, index);
    const state = userReopen(h.state, index, this.now());
    if (!state) return { ok: false, status: 409, error: 'that step does not wait for approval' };
    this.abortReview(sessionId);
    this.logStep(h, index, 'reopened', { by: 'user' });
    return { ok: true, value: this.save({ ...h, state, idleNudges: 0 }) };
  }

  /**
   * "Go back here" (spec § 6): the checklist reopens from a finished step;
   * the step and every one after it keep their records as previous runs,
   * "before going back". The conversation's rewind is the client's, as before.
   */
  goBack(sessionId: string, index: number): Result<SessionHarness> {
    const h = this.get(sessionId);
    if (!h) return { ok: false, status: 404, error: 'no harness' };
    const state = goBack(h.steps, h.state, index, this.now());
    if (!state) return { ok: false, status: 409, error: 'that step is not finished' };
    this.abortReview(sessionId);
    this.logStep(h, index, 'went_back', { pending: [index, ...descendantsOf(h.steps, index)].map((i) => h.steps[i].id) });
    return { ok: true, value: this.save({ ...h, state, idleNudges: 0 }) };
  }

  setPaused(sessionId: string, paused: boolean): Result<SessionHarness> {
    const h = this.get(sessionId);
    if (!h) return { ok: false, status: 404, error: 'no harness' };
    this.log(sessionId, paused ? 'paused' : 'resumed', { by: 'user' });
    if (paused) return { ok: true, value: this.pause(h, 'user', null) };
    // Resuming is the user looking at it: the caps start over.
    const saved = this.save({ ...h, paused: false, pauseReason: null, pauseKind: null, pausedAt: null, autoRounds: 0, idleNudges: 0 });
    void this.continueFrom(saved).catch((err) => this.report(sessionId, err, 'resuming a harness'));
    return { ok: true, value: saved };
  }

  /**
   * Auto-continue back on: carry on from where the checklist stands (30f).
   * Gates go to the reviewer when lucky is on; findings held back while
   * paused go out; open steps nobody sent yet are sent; otherwise a session
   * waiting for input is treated as a turn that just ended.
   */
  private async continueFrom(h: SessionHarness): Promise<void> {
    if (!this.deps.isEnabled() || isFinished(h.state)) return;
    this.reviewIfWaiting(h);
    const open = openIndexes(h.state);
    const held = open.find((i) => h.state[i].unsentFindings && h.state[i].reviews?.length);
    if (held !== undefined) {
      const { unsentFindings: _u, ...rest } = h.state[held];
      const saved = this.save({ ...h, state: h.state.map((x, j) => (j === held ? rest : x)) });
      await this.sendOnOwn(saved, reviewerReopenMessage(saved, held, rest.reviews!.at(-1)!), { kind: 'findings', step: held }, { revive: true });
      return;
    }
    if (open.some((i) => h.state[i].startedAt === undefined)) {
      await this.advanceTo(h, { revive: true });
      return;
    }
    if (open.length > 0 && this.deps.isWaiting(h.sessionId)) await this.handleTurnEnd(h.sessionId);
  }

  /**
   * The session's options, changed from the panel. Turning lucky on hands a
   * gate already waiting to the reviewer, paused or not; turning it off stops
   * a review running (30f).
   */
  setOptions(sessionId: string, patch: Partial<HarnessOptions>): Result<SessionHarness> {
    const h = this.get(sessionId);
    if (!h) return { ok: false, status: 404, error: 'no harness' };
    const options = normalizeOptions({ ...h.options, ...patch });
    this.log(sessionId, 'options', { ...patch });
    let state = h.state;
    const reviewing = state.findIndex((s) => s.reviewing);
    if (reviewing !== -1 && h.options.lucky && !options.lucky) {
      this.abortReview(sessionId);
      state = stripReviewing(state, reviewing);
      this.logStep(h, reviewing, 'review_aborted', { by: 'lucky_off' });
    }
    if (!h.options.lucky && options.lucky) {
      state = state.map((s) => {
        if (!s.reviewerOff) return s;
        const { reviewerOff: _o, ...rest } = s;
        return rest;
      });
    }
    const saved = this.save({ ...h, options, state });
    this.reviewIfWaiting(saved);
    return { ok: true, value: saved };
  }

  /**
   * "Decide myself" (30d): the reviewer stops, and the gate waits for the
   * user — no review starts on it again until it leaves the gate or lucky is
   * turned on anew.
   */
  decideMyself(sessionId: string, index: number): Result<SessionHarness> {
    const h = this.get(sessionId);
    if (!h) return { ok: false, status: 404, error: 'no harness' };
    if (h.state[index]?.status !== 'awaiting_approval') return { ok: false, status: 409, error: 'that step does not wait for approval' };
    const wasReviewing = h.state[index].reviewing === true;
    this.abortReview(sessionId);
    const state = patchStep(stripReviewing(h.state, index), index, { reviewerOff: true });
    if (wasReviewing) this.logStep(h, index, 'review_aborted', { by: 'user' });
    return { ok: true, value: this.save({ ...h, state }) };
  }

  private abortReview(sessionId: string): void {
    const controller = this.reviews.get(sessionId);
    if (!controller) return;
    this.reviews.delete(sessionId);
    controller.abort();
  }

  /** Hands a gate the reviewer takes to it; one review runs at a time, the next gate waits for the next chance. */
  private reviewIfWaiting(h: SessionHarness): void {
    const i = gateIndexes(h.state).find((g) => reviewerTakes(h, g));
    if (i !== undefined) {
      void this.review(h.sessionId, i).catch((err) => this.report(h.sessionId, err, 'reviewing a harness gate'));
    }
  }

  /**
   * At startup: a review cannot outlive the server that ran it. Every gate a
   * review was reading is left to the user, with an event saying why.
   */
  recover(): void {
    const rows = this.deps.db.select().from(sessionHarnesses).where(isNull(sessionHarnesses.removedAt)).all();
    for (const row of rows) {
      const h = toHarness(row);
      const i = h.state.findIndex((s) => s.reviewing);
      if (i === -1) continue;
      const state = h.state.map((s) => {
        if (!s.reviewing) return s;
        const { reviewing: _r, ...rest } = s;
        return { ...rest, reviewerOff: true as const };
      });
      this.logStep(h, i, 'review_aborted', { by: 'restart' });
      this.save({ ...h, state });
    }
  }

  /**
   * The user ended the session while its harness had steps left (30f
   * "session ended"): the harness pauses with the reason, ready to be
   * carried into a new session from Clear.
   */
  sessionEnded(sessionId: string): void {
    const h = this.get(sessionId);
    if (!h) return;
    const i = h.state.findIndex((s) => s.status !== 'done');
    if (i === -1) return;
    this.abortReview(sessionId);
    const reason = `The session ended during step ${i + 1}. Start a new session from Clear to continue with this harness.`;
    this.logStep(h, i, 'paused', { by: 'harness', kind: 'session_ended', reason });
    const state = h.state.map((s, j) => (s.reviewing ? stripReviewing(h.state, j)[j] : s));
    this.pause({ ...h, state }, 'session_ended', reason);
  }

  /**
   * Carries a session's harness into another — the new session Clear starts
   * (spec § 8). The old session keeps it as removed, so its records stay
   * readable there too; the new one gets the harness, its records and its log,
   * running again from the current step. Returns the kickoff for the caller to
   * deliver, and the step it begins.
   */
  carry(fromId: string, toId: string): Result<{ harness: SessionHarness; kickoff: string; index: number }> {
    const h = this.get(fromId);
    if (!h) return { ok: false, status: 404, error: 'no harness to carry' };
    if (this.get(toId)) return { ok: false, status: 409, error: 'the new session already has a harness' };
    const index = h.state.findIndex((s) => s.status !== 'done');
    if (index === -1) return { ok: false, status: 409, error: 'the harness is finished' };
    this.abortReview(fromId);
    const now = this.now();
    const { db } = this.deps;
    db.update(sessionHarnesses).set({ removedAt: now, updatedAt: now }).where(eq(sessionHarnesses.sessionId, fromId)).run();
    // Open steps start over in the new session: their message and start are the kickoff's.
    const state = h.state.map((s) => {
      if (s.status !== 'active' && !s.reviewing) return s;
      const { reviewing: _r, ...kept } = s;
      if (s.status !== 'active') return kept;
      const { startedAt: _s, startMessageUuid: _m, ...rest } = kept;
      return rest;
    });
    db.delete(sessionHarnesses).where(eq(sessionHarnesses.sessionId, toId)).run();
    const row = db
      .insert(sessionHarnesses)
      .values({
        sessionId: toId, templateId: h.templateId, name: h.name, steps: h.steps, inputs: h.inputs, state,
        options: h.options, createdAt: h.createdAt, updatedAt: now,
      })
      .returning()
      .get();
    const earlier = db
      .select()
      .from(harnessEvents)
      .where(and(eq(harnessEvents.sessionId, fromId), gte(harnessEvents.at, h.createdAt)))
      .orderBy(harnessEvents.id)
      .all();
    if (earlier.length) {
      db.insert(harnessEvents).values(earlier.map(({ id: _id, ...e }) => ({ ...e, sessionId: toId }))).run();
    }
    this.log(fromId, 'removed', { carriedTo: toId });
    this.log(toId, 'carried_over', { from: fromId, index, step: h.steps[index].id });
    const harness = toHarness(row);
    const template = h.templateId !== null ? this.getTemplate(h.templateId) : undefined;
    const inputs = template?.inputs ?? Object.keys(h.inputs).map((key) => ({ key, label: key }));
    this.tickedThisTurn.delete(fromId);
    this.deps.publish(fromId, null);
    this.deps.publish(toId, harness);
    return { ok: true, value: { harness, kickoff: kickoffMessage(harness, inputs), index } };
  }

  /** The step's changes, `startHead..endHead`, for the panel. */
  async diff(sessionId: string, index: number): Promise<Result<StepDiff>> {
    const h = this.get(sessionId) ?? this.removed(sessionId);
    const state = h?.state[index];
    if (!h || !state) return { ok: false, status: 404, error: 'no such step' };
    const cwd = this.deps.cwdOf(sessionId);
    if (!cwd || !state.startHead || !state.endHead) return { ok: false, status: 409, error: 'the step has no commit range' };
    const range = `${state.startHead}..${state.endHead}`;
    const [stat, patch, count, remotes] = await Promise.all([
      this.git(cwd, ['diff', '--stat', range]),
      this.git(cwd, ['diff', range]),
      this.git(cwd, ['rev-list', '--count', range]),
      this.git(cwd, ['branch', '-r', '--contains', state.endHead]),
    ]);
    if (!stat.ok || !patch.ok) return { ok: false, status: 409, error: (stat.ok ? patch : stat).output.trim() };
    const commits = count.ok ? Number(count.output.trim()) : null;
    // Any remote branch holding the step's last commit means it left the machine.
    const pushed = remotes.ok ? remotes.output.trim() !== '' : null;
    const text = patch.output.length > MAX_DIFF_CHARS ? `${patch.output.slice(0, MAX_DIFF_CHARS)}\n… (cut — run git diff ${range})` : patch.output;
    return { ok: true, value: { range, stat: stat.output.trim(), patch: text, commits: Number.isFinite(commits) ? commits : null, pushed } };
  }

  /** Text Orbital is about to deliver; this keeps it from reading as the user's. */
  noteSent(sessionId: string, text: string): void {
    const list = this.sentByUs.get(sessionId) ?? [];
    list.push(text.trim());
    this.sentByUs.set(sessionId, list.slice(-10));
  }

  /** Remembers which user entry a harness message became, so the transcript can tell it apart. */
  private recordMessage(sessionId: string, uuid: string, kind: HarnessMessageKind, step: number, text: string): void {
    const at = this.now();
    this.deps.db.insert(harnessMessages).values({ uuid, sessionId, kind, stepIndex: step, at }).onConflictDoNothing().run();
    this.deps.publishMessage?.(sessionId, { uuid, kind, step, text, at });
  }

  /**
   * Delivers a harness message through the routes' path, which revives a
   * sleeping session, and records it as Orbital's. The routes send the
   * kickoff and an approval's next step through here.
   */
  async say(sessionId: string, text: string, kind: HarnessMessageKind, step: number): Promise<Delivery> {
    if (!this.deliver) throw new Error('harness delivery is not set up');
    this.noteSent(sessionId, text);
    const delivery = await this.deliver(sessionId, text);
    if (delivery.uuid && (delivery.outcome === 'sent' || delivery.outcome === 'revived')) {
      this.recordMessage(sessionId, delivery.uuid, kind, step, text);
    }
    return delivery;
  }

  // ── The agent's tools ─────────────────────────────────────────────────

  async completeStep(sessionId: string, stepId: string, record: TickRecord): Promise<string> {
    const h = this.get(sessionId);
    if (!h) return 'This session has no harness.';
    const i = h.steps.findIndex((s) => s.id === stepId);
    // Only an open step is checked; `tick` says what is wrong with any other.
    const step = h.state[i]?.status === 'active' ? h.steps[i] : undefined;
    const cwd = this.deps.cwdOf(sessionId);
    if (h.options.commitPerStep && cwd && step) {
      // Outside a repository `git status` fails, and the option does nothing.
      const status = await this.git(cwd, ['status', '--porcelain']);
      if (status.ok && status.output.trim()) {
        return `Not ticked: the working tree has uncommitted changes. Commit this step's work locally (never push), then call ${TOOL_COMPLETE} again.\n\n${status.output.trim().slice(0, 2000)}`;
      }
    }
    let verified = false;
    if (step?.verify) {
      const result = cwd
        ? await (this.deps.runVerify ?? runShell)(cwd, step.verify)
        : { ok: false, output: 'Orbital does not know this session\'s directory.' };
      if (!result.ok) {
        this.logStep(h, i, 'verify_failed', { output: result.output.slice(-1000) });
        return `Not ticked: \`${step.verify}\` failed. Fix it and call ${TOOL_COMPLETE} again.\n\n${result.output}`;
      }
      verified = true;
    }
    // Read again: the verify may have run for minutes.
    const current = this.get(sessionId);
    if (!current) return 'This session has no harness any more.';
    const result = tick(current.steps, current.state, stepId, record, this.now());
    if (!result.ok) return `Not ticked: ${result.error}`;
    const endHead = await this.head(sessionId);
    const index = current.steps.findIndex((s) => s.id === stepId);
    // Ticks come one after another, so what was committed since the last one
    // is this step's: the other open steps' ranges start here (spec
    // 2026-10-06-harness-graph-and-proposals-design § Records and git).
    const state = endHead
      ? result.state.map((s, j) => (j === index ? { ...s, endHead } : s.status === 'active' && s.startedAt !== undefined ? { ...s, startHead: endHead } : s))
      : result.state;
    const saved = this.save({ ...current, state, idleNudges: 0 });
    this.tickedThisTurn.set(sessionId, this.lastAgentText.get(sessionId) ?? '');
    this.logStep(current, index, 'ticked', {
      summary: record.summary, verify: verified ? 'passed' : null, gate: current.steps[index].mode === 'gate',
      unlocked: result.unlocked.map((j) => current.steps[j].id),
    });
    if (result.outcome === 'finished') {
      this.log(sessionId, 'finished');
      return 'Ticked. Every step of the checklist is done — end with a short summary for the user.';
    }
    if (result.outcome === 'awaiting_approval') {
      const who = saved.options.lucky ? 'a reviewer looks at it' : 'the user reviews it';
      if (openIndexes(saved.state).length > 0) {
        return `Ticked. This step is a gate: ${who} before the steps that need it. Carry on with the open steps meanwhile.\n\n${statusText(saved)}`;
      }
      return saved.options.lucky
        ? 'Ticked. This step is a gate: a reviewer looks at it before the next step. End your turn with a short summary.'
        : 'Ticked. This step is a gate: the user reviews it before the next step. End your turn with a short summary of what they should look at.';
    }
    return `Ticked. Carry on with the next step now.\n\n${statusText(saved)}`;
  }

  /**
   * Whether a permission ask is something this harness itself asks for: a
   * step's verify command, or — with commit-per-step on — the step commit: `git add` and `git commit` alone, joined by `&&`
   * at most — never a push, an amend, or anything else in the same line. The
   * run would otherwise stop on a card nobody is there to answer.
   */
  allowsWithoutAsking(sessionId: string, toolName: string, input: Record<string, unknown>): boolean {
    if (toolName !== 'Bash' || typeof input.command !== 'string' || !this.deps.isEnabled()) return false;
    const h = this.get(sessionId);
    if (!h) return false;
    // A step's own verify command: the template's author declared it, and Orbital runs it at the tick anyway.
    const command = input.command.trim();
    if (h.steps.some((step) => step.verify && step.verify.trim() === command)) return true;
    return h.options.commitPerStep && isLocalCommit(command);
  }

  /** The tools the session's `orbital` MCP server carries while the feature is on. */
  tools(sessionId: string): SessionTools | undefined {
    if (!this.deps.isEnabled()) return undefined;
    return {
      instructions:
        'Orbital harness: when this session follows a checklist, tick each step with harness_complete_step as you finish it.',
      tools: [
        tool(TOOL_STATUS, 'The Orbital harness checklist of this session and the open steps\' instructions.', {}, () => {
          const h = this.get(sessionId);
          return Promise.resolve({ content: [{ type: 'text' as const, text: h ? statusText(h) : 'This session has no harness.' }] });
        }, { alwaysLoad: true }),
        tool(
          TOOL_COMPLETE,
          'Tick an open step of this session\'s Orbital harness checklist once its done-criteria hold. Runs the step\'s verify command first when it has one.',
          {
            step_id: z.string().describe('The id of the open step that is done.'),
            summary: z.string().describe('What was done in this step and where it is.'),
            decisions: z
              .array(z.object({
                what: z.string().describe('The choice made.'),
                why: z.string().describe('The reason for it.'),
                alternatives: z.string().optional().describe('What else was considered, and why not.'),
              }))
              .describe('The choices made in this step; the user reads these later to judge the work.'),
            open_questions: z.array(z.string()).describe('What the user should still look at; empty if nothing.'),
          },
          async ({ step_id, summary, decisions, open_questions }) => ({
            content: [{
              type: 'text',
              text: await this.completeStep(sessionId, step_id, { summary, decisions, openQuestions: open_questions }),
            }],
          }),
          // Deferred behind ToolSearch, the agent had to go looking for it first.
          { alwaysLoad: true },
        ),
        // Left deferred: only a session asked to write a template needs it,
        // and the interview prompt names it.
        tool(
          TOOL_SAVE_TEMPLATE,
          'Save an Orbital harness template (a reusable checklist) as a draft, which the user opens and saves in Settings → Harness templates. Saving again from this session updates the same draft. Answers with the problem when the template is not valid.',
          {
            name: z.string(),
            description: z.string(),
            tags: z.array(z.string()),
            inputs: z.array(z.object({ key: z.string(), label: z.string(), hint: z.string().optional() })),
            steps: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                instructions: z.string(),
                mode: z.enum(['auto', 'gate']),
                doneWhen: z.string(),
                verify: z.string().optional(),
                dependsOn: z.array(z.string()).optional(),
              }),
            ),
          },
          (template) => {
            const result = this.saveDraftFrom(sessionId, { ...template, options: {} });
            const where = result.ok && result.value.scope.kind === 'project' ? `the project ${result.value.scope.name}` : 'every project';
            const text = result.ok
              ? `Saved as draft template #${result.value.id} "${result.value.name}" for ${where}. The user opens it in Settings → Harness templates and saves it there; until then it is not offered to sessions.`
              : `Not saved: ${result.error}. Fix it and call ${TOOL_SAVE_TEMPLATE} again.`;
            return Promise.resolve({ content: [{ type: 'text' as const, text }] });
          },
        ),
        tool(
          TOOL_PROPOSE,
          'Propose an Orbital harness for this session — a checklist worked out with the user, without a template — or a change to the harness it runs. The user applies, edits or discards it in Orbital; nothing runs until they apply it. A newer proposal replaces one they have not decided yet. Answers with the problem when it is not valid.',
          {
            harness: z.object({
              name: z.string(),
              steps: z.array(STEP_SCHEMA),
            }).optional().describe('A whole harness, when the session has none.'),
            changes: z.object({
              add: z.array(STEP_SCHEMA).optional().describe('New steps, appended in this order.'),
              update: z.array(STEP_SCHEMA).optional().describe('Open or pending steps, by id, replaced whole.'),
              remove: z.array(z.string()).optional().describe('Ids of open or pending steps to drop.'),
            }).optional().describe('A change to the running harness.'),
            note: z.string().optional().describe('One or two sentences for the user: why.'),
          },
          ({ harness, changes, note }) => {
            const result = this.propose(sessionId, harness ? { kind: 'harness', harness } : changes ? { kind: 'changes', changes } : null, note ?? null);
            const text = result.ok
              ? 'Proposed. The user applies, edits or discards it in Orbital. Tell them in a sentence what you proposed; do not start on it before it is applied.'
              : `Not proposed: ${result.error}. Fix it and call ${TOOL_PROPOSE} again.`;
            return Promise.resolve({ content: [{ type: 'text' as const, text }] });
          },
          { alwaysLoad: true },
        ),
      ],
      allowedTools: [TOOL_STATUS, TOOL_COMPLETE, TOOL_SAVE_TEMPLATE, TOOL_PROPOSE].map((name) => `mcp__${HARNESS_MCP_SERVER}__${name}`),
    };
  }

  // ── The session's stream ──────────────────────────────────────────────

  /** What the session said: the agent's newest prose, and whether the user typed. */
  feed(sessionId: string, messages: ChatMessage[]): void {
    for (const message of messages) {
      const text = message.text?.trim();
      if (!text) continue;
      if (message.role === 'assistant') this.lastAgentText.set(sessionId, text);
      if (message.role === 'user') {
        const ours = this.sentByUs.get(sessionId) ?? [];
        const at = ours.indexOf(text);
        if (at !== -1) {
          ours.splice(at, 1);
          continue;
        }
        // The user said something themselves: the nudge count starts over.
        const h = this.get(sessionId);
        if (h && h.idleNudges > 0) this.save({ ...h, idleNudges: 0 });
      }
    }
  }

  forget(sessionId: string): void {
    this.tickedThisTurn.delete(sessionId);
    this.lastAgentText.delete(sessionId);
    this.sentByUs.delete(sessionId);
  }

  /** Called when a turn of any Orbital-run session ends. */
  onTurnEnd(sessionId: string): void {
    const defer = this.deps.defer ?? ((fn) => setImmediate(fn));
    defer(() => {
      if (this.disposed) return;
      void this.handleTurnEnd(sessionId).catch((err) => this.report(sessionId, err, 'ending a harness turn'));
    });
  }

  /**
   * Called as the server closes, before the database does. A turn that ended
   * just before is still queued, and a review may be mid-call; neither may
   * touch the closed database, and neither may report a failure into it.
   */
  dispose(): void {
    this.disposed = true;
    for (const controller of this.reviews.values()) controller.abort();
    this.reviews.clear();
  }

  private report(sessionId: string, err: unknown, during: string): void {
    if (!this.disposed) this.deps.onError?.(sessionId, err, during);
  }

  /**
   * Sends on the harness's own account; the user message's uuid, or null when
   * nothing was sent. Right after a turn the Runner holds the session; after a
   * review that took minutes it may be asleep, and only the routes' delivery
   * can revive it.
   */
  private async sendOnOwn(
    h: SessionHarness, text: string, what: { kind: HarnessMessageKind; step: number }, opts: { revive?: boolean } = {},
  ): Promise<string | null> {
    // The user got there first — a turn is running again.
    if (!opts.revive && !this.deps.isWaiting(h.sessionId)) return null;
    try {
      if (opts.revive && this.deliver) {
        const delivery = await this.say(h.sessionId, text, what.kind, what.step);
        if (delivery.outcome === 'sent' || delivery.outcome === 'revived') return delivery.uuid;
        throw new Error(`delivery ended as ${delivery.outcome}`);
      }
      this.noteSent(h.sessionId, text);
      const uuid = this.deps.send(h.sessionId, text);
      if (uuid) this.recordMessage(h.sessionId, uuid, what.kind, what.step, text);
      return uuid;
    } catch (err) {
      this.report(h.sessionId, err, 'sending the next harness step');
      const current = this.get(h.sessionId);
      if (current) this.pause(current, 'send_failed', 'Orbital could not send the next message into the session.');
      return null;
    }
  }

  /** Sends the agent on to the open steps and records the message that began those new to it. */
  private async advanceTo(h: SessionHarness, opts: { revive?: boolean } = {}): Promise<void> {
    const open = openIndexes(h.state);
    if (open.length === 0) return;
    const step = open.find((i) => h.state[i].startedAt === undefined) ?? open[0];
    const uuid = await this.sendOnOwn(h, advanceMessage(h), { kind: 'advance', step }, opts);
    if (uuid !== null || opts.revive) await this.openStepsStarted(h.sessionId, uuid);
  }

  /** The reviewer's model: the harness's choice, else the session's, else the fallback. */
  private reviewerModel(h: SessionHarness): string {
    return h.options.reviewerModel ?? this.deps.modelOf?.(h.sessionId) ?? FALLBACK_REVIEWER_MODEL;
  }

  /**
   * Feeling lucky: a reviewer decides the gate at `index` (spec 2026-09-30-
   * harness-lucky-and-step-records-design § Feeling lucky). Runs for minutes;
   * whatever the user did meanwhile wins, and "Decide myself" stops it. While
   * paused it still decides, but nothing is sent on (spec 2026-10-02 § 5).
   */
  async review(sessionId: string, index: number): Promise<void> {
    if (this.reviews.has(sessionId)) return;
    const h = this.get(sessionId);
    const cwd = this.deps.cwdOf(sessionId);
    if (!h || !cwd || !reviewerTakes(h, index)) return;
    const controller = new AbortController();
    this.reviews.set(sessionId, controller);
    try {
      this.logStep(h, index, 'review_started', { model: this.reviewerModel(h) });
      const started = this.save({ ...h, state: patchStep(h.state, index, { reviewing: true }) });
      const state = started.state[index];
      const diff = state.startHead && state.endHead
        ? await this.git(cwd, ['diff', `${state.startHead}..${state.endHead}`])
        : null;
      let parsed;
      try {
        const reply = await this.deps.askReviewer(
          buildReviewPrompt({
            harnessName: h.name, checklist: checklistLines(h.steps, h.state), index,
            step: h.steps[index], state, diff: diff?.ok ? diff.output : null,
          }),
          cwd,
          { model: this.reviewerModel(h), abortController: controller },
        );
        parsed = parseReviewReply(reply);
      } catch (err) {
        if (controller.signal.aborted || this.disposed) return;
        this.report(sessionId, err, 'running the harness reviewer');
        parsed = { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
      // Stopped meanwhile — by the user, by lucky going off, by a removal: theirs is the last word.
      if (controller.signal.aborted || this.disposed) return;
      const current = this.get(sessionId);
      if (!current || current.state[index]?.status !== 'awaiting_approval' || !current.state[index].reviewing) return;
      const cleared = stripReviewing(current.state, index);
      if (!current.options.lucky) {
        this.save({ ...current, state: cleared });
        return;
      }
      if (!parsed.ok) {
        // A review that says nothing leaves the gate to the user.
        this.logStep(current, index, 'review_failed', { reason: parsed.error });
        this.pause(
          { ...current, state: patchStep(cleared, index, { reviewerOff: true }) },
          'review_failed', `The reviewer could not decide "${h.steps[index].title}": ${parsed.error}`,
        );
        return;
      }
      const review: StepReview = { ...parsed.review, at: this.now() };
      const reviewed = withReview(cleared, index, review);
      this.logStep(current, index, 'reviewed', {
        verdict: review.verdict, uncertain: review.uncertain, reason: review.reasoning,
      });
      if (review.verdict === 'approve') {
        const approved = approve(current.steps, reviewed, index, 'reviewer')!;
        this.logStep(current, index, 'approved', { by: 'reviewer' });
        const saved = this.save({ ...current, state: approved, idleNudges: 0 });
        const opened = openIndexes(approved).some((i) => current.state[i].status !== 'active');
        if (isFinished(approved)) this.log(sessionId, 'finished');
        // Paused: the next steps are active but not sent; resuming sends them.
        else if (opened && !saved.paused && this.deps.isEnabled()) await this.advanceTo(saved, { revive: true });
        return;
      }
      const reopened = reviewerReopen(reviewed, index)!;
      if (current.paused) {
        // Nothing moves on while paused: the findings go out when auto-continue is back on.
        this.save({ ...current, state: patchStep(reopened, index, { unsentFindings: true }), idleNudges: 0 });
        return;
      }
      const saved = this.save({ ...current, state: reopened, idleNudges: 0 });
      if (!this.deps.isEnabled()) return;
      await this.sendOnOwn(saved, reviewerReopenMessage(saved, index, review), { kind: 'findings', step: index }, { revive: true });
    } finally {
      if (this.reviews.get(sessionId) === controller) this.reviews.delete(sessionId);
    }
  }

  async handleTurnEnd(sessionId: string): Promise<void> {
    if (!this.deps.isEnabled()) return;
    const h = this.get(sessionId);
    if (!h) return;
    const ticked = this.tickedThisTurn.has(sessionId);
    const textAtTick = this.tickedThisTurn.get(sessionId);
    this.tickedThisTurn.delete(sessionId);
    const decision = decideTurnEnd(h, {
      decisionPending: this.deps.decisionPending(sessionId),
      backgroundWork: this.deps.backgroundWork(sessionId),
      tickedThisTurn: ticked,
      spokeAfterTick: ticked && (this.lastAgentText.get(sessionId) ?? '') !== textAtTick,
    });
    if (decision.kind === 'wait') return;
    if (decision.kind === 'review') {
      await this.review(sessionId, decision.index);
      return;
    }
    // The agent goes on with the open steps; a gate waiting meanwhile is reviewed alongside.
    this.reviewIfWaiting(h);
    if (decision.kind === 'pause') {
      this.log(sessionId, 'paused', { by: 'harness', kind: decision.pauseKind, reason: decision.reason });
      this.pause(h, decision.pauseKind, decision.reason);
      return;
    }
    if (decision.kind === 'advance') {
      const saved = this.save({ ...h, autoRounds: h.autoRounds + 1 });
      this.logStep(h, decision.index, 'advanced');
      await this.advanceTo(saved);
      return;
    }

    const lastText = this.lastAgentText.get(sessionId) ?? '';
    let verdict;
    try {
      const reply = await this.deps.askWatcher(
        buildWatcherPrompt(h.name, checklistLines(h.steps, h.state), openIndexes(h.state).map((i) => h.steps[i]), lastText),
      );
      verdict = parseWatcherReply(reply);
    } catch (err) {
      this.report(sessionId, err, 'asking the harness watcher');
      verdict = { continue: false as const, reason: 'The watcher could not be asked.' };
    }
    // The user may have typed, paused or removed the harness while the watcher thought.
    const current = this.get(sessionId);
    if (!current || current.paused || this.tickedThisTurn.has(sessionId)) return;
    if (!verdict.continue) {
      this.logStep(h, decision.index, 'watcher_stop', { reason: verdict.reason, agent: lastText.slice(-1500) });
      return;
    }
    if (decision.afterTick) {
      // Progress was made: an advance, not a nudge, so the nudge cap stays put.
      const saved = this.save({ ...current, autoRounds: current.autoRounds + 1 });
      this.logStep(h, decision.index, 'advanced', { agent: lastText.slice(-1500) });
      await this.advanceTo(saved);
      return;
    }
    const nudges = (current.state[decision.index].nudges ?? 0) + 1;
    const saved = this.save({
      ...current,
      state: patchStep(current.state, decision.index, { nudges }),
      autoRounds: current.autoRounds + 1,
      idleNudges: current.idleNudges + 1,
    });
    this.logStep(h, decision.index, 'nudged', {
      agent: lastText.slice(-1500), n: saved.idleNudges, of: saved.options.maxIdleNudges,
    });
    await this.sendOnOwn(saved, nudgeMessage(saved), { kind: 'nudge', step: decision.index });
  }
}
