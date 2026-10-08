/**
 * The narrate query and the row it writes (spec
 * 2026-09-30-narrate-out-of-band-design § The query, § Storage and state,
 * § Failure). One-shot and outside the session, shaped like the titler's
 * (adr ephemeral-title-queries): nothing it does is ever seen by the
 * session it narrates.
 */

import { eq } from 'drizzle-orm';
import type { OrbitalDb } from '../db/database.js';
import { narrations } from '../db/schema.js';
import { NARRATE_SYSTEM_PROMPT } from './digest.js';
import { parseNarration, type NarrationState } from './narration.js';
import type { NarrationFailure, NarrationIntent } from './types.js';

/** The model narrate asks when the `narrate_model` setting is empty. */
export const DEFAULT_NARRATE_MODEL = 'sonnet';

/**
 * One-shot model call — the titler's `TitleQueryFn` shape: a whole prompt
 * in, the SDK's messages out.
 */
export type NarrateQueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<any>;

/**
 * What an errored turn's text says when the API refused it rather than
 * failed. Read only off a turn that ended in an error: an answer that
 * happens to mention a usage policy is still an answer.
 */
const REFUSAL_TEXT = /refus|usage polic|unable to respond to this request/i;

/** How one run of the query ended, before the answer is read. */
type Outcome =
  | { kind: 'answered'; text: string }
  | { kind: 'refused' }
  | { kind: 'errored'; text: string };

export interface NarratorDeps {
  db: OrbitalDb;
  queryFn: NarrateQueryFn;
  /** The `narrate_model` setting, read per run: a changed setting counts from the next press. */
  model(): string;
  /** The `claude` to spawn; absent, the SDK's bundled one (mirrors the titler). */
  claudeExecutablePath?: string | null;
  /** The session's Claude directory environment, as the titler takes it (adr helper-queries-run-under-the-sessions-account). */
  envFor?: (sessionId: string) => Record<string, string> | undefined;
  /** A run finished, whatever its outcome: the row changed. */
  onFinish?(sessionId: string): void;
  /** A run failed with `error` — recorded, never thrown at anyone. */
  onError?(sessionId: string, err: unknown): void;
  now?: () => number;
}

/**
 * Runs narrate queries and keeps their rows. At most one run per session:
 * the row's `running` status is the lock, which is why `load` has to clear
 * the ones a stopped server left behind.
 */
export class Narrator {
  constructor(private deps: NarratorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** A `running` row at boot is a query that died with the previous server. */
  load(): void {
    this.deps.db.update(narrations)
      .set({ status: 'failed', failure: 'error', intents: null, finishedAt: this.now() })
      .where(eq(narrations.status, 'running'))
      .run();
  }

  state(sessionId: string): NarrationState | null {
    const row = this.deps.db.select().from(narrations).where(eq(narrations.sessionId, sessionId)).get();
    if (!row) return null;
    let intents: NarrationIntent[] | null = null;
    if (row.intents !== null) {
      try { intents = JSON.parse(row.intents) as NarrationIntent[]; } catch { intents = null; }
    }
    return { status: row.status, intents, failure: row.failure ?? null };
  }

  running(sessionId: string): boolean {
    return this.state(sessionId)?.status === 'running';
  }

  /**
   * Marks the session `running` now and runs the query in the background;
   * the promise settles when the row has its outcome and never rejects.
   * `stepIds` are the steps the digest lists — the answer is read against
   * them, so a step added while the query ran counts as one since the
   * narration rather than being filled in as if the model had seen it.
   */
  start(sessionId: string, digest: string, stepIds: string[]): Promise<void> {
    const model = this.deps.model() || DEFAULT_NARRATE_MODEL;
    // The previous run's intents stay on the row: the page keeps its grouping
    // until this run lands.
    this.deps.db.insert(narrations)
      .values({ sessionId, status: 'running', model, intents: null, failure: null, startedAt: this.now(), finishedAt: null })
      .onConflictDoUpdate({
        target: narrations.sessionId,
        set: { status: 'running', model, failure: null, startedAt: this.now(), finishedAt: null },
      })
      .run();
    return this.run(sessionId, model, digest, stepIds);
  }

  private async run(sessionId: string, model: string, digest: string, stepIds: string[]): Promise<void> {
    let intents: NarrationIntent[] | null = null;
    let failure: NarrationFailure | null = null;
    try {
      const outcome = await this.ask(model, digest, this.deps.envFor?.(sessionId));
      if (outcome.kind === 'refused') failure = 'refused';
      else if (outcome.kind === 'errored') {
        failure = 'error';
        this.deps.onError?.(sessionId, new Error(outcome.text || 'the narrate query ended in an error'));
      } else {
        intents = parseNarration(outcome.text, stepIds);
        if (!intents) failure = 'unparsable';
      }
    } catch (err) {
      failure = 'error';
      this.deps.onError?.(sessionId, err);
    }
    this.deps.db.update(narrations)
      .set(failure
        ? { status: 'failed', failure, intents: null, finishedAt: this.now() }
        : { status: 'done', failure: null, intents: JSON.stringify(intents), finishedAt: this.now() })
      .where(eq(narrations.sessionId, sessionId))
      .run();
    this.deps.onFinish?.(sessionId);
  }

  /**
   * A refusal can arrive three ways, and all three are read: the stop reason
   * `refusal` on an assistant message or on the result, the SDK's
   * `model_refusal_no_fallback` notice, or — from a CLI that says neither —
   * an errored turn whose text says the request was refused.
   */
  private async ask(model: string, digest: string, env: Record<string, string> | undefined): Promise<Outcome> {
    const parts: string[] = [];
    let refused = false;
    let ended = false;
    const options: Record<string, unknown> = {
      model,
      maxTurns: 1,
      allowedTools: [],
      // A reader of a record must not inherit the repo's instructions.
      settingSources: [],
      systemPrompt: NARRATE_SYSTEM_PROMPT,
      // No transcript, so no planet and nothing for the watcher to index
      // (adr ephemeral-title-queries).
      persistSession: false,
    };
    if (this.deps.claudeExecutablePath) options.pathToClaudeCodeExecutable = this.deps.claudeExecutablePath;
    if (env) options.env = env;
    for await (const message of this.deps.queryFn({ prompt: digest, options })) {
      if (message?.type === 'assistant') {
        if (message.message?.stop_reason === 'refusal') refused = true;
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
          }
        }
      } else if (message?.type === 'system' && message.subtype === 'model_refusal_no_fallback') {
        refused = true;
      } else if (message?.type === 'result') {
        if (refused || message.stop_reason === 'refusal') return { kind: 'refused' };
        if (message.is_error || message.subtype !== 'success') {
          const text = [
            typeof message.result === 'string' ? message.result : '',
            ...(Array.isArray(message.errors) ? message.errors : []),
            parts.join(''),
          ].join('\n').trim();
          return REFUSAL_TEXT.test(text) ? { kind: 'refused' } : { kind: 'errored', text };
        }
        ended = true;
        break;
      }
    }
    if (refused) return { kind: 'refused' };
    // A stream that stops before its result is a CLI that died mid-answer.
    if (!ended) return { kind: 'errored', text: 'the narrate query ended before its result' };
    return { kind: 'answered', text: parts.join('').trim() };
  }
}
