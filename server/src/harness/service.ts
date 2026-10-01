/**
 * Harness templates and the checklists they become in sessions (spec
 * 2026-09-30-session-harness-design). Owns the three harness tables, the
 * agent's checklist tools, and what happens when a harnessed session's turn
 * ends. The decisions themselves are in `logic.ts`; this file is the glue to
 * the database, the Runner and the model.
 */

import { execFile, spawn } from 'node:child_process';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { OrbitalDb } from '../db/database.js';
import { harnessEvents, harnessTemplates, sessionHarnesses } from '../db/schema.js';
import type { SessionTools } from '../runner/runner.js';
import { ORBITAL_MCP_SERVER as HARNESS_MCP_SERVER } from '../runner/spawnTool.js';
import type { ChatMessage } from '../types.js';
import {
  activeIndex, advanceMessage, approve, checklistLines, decideTurnEnd, initialState, kickoffMessage,
  normalizeOptions, nudgeMessage, patchStep, reopen, reviewerReopen, reviewerReopenMessage, snapshotSteps,
  statusText, tick, validateTemplate, withReview, type TickRecord,
} from './logic.js';
import type {
  HarnessEvent, HarnessEventKind, HarnessInput, HarnessOptions, HarnessStep, HarnessTemplate, SessionHarness,
  StepReview,
} from './types.js';
import { buildReviewPrompt, parseReviewReply } from './reviewer.js';
import { buildWatcherPrompt, parseWatcherReply } from './watcher.js';
import { TEMPLATE_GUIDE, buildDraftPrompt, digestTranscript, draftTemplate, type ParsedDraft } from './drafter.js';

const TOOL_STATUS = 'harness_status';
const TOOL_COMPLETE = 'harness_complete_step';
const TOOL_SAVE_TEMPLATE = 'harness_save_template';

/**
 * The first prompt of a "Draft in a conversation" session (spec
 * 2026-09-30-assisted-harness-templates-design § Path 3).
 */
export const INTERVIEW_PROMPT = `Help me write an Orbital harness template: a checklist for one kind of work that I repeat, which an agent then follows step by step.

Interview me first, one question at a time: what the work is, what I give at the start (links, tickets, names), the phases it goes through in order, where I want to look and decide before it goes on, and how each phase is known to be done. Keep it short; stop asking once you can draft it.

Then show me the checklist as a numbered list (each step: title, auto or gate, done when). When I agree, save it with the \`mcp__orbital__${TOOL_SAVE_TEMPLATE}\` tool. If the tool reports a problem, fix it and save again. Do not change any files.

${TEMPLATE_GUIDE}`;

/** A verify command that runs longer than this fails the tick. */
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
/** What of a failing verify's output goes back to the agent, from the end. */
const VERIFY_OUTPUT_CHARS = 4000;

export interface VerifyResult {
  ok: boolean;
  output: string;
}

/** How the routes deliver into a session — reviving it when it sleeps. Handed over at registration. */
export type Deliver = (sessionId: string, text: string) => Promise<{ outcome: string; uuid: string | null }>;

/** A step's patch is capped for the panel; `git` itself has the rest. */
const MAX_DIFF_CHARS = 200_000;

export interface HarnessDeps {
  db: OrbitalDb;
  /** The `harness_enabled` setting, read at the point of use. */
  isEnabled(): boolean;
  /** The session's working directory, for verify commands. */
  cwdOf(sessionId: string): string | undefined;
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
  /** The template drafter's one-shot model call; returns the raw reply. */
  askDrafter(prompt: string): Promise<string>;
  /** The lucky reviewer: a read-only agent in the session's directory; returns its final text. */
  askReviewer(prompt: string, cwd: string): Promise<string>;
  /** `git <args>` in a directory. Tests replace it. */
  git?(cwd: string, args: string[]): Promise<VerifyResult>;
  /** Pushes the session's harness (or its removal) to the panel. */
  publish(sessionId: string, harness: SessionHarness | null): void;
  onError?(sessionId: string, err: unknown, during: string): void;
  runVerify?(cwd: string, command: string): Promise<VerifyResult>;
  now?(): number;
  /** Deferral for the turn-end work, so the Runner's frame handling finishes first. Tests pass a sync one. */
  defer?: (fn: () => void) => void;
}

type TemplateBody = Pick<HarnessTemplate, 'name' | 'description' | 'tags' | 'inputs' | 'steps' | 'options'>;

function runGit(cwd: string, args: string[]): Promise<VerifyResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: err ? String(stderr || err.message) : String(stdout) }),
    );
  });
}

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function runShell(cwd: string, command: string): Promise<VerifyResult> {
  return new Promise((resolve) => {
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
      resolve({ ok: false, output: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() });
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

function toHarness(row: typeof sessionHarnesses.$inferSelect): SessionHarness {
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
    autoRounds: row.autoRounds,
    idleNudges: row.idleNudges,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toTemplate(row: typeof harnessTemplates.$inferSelect): HarnessTemplate {
  return { ...row, options: normalizeOptions(row.options) };
}

function cleanBody(body: Partial<TemplateBody>): TemplateBody {
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
    })),
  };
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
  /** Sessions whose gate a reviewer is looking at right now. */
  private reviewing = new Set<string>();
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

  listTemplates(): HarnessTemplate[] {
    return this.deps.db.select().from(harnessTemplates).orderBy(harnessTemplates.name).all().map(toTemplate);
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
      .values({ ...cleanBody(body), createdAt: now, updatedAt: now })
      .returning()
      .get();
    return { ok: true, value: toTemplate(row) };
  }

  updateTemplate(id: number, body: Partial<TemplateBody>): Result<HarnessTemplate> {
    if (!this.getTemplate(id)) return { ok: false, status: 404, error: 'not found' };
    const error = validateTemplate(body);
    if (error) return { ok: false, status: 400, error };
    const row = this.deps.db
      .update(harnessTemplates)
      .set({ ...cleanBody(body), updatedAt: this.now() })
      .where(eq(harnessTemplates.id, id))
      .returning()
      .get();
    return { ok: true, value: toTemplate(row) };
  }

  /**
   * A model's draft of a template, not saved (spec 2026-09-30-assisted-
   * harness-templates-design § The drafter). Throws when the call fails.
   */
  async draft(input: { description?: string; messages?: ChatMessage[] }): Promise<ParsedDraft> {
    const prompt = buildDraftPrompt({
      description: input.description,
      digest: input.messages?.length ? digestTranscript(input.messages) : undefined,
      existing: this.listTemplates().map((t) => t.name),
    });
    return draftTemplate((p) => this.deps.askDrafter(p), prompt);
  }

  /** Sessions running it keep their snapshot. */
  deleteTemplate(id: number): void {
    this.deps.db.delete(harnessTemplates).where(eq(harnessTemplates.id, id)).run();
  }

  // ── A session's harness ───────────────────────────────────────────────

  get(sessionId: string): SessionHarness | null {
    const row = this.deps.db.select().from(sessionHarnesses).where(eq(sessionHarnesses.sessionId, sessionId)).get();
    return row ? toHarness(row) : null;
  }

  events(sessionId: string, limit = 50): HarnessEvent[] {
    return this.deps.db
      .select()
      .from(harnessEvents)
      .where(eq(harnessEvents.sessionId, sessionId))
      .orderBy(desc(harnessEvents.at), desc(harnessEvents.id))
      .limit(limit)
      .all();
  }

  private log(sessionId: string, kind: HarnessEventKind, detail: Record<string, unknown> = {}): void {
    this.deps.db.insert(harnessEvents).values({ sessionId, at: this.now(), kind, detail }).run();
  }

  private save(h: SessionHarness): SessionHarness {
    const updated = { ...h, updatedAt: this.now() };
    this.deps.db
      .update(sessionHarnesses)
      .set({
        state: updated.state,
        options: updated.options,
        paused: updated.paused ? 1 : 0,
        pauseReason: updated.pauseReason,
        autoRounds: updated.autoRounds,
        idleNudges: updated.idleNudges,
        updatedAt: updated.updatedAt,
      })
      .where(eq(sessionHarnesses.sessionId, h.sessionId))
      .run();
    this.deps.publish(h.sessionId, updated);
    return updated;
  }

  /**
   * Puts a template into a session. Returns the kickoff message; the caller
   * delivers it, because only the routes can revive a sleeping session.
   */
  attach(sessionId: string, templateId: number, inputs: Record<string, string>): Result<{ harness: SessionHarness; kickoff: string }> {
    if (this.get(sessionId)) return { ok: false, status: 409, error: 'this session already has a harness' };
    const template = this.getTemplate(templateId);
    if (!template) return { ok: false, status: 404, error: 'template not found' };
    const values: Record<string, string> = {};
    for (const input of template.inputs) values[input.key] = (inputs[input.key] ?? '').trim();
    const steps = snapshotSteps(template.steps, values);
    const now = this.now();
    const row = this.deps.db
      .insert(sessionHarnesses)
      .values({
        sessionId, templateId, name: template.name, steps, inputs: values,
        state: initialState(steps), options: template.options, createdAt: now, updatedAt: now,
      })
      .returning()
      .get();
    const harness = toHarness(row);
    this.log(sessionId, 'attached', { templateId, name: template.name });
    this.deps.publish(sessionId, harness);
    const kickoff = kickoffMessage(harness, template.inputs);
    return { ok: true, value: { harness, kickoff } };
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

  remove(sessionId: string): void {
    this.deps.db.delete(sessionHarnesses).where(eq(sessionHarnesses.sessionId, sessionId)).run();
    this.tickedThisTurn.delete(sessionId);
    this.deps.publish(sessionId, null);
  }

  /**
   * The user approves a gate. Returns the next step's instructions for the
   * caller to deliver, or null when the approved step was the last.
   */
  approve(sessionId: string, index: number): Result<{ harness: SessionHarness; message: string | null }> {
    const h = this.get(sessionId);
    if (!h) return { ok: false, status: 404, error: 'no harness' };
    const state = approve(h.state, index);
    if (!state) return { ok: false, status: 409, error: 'that step does not wait for approval' };
    const saved = this.save({ ...h, state, idleNudges: 0 });
    this.log(sessionId, 'approved', { step: h.steps[index].id });
    const next = activeIndex(state);
    if (next === -1) {
      this.log(sessionId, 'finished');
      return { ok: true, value: { harness: saved, message: null } };
    }
    return { ok: true, value: { harness: saved, message: advanceMessage(saved, next) } };
  }

  reopen(sessionId: string, index: number): Result<SessionHarness> {
    const h = this.get(sessionId);
    if (!h) return { ok: false, status: 404, error: 'no harness' };
    const state = reopen(h.state, index);
    if (!state) return { ok: false, status: 409, error: 'that step is not done' };
    this.log(sessionId, 'reopened', { step: h.steps[index].id });
    return { ok: true, value: this.save({ ...h, state, idleNudges: 0 }) };
  }

  setPaused(sessionId: string, paused: boolean): Result<SessionHarness> {
    const h = this.get(sessionId);
    if (!h) return { ok: false, status: 404, error: 'no harness' };
    this.log(sessionId, paused ? 'paused' : 'resumed', { by: 'user' });
    // Resuming is the user looking at it: the caps start over.
    const reset = paused ? {} : { autoRounds: 0, idleNudges: 0 };
    const saved = this.save({ ...h, paused, pauseReason: null, ...reset });
    if (!paused) this.reviewIfWaiting(saved);
    return { ok: true, value: saved };
  }

  /** The session's options, changed from the panel. Turning lucky on reviews a gate already waiting. */
  setOptions(sessionId: string, patch: Partial<HarnessOptions>): Result<SessionHarness> {
    const h = this.get(sessionId);
    if (!h) return { ok: false, status: 404, error: 'no harness' };
    const options = normalizeOptions({ ...h.options, ...patch });
    this.log(sessionId, 'options', { ...patch });
    const saved = this.save({ ...h, options });
    this.reviewIfWaiting(saved);
    return { ok: true, value: saved };
  }

  private reviewIfWaiting(h: SessionHarness): void {
    const i = activeIndex(h.state);
    if (!h.paused && h.options.lucky && i !== -1 && h.state[i].status === 'awaiting_approval') {
      void this.review(h.sessionId, i).catch((err) => this.report(h.sessionId, err, 'reviewing a harness gate'));
    }
  }

  /** The step's changes, `startHead..endHead`, for the panel. */
  async diff(sessionId: string, index: number): Promise<Result<{ range: string; stat: string; patch: string }>> {
    const h = this.get(sessionId);
    const state = h?.state[index];
    if (!h || !state) return { ok: false, status: 404, error: 'no such step' };
    const cwd = this.deps.cwdOf(sessionId);
    if (!cwd || !state.startHead || !state.endHead) return { ok: false, status: 409, error: 'the step has no commit range' };
    const range = `${state.startHead}..${state.endHead}`;
    const [stat, patch] = await Promise.all([this.git(cwd, ['diff', '--stat', range]), this.git(cwd, ['diff', range])]);
    if (!stat.ok || !patch.ok) return { ok: false, status: 409, error: (stat.ok ? patch : stat).output.trim() };
    const text = patch.output.length > MAX_DIFF_CHARS ? `${patch.output.slice(0, MAX_DIFF_CHARS)}\n… (cut — run git diff ${range})` : patch.output;
    return { ok: true, value: { range, stat: stat.output.trim(), patch: text } };
  }

  /** The routes deliver kickoff and approval text; this keeps it from reading as the user's. */
  noteSent(sessionId: string, text: string): void {
    const list = this.sentByUs.get(sessionId) ?? [];
    list.push(text.trim());
    this.sentByUs.set(sessionId, list.slice(-10));
  }

  // ── The agent's tools ─────────────────────────────────────────────────

  async completeStep(sessionId: string, stepId: string, record: TickRecord): Promise<string> {
    const h = this.get(sessionId);
    if (!h) return 'This session has no harness.';
    const i = activeIndex(h.state);
    const step = i === -1 ? undefined : h.steps[i];
    const cwd = this.deps.cwdOf(sessionId);
    if (h.options.commitPerStep && cwd && step?.id === stepId) {
      // Outside a repository `git status` fails, and the option does nothing.
      const status = await this.git(cwd, ['status', '--porcelain']);
      if (status.ok && status.output.trim()) {
        return `Not ticked: the working tree has uncommitted changes. Commit this step's work locally (never push), then call ${TOOL_COMPLETE} again.\n\n${status.output.trim().slice(0, 2000)}`;
      }
    }
    if (step?.verify && step.id === stepId && h.state[i].status === 'active') {
      const result = cwd
        ? await (this.deps.runVerify ?? runShell)(cwd, step.verify)
        : { ok: false, output: 'Orbital does not know this session\'s directory.' };
      if (!result.ok) {
        this.log(sessionId, 'verify_failed', { step: step.id, output: result.output.slice(-1000) });
        return `Not ticked: \`${step.verify}\` failed. Fix it and call ${TOOL_COMPLETE} again.\n\n${result.output}`;
      }
    }
    // Read again: the verify may have run for minutes.
    const current = this.get(sessionId);
    if (!current) return 'This session has no harness any more.';
    const result = tick(current.steps, current.state, stepId, record, this.now());
    if (!result.ok) return `Not ticked: ${result.error}`;
    const endHead = await this.head(sessionId);
    const index = current.steps.findIndex((s) => s.id === stepId);
    const state = endHead ? patchStep(result.state, index, { endHead }) : result.state;
    const saved = this.save({ ...current, state, idleNudges: 0 });
    this.tickedThisTurn.set(sessionId, this.lastAgentText.get(sessionId) ?? '');
    this.log(sessionId, 'ticked', { step: stepId, summary: record.summary });
    if (result.outcome === 'finished') {
      this.log(sessionId, 'finished');
      return 'Ticked. Every step of the checklist is done — end with a short summary for the user.';
    }
    if (result.outcome === 'awaiting_approval') {
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
        tool(TOOL_STATUS, 'The Orbital harness checklist of this session and the active step\'s instructions.', {}, () => {
          const h = this.get(sessionId);
          return Promise.resolve({ content: [{ type: 'text' as const, text: h ? statusText(h) : 'This session has no harness.' }] });
        }, { alwaysLoad: true }),
        tool(
          TOOL_COMPLETE,
          'Tick the active step of this session\'s Orbital harness checklist once its done-criteria hold. Runs the step\'s verify command first when it has one.',
          {
            step_id: z.string().describe('The id of the active step.'),
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
          'Save a new Orbital harness template (a reusable checklist). Answers with the problem when the template is not valid.',
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
              }),
            ),
          },
          (template) => {
            const result = this.createTemplate(template);
            const text = result.ok
              ? `Saved as template #${result.value.id} "${result.value.name}". The user finds it in Settings → Harness templates and in every session's Harness panel.`
              : `Not saved: ${result.error}. Fix it and call ${TOOL_SAVE_TEMPLATE} again.`;
            return Promise.resolve({ content: [{ type: 'text' as const, text }] });
          },
        ),
      ],
      allowedTools: [TOOL_STATUS, TOOL_COMPLETE, TOOL_SAVE_TEMPLATE].map((name) => `mcp__${HARNESS_MCP_SERVER}__${name}`),
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
  private async sendOnOwn(h: SessionHarness, text: string, opts: { revive?: boolean } = {}): Promise<string | null> {
    // The user got there first — a turn is running again.
    if (!opts.revive && !this.deps.isWaiting(h.sessionId)) return null;
    try {
      this.noteSent(h.sessionId, text);
      if (opts.revive && this.deliver) {
        const delivery = await this.deliver(h.sessionId, text);
        if (delivery.outcome === 'sent' || delivery.outcome === 'revived') return delivery.uuid;
        throw new Error(`delivery ended as ${delivery.outcome}`);
      }
      return this.deps.send(h.sessionId, text);
    } catch (err) {
      this.report(h.sessionId, err, 'sending the next harness step');
      this.save({ ...h, paused: true, pauseReason: 'Orbital could not send the next message into the session.' });
      return null;
    }
  }

  /** Sends the next step's instructions and records the message that began it. */
  private async advanceTo(h: SessionHarness, index: number, opts: { revive?: boolean } = {}): Promise<void> {
    const uuid = await this.sendOnOwn(h, advanceMessage(h, index), opts);
    if (uuid !== null || opts.revive) await this.stepStarted(h.sessionId, index, uuid);
  }

  /**
   * Feeling lucky: a reviewer decides the gate at `index` (spec 2026-09-30-
   * harness-lucky-and-step-records-design § Feeling lucky). Runs for minutes;
   * whatever the user did meanwhile wins.
   */
  async review(sessionId: string, index: number): Promise<void> {
    if (this.reviewing.has(sessionId)) return;
    const h = this.get(sessionId);
    const cwd = this.deps.cwdOf(sessionId);
    if (!h || !cwd || h.state[index]?.status !== 'awaiting_approval') return;
    this.reviewing.add(sessionId);
    try {
      this.log(sessionId, 'review_started', { step: h.steps[index].id });
      const state = h.state[index];
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
        );
        parsed = parseReviewReply(reply);
      } catch (err) {
        this.report(sessionId, err, 'running the harness reviewer');
        parsed = { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
      const current = this.get(sessionId);
      if (!current || current.paused || !current.options.lucky || current.state[index]?.status !== 'awaiting_approval') return;
      if (!parsed.ok) {
        // A review that says nothing leaves the gate to the user.
        this.log(sessionId, 'review_failed', { step: h.steps[index].id, reason: parsed.error });
        this.save({ ...current, paused: true, pauseReason: `The reviewer could not decide "${h.steps[index].title}": ${parsed.error}` });
        return;
      }
      const review: StepReview = { ...parsed.review, at: this.now() };
      const reviewed = withReview(current.state, index, review);
      this.log(sessionId, 'reviewed', {
        step: h.steps[index].id, verdict: review.verdict, uncertain: review.uncertain, reason: review.reasoning,
      });
      if (review.verdict === 'approve') {
        const approved = approve(reviewed, index, 'reviewer')!;
        const saved = this.save({ ...current, state: approved, idleNudges: 0 });
        const next = activeIndex(approved);
        if (next === -1) this.log(sessionId, 'finished');
        else await this.advanceTo(saved, next, { revive: true });
        return;
      }
      const reopened = reviewerReopen(reviewed, index)!;
      const saved = this.save({ ...current, state: reopened, idleNudges: 0 });
      if ((reopened[index].reviewerReopens ?? 0) > saved.options.maxReviewerReopens) return;
      await this.sendOnOwn(saved, reviewerReopenMessage(saved, index, review), { revive: true });
    } finally {
      this.reviewing.delete(sessionId);
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
    if (decision.kind === 'pause') {
      this.log(sessionId, 'paused', { by: 'harness', reason: decision.reason });
      this.save({ ...h, paused: true, pauseReason: decision.reason });
      return;
    }
    if (decision.kind === 'advance') {
      const saved = this.save({ ...h, autoRounds: h.autoRounds + 1 });
      this.log(sessionId, 'advanced', { step: h.steps[decision.index].id });
      await this.advanceTo(saved, decision.index);
      return;
    }

    const step = h.steps[decision.index];
    const lastText = this.lastAgentText.get(sessionId) ?? '';
    let verdict;
    try {
      const reply = await this.deps.askWatcher(
        buildWatcherPrompt(h.name, checklistLines(h.steps, h.state), step, lastText),
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
      this.log(sessionId, 'watcher_stop', { step: step.id, reason: verdict.reason, agent: lastText.slice(-1500) });
      return;
    }
    if (decision.afterTick) {
      // Progress was made: an advance, not a nudge, so the nudge cap stays put.
      const saved = this.save({ ...current, autoRounds: current.autoRounds + 1 });
      this.log(sessionId, 'advanced', { step: step.id, agent: lastText.slice(-1500) });
      await this.advanceTo(saved, decision.index);
      return;
    }
    const saved = this.save({
      ...current,
      state: patchStep(current.state, decision.index, { nudges: (current.state[decision.index].nudges ?? 0) + 1 }),
      autoRounds: current.autoRounds + 1,
      idleNudges: current.idleNudges + 1,
    });
    this.log(sessionId, 'nudged', { step: step.id, agent: lastText.slice(-1500) });
    await this.sendOnOwn(saved, nudgeMessage(saved, decision.index));
  }
}
